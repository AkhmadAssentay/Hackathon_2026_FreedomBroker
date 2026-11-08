"""Application logic shared by the API and the CLI."""
from __future__ import annotations

import json
import os
import threading

import httpx
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import budget, db
from .datasource import ROOT, facts, fetch_group, normalise, transcript_hash
from .judge import (LocalProvider, build_messages, criterion_hash, get_provider, majority_sample, needs_russian,
                    provider_from_spec, schema_for, translate_to_russian, validate, wording_hash)
from .scoring import allowed_answers, score

# ------------------------------------------------------------------ checklists


def ensure_seed() -> None:
    db.init()
    if not db.q1("SELECT version FROM checklists LIMIT 1"):
        cl = json.loads((ROOT / "config" / "checklist_v1.json").read_text())
        save_checklist(cl, note=cl.get("note", "v1"))


def check_checklist(cl: dict) -> list[str]:
    errs = []
    ids = [c.get("id") for c in cl.get("criteria", [])]
    if not ids:
        errs.append("нет критериев")
    if len(set(ids)) != len(ids):
        errs.append("id критериев должны быть уникальны")
    sec_ids = {s["id"] for s in cl.get("sections", [])}
    for c in cl.get("criteria", []):
        if not c.get("title") or not c.get("description"):
            errs.append(f"{c.get('id')}: нужны название и формулировка")
        if c.get("type") not in ("binary", "scale"):
            errs.append(f"{c.get('id')}: тип должен быть binary или scale")
        if c.get("type") == "scale" and not c.get("scale"):
            errs.append(f"{c.get('id')}: для шкалы задайте ступени")
        try:
            if float(c.get("weight", 0)) < 0:
                errs.append(f"{c.get('id')}: вес не может быть отрицательным")
        except (TypeError, ValueError):
            errs.append(f"{c.get('id')}: вес должен быть числом")
        if c.get("section") and sec_ids and c["section"] not in sec_ids:
            errs.append(f"{c.get('id')}: неизвестная секция {c['section']}")
    return errs


def save_checklist(cl: dict, note: str = "") -> int:
    errs = check_checklist(cl)
    if errs:
        raise ValueError("; ".join(errs))
    for c in cl["criteria"]:
        c.setdefault("guidelines", [])
        c.setdefault("scale", [])
        c.setdefault("na_condition", "")
        c["weight"] = float(c.get("weight", 0))
        if c["type"] == "scale":
            c["scale"] = sorted(c["scale"], key=lambda s: -float(s["value"]))
    return db.ex("INSERT INTO checklists(name, note, json, created_at) VALUES (?,?,?,?)",
                 (cl.get("name", "Чек-лист"), note or cl.get("note", ""), db.dumps(cl), db.now()))


def get_checklist(version: int | None = None) -> dict:
    row = (db.q1("SELECT * FROM checklists WHERE version=?", (version,)) if version
           else db.q1("SELECT * FROM checklists ORDER BY version DESC LIMIT 1"))
    if not row:
        raise KeyError("checklist not found")
    cl = json.loads(row["json"])
    cl["version"] = row["version"]
    cl["note"] = row["note"]
    cl["created_at"] = row["created_at"]
    return cl


def list_checklists() -> list[dict]:
    return db.q("SELECT version, name, note, created_at FROM checklists ORDER BY version DESC")


# ------------------------------------------------------------------ conversations


def ingest(group_id: str, records: list[dict] | None = None) -> dict:
    records = records if records is not None else fetch_group(group_id)
    n = 0
    for rec in records:
        conv = normalise(rec)
        key = f"{group_id}:{conv['conversation_id']}"
        db.ex("INSERT OR REPLACE INTO conversations(id,cid,group_id,channel,language,audio_url,conv_json,thash,fetched_at)"
              " VALUES (?,?,?,?,?,?,?,?,?)",
              (key, conv["conversation_id"], group_id, conv["channel"], conv["language"], conv["audio_url"],
               db.dumps(conv), transcript_hash(conv), db.now()))
        n += 1
    return {"group_id": group_id, "imported": n}


def get_conv(key: str) -> dict:
    row = db.q1("SELECT * FROM conversations WHERE id=?", (key,))
    if not row:
        raise KeyError(key)
    conv = json.loads(row["conv_json"])
    conv["key"] = key
    conv["group_id"] = row["group_id"]
    conv["thash"] = row["thash"]
    return conv


def groups() -> list[dict]:
    return db.q("SELECT group_id, COUNT(*) n, MAX(fetched_at) fetched_at FROM conversations GROUP BY group_id")


# ------------------------------------------------------------------ appeal memory


def precedents(cl: dict, limit: int = 3) -> dict[str, list[str]]:
    """Decided appeals become guidance for later evaluations of the same criterion."""
    out: dict[str, list[str]] = {}
    for c in cl["criteria"]:
        rows = db.q("SELECT a.*, e.conv_id FROM appeals a JOIN evaluations e ON e.id=a.evaluation_id "
                    "WHERE a.status='decided' AND a.criterion_id=? ORDER BY a.decided_at DESC LIMIT ?",
                    (c["id"], limit))
        out[c["id"]] = [
            f"{r['conv_id']}: {'оценка изменена на' if r['decision'] == 'change' else 'оценка подтверждена:'} "
            f"«{r['new_answer']}». Причина проверяющего: {r['reason']}" for r in rows if r.get("reason")]
    return out


# ------------------------------------------------------------------ evaluation


ROUTER_PATH = ROOT / "config" / "router.json"


def router_config() -> dict:
    try:
        return json.loads(ROUTER_PATH.read_text())
    except Exception:
        return {"default": "claude:claude-sonnet-5-5", "criteria": {}}


CALL_PROMPT = "call-v1"  # call rules + acoustic facts (eval/calls.py); part of the cache key for calls only


def _chash(c: dict, conv: dict) -> str:
    return criterion_hash(c, [CALL_PROMPT] if conv.get("channel") == "voice call" else [])


def assign_providers(cl: dict, provider_name: str | None, model: str | None, channel: str = "") -> tuple[dict, str]:
    """criterion id -> provider. 'router' sends each criterion to the source that was most accurate
    for it on the dev half of the reference set; a criterion whose wording changed (edited or
    replaced in the UI) goes to the router's default model."""
    name = provider_name or os.environ.get("DEFAULT_PROVIDER", "router")
    if name != "router":
        p = get_provider(name, model)
        return {c["id"]: p for c in cl["criteria"]}, p.model
    rc = router_config()
    cache: dict[str, object] = {}
    out = {}
    overrides = rc.get("channel_overrides", {}).get(channel, {})
    for c in cl["criteria"]:
        rule = overrides.get(c["id"]) or rc.get("criteria", {}).get(c["id"])
        spec = rule["source"] if rule and rule.get("wording_hash") == wording_hash(c) else rc.get("default", "claude:claude-sonnet-5-5")
        if spec not in cache:
            cache[spec] = provider_from_spec(spec)
        out[c["id"]] = cache[spec]
    return out, "router(" + ", ".join(sorted({p.model for p in out.values()})) + ")"


def evaluate(key: str, version: int | None = None, provider_name: str | None = None,
             model: str | None = None, use_memory: bool | None = None) -> int:
    # Appeal decisions as prompt precedents are opt-in: on the reference set they did not improve
    # held-out accuracy (eval/experiments.json -> _memory), so reviewers turn recurring decisions
    # into explicit checklist guidelines instead.
    if use_memory is None:
        use_memory = os.environ.get("APPEAL_MEMORY", "0") == "1"
    conv = get_conv(key)
    cl = get_checklist(version)
    assign, eval_model = assign_providers(cl, provider_name, model, conv.get("channel", ""))
    results: dict[str, dict] = {}
    groups: dict[int, tuple[object, list[dict]]] = {}
    for c in cl["criteria"]:
        prov = assign[c["id"]]
        h = _chash(c, conv)
        row = db.q1("SELECT result_json FROM criterion_cache WHERE conv_id=? AND thash=? AND chash=? AND model=?",
                    (key, conv["thash"], h, prov.model))
        if row:
            r = json.loads(row["result_json"])
            r["from_cache"] = True
            results[c["id"]] = r
        else:
            groups.setdefault(id(prov), (prov, []))[1].append(c)
    for prov, missing in groups.values():
        try:
            results.update(_evaluate_group(key, conv, cl, prov, missing, use_memory))
        except budget.BudgetExceeded:
            if getattr(prov, "name", "") != "claude":
                raise
            # Claude budget exhausted: the free local model takes over these criteria
            alt = provider_from_spec("local_sc5")
            res = _evaluate_group(key, conv, cl, alt, missing, use_memory)
            for r in res.values():
                r.setdefault("validator_notes", []).append("лимит бюджета Claude исчерпан — оценено локальной моделью")
            results.update(res)
        except (httpx.HTTPError, OSError) as e:
            if getattr(prov, "name", "") != "local":
                raise
            # GPU server / tunnel unavailable: the router's default (Claude) takes over
            alt = provider_from_spec(router_config().get("default", "claude:claude-sonnet-5-5"))
            res = _evaluate_group(key, conv, cl, alt, missing, use_memory)
            for r in res.values():
                r.setdefault("validator_notes", []).append(f"локальная модель недоступна ({type(e).__name__}) — оценено Claude")
            results.update(res)

    answers = {cid: r.get("answer") for cid, r in results.items()}
    sc = score(cl, answers)
    return db.ex("INSERT INTO evaluations(conv_id, checklist_version, model, result_json, score_json, created_at)"
                 " VALUES (?,?,?,?,?,?)",
                 (key, cl["version"], eval_model, db.dumps(results), db.dumps(sc), db.now()))


def _evaluate_group(key: str, conv: dict, cl: dict, prov, missing: list[dict], use_memory: bool) -> dict:
    fx = facts(conv)
    is_call = conv.get("channel") == "voice call"
    if is_call:  # measured from the recording when it has been aligned (hpc/whisper.sbatch)
        try:
            from .audio_align import acoustic_facts
            fx.update(acoustic_facts(conv))
        except Exception:
            pass
    prec = precedents(cl) if use_memory else {}
    results: dict[str, dict] = {}
    if missing:
        total_cost = 0.0
        system, user = build_messages(conv, fx, missing, prec, call_rules=is_call)
        out = prov.complete(system, user, schema_for(missing), key, "evaluate")
        total_cost += out["cost_usd"]
        fresh, errs_by, review_by = {}, {}, {}
        samples = out.get("samples") or [out["data"]]
        for c in missing:
            raw, share, votes = majority_sample(samples, c["id"], c) if len(samples) > 1 else (dict(out["data"].get(c["id"], {})), 1.0, {})
            r, errs = validate(c, raw, conv)
            if len(samples) > 1:
                r["vote_share"], r["votes"] = round(share, 2), votes
                if share < 0.6:  # weak majority: a human looks at it; no repair (it would replace the vote)
                    review_by[c["id"]] = [f"ответы модели расходятся: голоса {votes}"]
            fresh[c["id"]], errs_by[c["id"]] = r, errs
        failed = [c for c in missing if errs_by[c["id"]]]
        if failed:  # one repair round, only for the failed criteria
            note = "\n".join(f"- {c['id']}: " + "; ".join(errs_by[c["id"]]) for c in failed)
            system, user = build_messages(conv, fx, failed, prec, repair_note=note, call_rules=is_call)
            try:
                out2 = prov.complete(system, user, schema_for(failed), key, "repair")
                total_cost += out2["cost_usd"]
                for c in failed:
                    r, errs = validate(c, dict(out2["data"].get(c["id"], {})), conv)
                    if len(errs) <= len(errs_by[c["id"]]):
                        fresh[c["id"]], errs_by[c["id"]] = r, errs
                    fresh[c["id"]]["repaired"] = True
            except budget.BudgetExceeded:
                raise
            except Exception as e:  # keep the first answer, flagged
                for c in failed:
                    errs_by[c["id"]].append(f"repair failed: {e}")
        # language guard: explanations must be Russian whatever the dialogue language
        foreign = {cid: r for cid, r in fresh.items()
                   if needs_russian(r.get("explanation", "")) or needs_russian(r.get("na_reason", ""))}
        if foreign:
            try:
                tprov = LocalProvider() if getattr(prov, "n", 1) > 1 else prov
                tr, tr_cost = translate_to_russian(tprov, foreign, key)
                total_cost += tr_cost
                for cid, t in tr.items():
                    if t.get("explanation") and not needs_russian(t["explanation"]):
                        fresh[cid]["explanation"] = t["explanation"]
                        fresh[cid]["na_reason"] = t.get("na_reason") or fresh[cid].get("na_reason", "")
                        fresh[cid]["translated"] = True
            except budget.BudgetExceeded:
                raise
            except Exception as e:
                for cid in foreign:
                    fresh[cid].setdefault("validator_notes", []).append(f"перевод не удался: {e}")
        # cross-check: a gross-error signal found by code but rejected by the model goes to a human
        gross_ids = [c["id"] for c in missing if c.get("gross")]
        if fx.get("possible_gross_error_signals"):
            for cid in gross_ids:
                if fresh[cid].get("answer") != "yes":
                    errs_by[cid].append("код нашёл возможный признак грубой ошибки ("
                                        + "; ".join(fx["possible_gross_error_signals"]) + "), модель его не подтвердила")
        share = total_cost / max(1, len(missing))
        for c in missing:
            r = fresh[c["id"]]
            r["errors"] = errs_by[c["id"]] + review_by.get(c["id"], [])
            r["needs_review"] = bool(r["errors"]) or r.get("confidence") == "low"
            r["model"] = prov.model
            r["cost_usd"] = round(share, 6)
            r["criterion_hash"] = _chash(c, conv)
            db.ex("INSERT OR REPLACE INTO criterion_cache VALUES (?,?,?,?,?,?)",
                  (key, conv["thash"], r["criterion_hash"], prov.model, db.dumps(r), db.now()))
            r["from_cache"] = False
            results[c["id"]] = r
    return results


def evaluation_view(eval_id: int) -> dict[str, Any]:
    ev = db.q1("SELECT * FROM evaluations WHERE id=?", (eval_id,))
    if not ev:
        raise KeyError(eval_id)
    cl = get_checklist(ev["checklist_version"])
    results = json.loads(ev["result_json"])
    appeals = db.q("SELECT * FROM appeals WHERE evaluation_id=? ORDER BY id", (eval_id,))
    final_answers = {cid: r.get("answer") for cid, r in results.items()}
    for a in appeals:
        if a["status"] == "decided" and a["decision"] == "change" and a["new_answer"]:
            final_answers[a["criterion_id"]] = a["new_answer"]
    original = json.loads(ev["score_json"])
    final = score(cl, final_answers)
    return {
        "id": ev["id"], "conv_key": ev["conv_id"], "checklist_version": ev["checklist_version"],
        "model": ev["model"], "created_at": ev["created_at"], "checklist": cl,
        "results": results, "original_score": original, "final_score": final,
        "final_answers": final_answers, "appeals": appeals,
        "cost_usd": round(sum((r.get("cost_usd") or 0) for r in results.values() if not r.get("from_cache")), 6),
        "needs_review": [cid for cid, r in results.items() if r.get("needs_review")],
    }


def latest_evaluation_id(key: str, version: int | None = None) -> int | None:
    if version:
        r = db.q1("SELECT id FROM evaluations WHERE conv_id=? AND checklist_version=? ORDER BY id DESC LIMIT 1",
                  (key, version))
    else:
        r = db.q1("SELECT id FROM evaluations WHERE conv_id=? ORDER BY id DESC LIMIT 1", (key,))
    return r["id"] if r else None


def list_conversations(group_id: str | None = None, version: int | None = None) -> list[dict]:
    rows = db.q("SELECT id, cid, group_id, channel, language, audio_url IS NOT NULL AS has_audio FROM conversations"
                + (" WHERE group_id=?" if group_id else "") + " ORDER BY group_id, cid", (group_id,) if group_id else ())
    out = []
    for r in rows:
        eid = latest_evaluation_id(r["id"], version)
        item = dict(r)
        if eid:
            v = evaluation_view(eid)
            item.update({
                "evaluation_id": eid, "checklist_version": v["checklist_version"], "model": v["model"],
                "total": v["original_score"]["total"], "final_total": v["final_score"]["total"],
                "gross_error": v["final_score"]["gross_error"],
                "needs_review": len(v["needs_review"]),
                "appeals_open": sum(1 for a in v["appeals"] if a["status"] == "open"),
                "appeals_decided": sum(1 for a in v["appeals"] if a["status"] == "decided"),
            })
        out.append(item)
    return out


# ------------------------------------------------------------------ appeals


def create_appeal(eval_id: int, criterion_id: str, comment: str, author: str = "оператор") -> int:
    evaluation_view(eval_id)  # existence check
    if not comment.strip():
        raise ValueError("нужен комментарий")
    return db.ex("INSERT INTO appeals(evaluation_id, criterion_id, comment, author, created_at) VALUES (?,?,?,?,?)",
                 (eval_id, criterion_id, comment.strip(), author, db.now()))


def decide_appeal(appeal_id: int, decision: str, new_answer: str | None, reason: str,
                  reviewer: str = "проверяющий") -> dict:
    a = db.q1("SELECT * FROM appeals WHERE id=?", (appeal_id,))
    if not a:
        raise KeyError(appeal_id)
    if decision not in ("confirm", "change"):
        raise ValueError("decision: confirm | change")
    if not reason.strip():
        raise ValueError("укажите причину решения")
    v = evaluation_view(a["evaluation_id"])
    crit = next(c for c in v["checklist"]["criteria"] if c["id"] == a["criterion_id"])
    orig = v["results"][a["criterion_id"]]["answer"]
    if decision == "change":
        if new_answer not in allowed_answers(crit):
            raise ValueError(f"недопустимый ответ {new_answer}; допустимо: {allowed_answers(crit)}")
    else:
        new_answer = orig
    db.ex("UPDATE appeals SET status='decided', decision=?, new_answer=?, reason=?, reviewer=?, decided_at=? WHERE id=?",
          (decision, new_answer, reason.strip(), reviewer, db.now(), appeal_id))
    return evaluation_view(a["evaluation_id"])


def list_appeals(status: str | None = None) -> list[dict]:
    rows = db.q("SELECT a.*, e.conv_id FROM appeals a JOIN evaluations e ON e.id=a.evaluation_id"
                + (" WHERE a.status=?" if status else "") + " ORDER BY a.id DESC", (status,) if status else ())
    return rows


# ------------------------------------------------------------------ jobs

JOBS: dict[str, dict] = {}
_pool = ThreadPoolExecutor(max_workers=12)


def start_job(keys: list[str], version: int | None, provider: str | None, model: str | None = None,
              workers: int | None = None) -> str:
    jid = uuid.uuid4().hex[:8]
    cl = get_checklist(version)
    job = {"id": jid, "total": len(keys), "done": 0, "failed": 0, "errors": [], "status": "running",
           "checklist_version": cl["version"], "provider": provider, "eval_ids": {}}
    JOBS[jid] = job
    sem = threading.Semaphore(workers or (12 if provider in ("local", "local_sc5") else 6))

    def one(k: str):
        with sem:
            if job["status"] == "budget_stop":
                job["failed"] += 1
                return
            try:
                job["eval_ids"][k] = evaluate(k, cl["version"], provider, model)
                job["done"] += 1
            except budget.BudgetExceeded as e:
                job["status"] = "budget_stop"
                job["failed"] += 1
                job["errors"].append(str(e))
            except Exception as e:
                job["failed"] += 1
                job["errors"].append(f"{k}: {e}")
                traceback.print_exc()
            if job["done"] + job["failed"] >= job["total"] and job["status"] == "running":
                job["status"] = "finished"

    for k in keys:
        _pool.submit(one, k)
    if not keys:
        job["status"] = "finished"
    return jid


# ------------------------------------------------------------------ analytics


def analytics(group_id: str | None = None, version: int | None = None, model: str | None = None) -> dict:
    """Aggregates for the dashboard: distribution, criterion outcomes, language/channel, flags."""
    rows = list_conversations(group_id, version)
    evs = []
    for r in rows:
        if not r.get("evaluation_id"):
            continue
        v = evaluation_view(r["evaluation_id"])
        if model and v["model"] != model:
            continue
        evs.append((r, v))
    crit_meta, outcomes = {}, {}
    for _, v in evs:
        for c in v["checklist"]["criteria"]:
            crit_meta.setdefault(c["id"], {"id": c["id"], "title": c["title"], "type": c["type"], "gross": bool(c.get("gross")),
                                            "top": max([float(x["value"]) for x in c.get("scale", [])] or [1])})
            a = v["final_answers"].get(c["id"])
            o = outcomes.setdefault(c["id"], {"yes": 0, "partial": 0, "no": 0, "na": 0})
            if a == "na":
                o["na"] += 1
            elif c["type"] == "scale":
                f = float(a) / crit_meta[c["id"]]["top"] if a not in (None, "") else 0
                o["yes" if f >= 0.999 else "no" if f <= 0 else "partial"] += 1
            elif c.get("gross"):
                o["no" if a == "yes" else "yes"] += 1  # "yes" = violation -> counts as a failure
            else:
                o["yes" if a == "yes" else "no"] += 1
    def agg(key):
        g = {}
        for r, v in evs:
            t = v["final_score"]["total"]
            if t is None:
                continue
            g.setdefault(r[key], []).append(t)
        return {k: {"n": len(x), "mean": round(sum(x) / len(x), 2)} for k, x in sorted(g.items())}
    totals = [v["final_score"]["total"] for _, v in evs if v["final_score"]["total"] is not None]
    model_counts = {}
    for _, v in evs:
        model_counts[v["model"]] = model_counts.get(v["model"], 0) + 1
    worst = sorted(((v["final_score"]["total"], r["id"], r["cid"]) for r, v in evs
                    if v["final_score"]["total"] is not None))[:5]
    return {
        "n_dialogues": len(rows), "n_evaluated": len(evs),
        "mean_total": round(sum(totals) / len(totals), 2) if totals else None,
        "totals": totals,
        "gross": [r["cid"] for r, v in evs if v["final_score"]["gross_error"]],
        "needs_review": sum(len(v["needs_review"]) for _, v in evs),
        "appeals_open": sum(1 for _, v in evs for a in v["appeals"] if a["status"] == "open"),
        "appeals_decided": sum(1 for _, v in evs for a in v["appeals"] if a["status"] == "decided"),
        "criteria": [dict(crit_meta[k], **outcomes[k]) for k in crit_meta],
        "by_language": agg("language"), "by_channel": agg("channel"),
        "models": model_counts,
        "worst": [{"total": t, "key": k, "cid": c} for t, k, c in worst],
        # what evaluating the set costs, cached criteria included (each result keeps its own share)
        "cost_usd": round(sum((r.get("cost_usd") or 0) for _, v in evs for r in v["results"].values()), 4),
    }


# ------------------------------------------------------------------ summary and coaching


def insights(eval_id: int) -> dict:
    """One-line summary of the request + 2-3 coaching tips grounded in the failed criteria.
    Written by the free local model (Claude if the GPU server is unavailable); cached per evaluation."""
    row = db.q1("SELECT json FROM insights WHERE evaluation_id=?", (eval_id,))
    if row:
        return json.loads(row["json"])
    v = evaluation_view(eval_id)
    conv = get_conv(v["conv_key"])
    from .judge import render_transcript
    crits = {c["id"]: c for c in v["checklist"]["criteria"]}
    issues = []
    for cid, r in v["results"].items():
        a = v["final_answers"].get(cid)
        c = crits.get(cid)
        if not c or a in (None, "na"):
            continue
        bad = (a == "yes") if c.get("gross") else (a == "no" if c["type"] == "binary" else float(a) < max(float(x["value"]) for x in c["scale"]))
        if bad:
            issues.append(f"- {c['title']}: {r.get('explanation', '')}")
    schema = {"type": "object", "properties": {"summary": {"type": "string"},
              "coaching": {"type": "array", "items": {"type": "string"}}},
              "required": ["summary", "coaching"], "additionalProperties": False}
    user = ("Транскрипт:\n" + render_transcript(conv) + "\n\nЗамечания проверки:\n" + ("\n".join(issues) or "- замечаний нет")
            + "\n\nВерни JSON: summary — одно предложение по-русски: с чем обратился клиент и чем закончилось; "
              "coaching — 0–3 коротких конкретных совета оператору по-русски, только по замечаниям выше (пустой список, если замечаний нет).")
    system = "Ты наставник операторов поддержки брокера. Пиши кратко, по делу, без общих фраз."
    try:
        out = provider_from_spec("local").complete(system, user, schema, v["conv_key"], "insights")
    except (httpx.HTTPError, OSError):
        out = provider_from_spec("claude:claude-haiku-5-5").complete(system, user, schema, v["conv_key"], "insights")
    data = {"summary": out["data"].get("summary", ""), "coaching": out["data"].get("coaching", [])[:3]}
    if needs_russian(data["summary"]):
        data["summary"] = ""
    db.ex("INSERT OR REPLACE INTO insights VALUES (?,?,?)", (eval_id, db.dumps(data), db.now()))
    return data

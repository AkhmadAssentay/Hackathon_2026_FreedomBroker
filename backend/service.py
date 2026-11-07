"""Application logic shared by the API and the CLI."""
from __future__ import annotations

import json
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import budget, db
from .datasource import ROOT, facts, fetch_group, normalise, transcript_hash
from .judge import (build_messages, criterion_hash, get_provider, needs_russian, schema_for,
                    translate_to_russian, validate)
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


def evaluate(key: str, version: int | None = None, provider_name: str | None = None,
             model: str | None = None, use_memory: bool = True) -> int:
    conv = get_conv(key)
    cl = get_checklist(version)
    prov = get_provider(provider_name, model)
    fx = facts(conv)
    prec = precedents(cl) if use_memory else {}

    results: dict[str, dict] = {}
    missing = []
    for c in cl["criteria"]:
        h = criterion_hash(c, [])
        row = db.q1("SELECT result_json FROM criterion_cache WHERE conv_id=? AND thash=? AND chash=? AND model=?",
                    (key, conv["thash"], h, prov.model))
        if row:
            r = json.loads(row["result_json"])
            r["from_cache"] = True
            results[c["id"]] = r
        else:
            missing.append(c)

    if missing:
        total_cost = 0.0
        system, user = build_messages(conv, fx, missing, prec)
        out = prov.complete(system, user, schema_for(missing), key, "evaluate")
        total_cost += out["cost_usd"]
        fresh, errs_by = {}, {}
        for c in missing:
            r, errs = validate(c, dict(out["data"].get(c["id"], {})), conv)
            fresh[c["id"]], errs_by[c["id"]] = r, errs
        failed = [c for c in missing if errs_by[c["id"]]]
        if failed:  # one repair round, only for the failed criteria
            note = "\n".join(f"- {c['id']}: " + "; ".join(errs_by[c["id"]]) for c in failed)
            system, user = build_messages(conv, fx, failed, prec, repair_note=note)
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
                tr, tr_cost = translate_to_russian(prov, foreign, key)
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
        share = total_cost / max(1, len(missing))
        for c in missing:
            r = fresh[c["id"]]
            r["errors"] = errs_by[c["id"]]
            r["needs_review"] = bool(r["errors"]) or r.get("confidence") == "low"
            r["model"] = prov.model
            r["cost_usd"] = round(share, 6)
            r["criterion_hash"] = criterion_hash(c, [])
            db.ex("INSERT OR REPLACE INTO criterion_cache VALUES (?,?,?,?,?,?)",
                  (key, conv["thash"], r["criterion_hash"], prov.model, db.dumps(r), db.now()))
            r["from_cache"] = False
            results[c["id"]] = r

    answers = {cid: r.get("answer") for cid, r in results.items()}
    sc = score(cl, answers)
    return db.ex("INSERT INTO evaluations(conv_id, checklist_version, model, result_json, score_json, created_at)"
                 " VALUES (?,?,?,?,?,?)",
                 (key, cl["version"], prov.model, db.dumps(results), db.dumps(sc), db.now()))


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
    sem = threading.Semaphore(workers or (6 if (provider or "claude") == "claude" else 12))

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

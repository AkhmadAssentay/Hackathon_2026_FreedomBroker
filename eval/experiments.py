"""Experiment harness: compare judging strategies on the reference labels.

  python -m eval.experiments run qwen_sc5 [--ids dev|test|all]
  python -m eval.experiments report

Raw model outputs go to eval/runs/ (gitignored: they quote transcripts). The report
(eval/experiments.json, docs/experiments.md, frontend/experiments.json) holds only metrics.
Variants are selected on the `dev` half of the reference set and reported on `test`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from backend import budget, db, service  # noqa: E402
from backend.datasource import facts  # noqa: E402
from backend.judge import (ClaudeProvider, LocalProvider, build_messages, schema_for,  # noqa: E402
                           validate, wording_hash)
from backend.scoring import allowed_answers, score  # noqa: E402

RUNS = ROOT / "eval" / "runs"
GOLD = json.loads((ROOT / "eval" / "gold_labels.json").read_text())["labels"]
CRITS = [f"c{i}" for i in range(1, 9)]


def split_of(cid: str) -> str:
    """Deterministic, roughly stratified dev/test split."""
    return "dev" if int(hashlib.md5(cid.encode()).hexdigest(), 16) % 2 == 0 else "test"


def ids_for(which: str) -> list[str]:
    ids = sorted(GOLD)
    return ids if which == "all" else [i for i in ids if split_of(i) == which]


# ------------------------------------------------------------------ sub-questions for c2, c3, c7

SUBCHECKS = {
    "c2": ("needs", [
        {"id": "enough_from_start", "q": "Данных для ответа хватало с самого начала (из запроса клиента и переписки с ботом), уточнять было нечего?"},
        {"id": "asked_missing", "q": "Оператор задал уточняющий вопрос о действительно недостающих данных ДО ответа по существу?"},
        {"id": "reasked_known", "q": "Оператор переспросил то, что клиент уже сообщил ранее (в чате или боту)?"},
        {"id": "guessed", "q": "Данных не хватало, но оператор ответил наугад или проигнорировал часть запроса, ничего не уточнив?"},
    ]),
    "c3": ("identification", [
        {"id": "needed", "q": "Запрос требовал раскрытия данных счёта или защищённого действия (проверка платежа, позиции, ограничения, изменение или закрытие счёта)?"},
        {"id": "disclosed_before_verification", "q": "Оператор сообщил сведения о счёте клиента или выполнил защищённое действие ДО подтверждения личности?"},
        {"id": "verified", "q": "Личность клиента подтверждена в диалоге до раскрытия данных (системное сообщение или явная проверка оператором)?"},
    ]),
    "c7": ("closing", [
        {"id": "goodbye", "q": "В завершающих репликах оператора есть прощание (до свидания, всего доброго, сау болыңыз, goodbye, хорошего дня)?"},
        {"id": "summary", "q": "Оператор подвёл итог: назвал, что сделано или что будет дальше (не просто «пожалуйста» или «рад помочь»)?"},
        {"id": "offer_help", "q": "Оператор предложил дальнейшую помощь («если вопрос останется — напишите», «обращайтесь», «чем ещё помочь»)?"},
        {"id": "cutoff", "q": "Диалог оборвался (связь прервалась, клиент ушёл или завершил звонок) раньше, чем оператор мог завершить?"},
    ]),
}


def checklist(sub: set[str] | None = None) -> dict:
    cl = json.loads(json.dumps(service.get_checklist(1)))
    for c in cl["criteria"]:
        if sub and c["id"] in sub and c["id"] in SUBCHECKS:
            rule, qs = SUBCHECKS[c["id"]]
            c.update(subchecks=qs, rule=rule, locked_hash=wording_hash(c))
    return cl


# ------------------------------------------------------------------ variants

VARIANTS: dict[str, dict] = {
    "qwen":            {"provider": "local"},
    "qwen_percrit":    {"provider": "local", "per_criterion": True},
    "qwen_sc5":        {"provider": "local", "n": 5, "temperature": 0.7},
    "qwen_sub":        {"provider": "local", "sub": ["c2", "c3", "c7"]},
    "qwen_sub_sc5":    {"provider": "local", "sub": ["c2", "c3", "c7"], "n": 5, "temperature": 0.7},
    "qwen_gloss":      {"provider": "local", "gloss": True},
    "gemma":           {"provider": "gemma"},
    "gemma_sc5":       {"provider": "gemma", "n": 5, "temperature": 0.7},
    "haiku":           {"provider": "claude", "model": "claude-haiku-5-5"},
    "haiku_sub":       {"provider": "claude", "model": "claude-haiku-5-5", "sub": ["c2", "c3", "c7"]},
    "sonnet":          {"provider": "claude", "model": "claude-sonnet-5-5"},
    "sonnet_sub":      {"provider": "claude", "model": "claude-sonnet-5-5", "sub": ["c2", "c3", "c7"]},
    # appeals-as-memory: precedents from reviewer decisions on dev errors, evaluated on test only
    "qwen_sc5_mem":    {"provider": "local", "n": 5, "temperature": 0.7, "memory": True, "criteria": ["c4", "c5", "c6"], "partial": True},
    "sonnet_mem":      {"provider": "claude", "model": "claude-sonnet-5-5", "memory": True, "criteria": ["c1", "c2", "c3", "c7", "c8"], "partial": True},
    # how production calls Qwen: only its 3 routed criteria in the prompt; and with 9 votes
    "qwen_sc5_c456":   {"provider": "local", "n": 5, "temperature": 0.7, "criteria": ["c4", "c5", "c6"], "partial": True},
    "qwen_sc9_c456":   {"provider": "local", "n": 9, "temperature": 0.7, "criteria": ["c4", "c5", "c6"], "partial": True},
    "qwen_sc9":        {"provider": "local", "n": 9, "temperature": 0.7},
    # same dev errors, but reasons written as a QA reviewer would (eval/memory_reviewer.json)
    "qwen_sc5_memh":   {"provider": "local", "n": 5, "temperature": 0.7, "memory": "reviewer", "criteria": ["c4", "c5", "c6"], "partial": True},
    "sonnet_memh":     {"provider": "claude", "model": "claude-sonnet-5-5", "memory": "reviewer", "criteria": ["c1", "c2", "c3", "c7", "c8"], "partial": True},
}

MEMORY_PATH = RUNS / "memory.json"


def build_memory(max_per_crit: int = 3) -> dict:
    """Simulated appeal decisions: every router error on the dev half becomes a reviewer decision with
    a one-sentence reason (written by the local model from the transcript and the correct answer)."""
    if MEMORY_PATH.exists():
        return json.loads(MEMORY_PATH.read_text())
    choice = {"c1": "app:claude-sonnet-5-5", "c2": "app:claude-sonnet-5-5", "c3": "app:claude-sonnet-5-5",
              "c4": "qwen_sc5", "c5": "qwen_sc5", "c6": "qwen_sc5", "c7": "app:claude-sonnet-5-5",
              "c8": "app:claude-sonnet-5-5"}
    runs = {n: load(n) for n in set(choice.values())}
    crits = {c["id"]: c for c in service.get_checklist(1)["criteria"]}
    prov = LocalProvider()
    mem: dict[str, list[str]] = {k: [] for k in CRITS}
    for cid in ids_for("dev"):
        for k in CRITS:
            r = runs[choice[k]].get(cid)
            if not r or len(mem[k]) >= max_per_crit:
                continue
            pred, gold = r["results"][k]["answer"], GOLD[cid]["labels"][k]
            if pred == gold:
                continue
            conv = service.get_conv(f"DEV:{cid}")
            from backend.judge import render_transcript
            prompt = (f"Критерий: {crits[k]['title']}. {crits[k]['description']}\n"
                      f"Модель ответила «{pred}», проверяющий исправил на «{gold}».\n"
                      f"Транскрипт:\n{render_transcript(conv)}\n\n"
                      "Одним предложением на русском сформулируй причину решения проверяющего как общее правило "
                      "для похожих случаев (без имён и номеров реплик).")
            out = prov.complete("Ты старший специалист контроля качества.", prompt,
                                {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"],
                                 "additionalProperties": False}, f"DEV:{cid}", "memory")
            mem[k].append(f"Ответ модели «{pred}» исправлен на «{gold}»: {out['data']['reason']}")
    MEMORY_PATH.write_text(json.dumps(mem, ensure_ascii=False, indent=1))
    return mem


def provider_for(cfg: dict):
    if cfg["provider"] == "local":
        return LocalProvider(n=cfg.get("n", 1), temperature=cfg.get("temperature", 0.0))
    if cfg["provider"] == "gemma":
        return LocalProvider(base_url="http://127.0.0.1:8002/v1", n=cfg.get("n", 1),
                             temperature=cfg.get("temperature", 0.0))
    return ClaudeProvider(model=cfg["model"])


_gloss_lock = threading.Lock()


def gloss(conv: dict) -> dict:
    """KZ turns get a Russian gloss next to the original (quotes must stay original)."""
    if conv["language"] != "KZ":
        return conv
    path = RUNS / "gloss" / f"{conv['conversation_id']}.json"
    if path.exists():
        tr = json.loads(path.read_text())
    else:
        prov = LocalProvider()
        items = {f"t{t['i']}": t["text"] for t in conv["turns"] if t["speaker"] in ("client", "operator")}
        schema = {"type": "object", "properties": {k: {"type": "string"} for k in items},
                  "required": list(items), "additionalProperties": False}
        out = prov.complete("Переведи каждую реплику с казахского на русский. Названия разделов, тикеры и имена не меняй.",
                            json.dumps(items, ensure_ascii=False, indent=1), schema, conv["key"], "gloss")
        tr = out["data"]
        with _gloss_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(tr, ensure_ascii=False))
    conv = json.loads(json.dumps(conv))
    for t in conv["turns"]:
        g = tr.get(f"t{t['i']}")
        if g:
            t["text"] = f"{t['text']}  ⟨RU: {g}⟩"
    return conv


def majority(answers: list[str], crit: dict) -> tuple[str, float]:
    answers = [a for a in answers if a is not None]
    if not answers:
        return None, 0.0
    cnt = Counter(answers).most_common()
    top, k = cnt[0]
    if len(cnt) > 1 and cnt[1][1] == k and crit["type"] == "scale":  # tie on a scale -> median
        nums = sorted(float(a) for a in answers if a != "na")
        if nums:
            med = statistics.median_low(nums)
            top = str(int(med)) if float(med).is_integer() else str(med)
    return top, k / len(answers)


def judge_one(cid: str, cfg: dict) -> dict:
    conv = service.get_conv(f"DEV:{cid}")
    cl = checklist(set(cfg.get("sub", [])))
    if cfg.get("criteria"):
        cl["criteria"] = [c for c in cl["criteria"] if c["id"] in cfg["criteria"]]
    prec = (json.loads((ROOT / "eval" / "memory_reviewer.json").read_text()) if cfg.get("memory") == "reviewer"
            else build_memory() if cfg.get("memory") else {})
    crits = {c["id"]: c for c in cl["criteria"]}
    prov = provider_for(cfg)
    fx = facts(conv)
    shown = gloss(conv) if cfg.get("gloss") else conv
    groups = [[c] for c in cl["criteria"]] if cfg.get("per_criterion") else [cl["criteria"]]
    per: dict[str, list[dict]] = {k: [] for k in crits}
    cost = 0.0
    for group in groups:
        system, user = build_messages(shown, fx, group, prec)
        out = prov.complete(system, user, schema_for(group), conv["key"], "experiment")
        cost += out.get("cost_usd", 0.0)
        for sample in out.get("samples") or [out["data"]]:
            for c in group:
                r, errs = validate(c, dict(sample.get(c["id"], {})), conv)
                r["errors"] = errs
                per[c["id"]].append(r)
    res = {}
    for k, rs in per.items():
        ans, share = majority([r.get("answer") for r in rs], crits[k])
        res[k] = {"answer": ans, "vote_share": share, "votes": dict(Counter(r.get("answer") for r in rs)),
                  "confidence": rs[0].get("confidence") if rs else None,
                  "errors": sum(bool(r["errors"]) for r in rs)}
    return {"cid": cid, "results": res, "cost_usd": cost}


def run(name: str, which: str, workers: int | None = None) -> None:
    cfg = VARIANTS[name]
    path = RUNS / f"{name}.json"
    done = json.loads(path.read_text()) if path.exists() else {}
    todo = [i for i in ids_for(which) if i not in done]
    w = workers or (5 if cfg["provider"] == "claude" else 10)
    print(f"{name}: {len(todo)} to run ({len(done)} cached), {w} workers")
    lock = threading.Lock()

    def one(cid):
        try:
            r = judge_one(cid, cfg)
        except budget.BudgetExceeded as e:
            print("  BUDGET STOP", e)
            return
        except Exception as e:
            print("  ERR", cid, type(e).__name__, str(e)[:160])
            return
        with lock:
            done[cid] = r
            RUNS.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(done, ensure_ascii=False))

    with ThreadPoolExecutor(max_workers=w) as ex:
        list(ex.map(one, todo))
    print(f"{name}: {len(done)} done; Claude spend so far ${budget.spent():.4f}")


# ------------------------------------------------------------------ metrics and combinations

def load(name: str) -> dict:
    if name.startswith("app:"):  # results stored by the app pipeline (repair + language guard included)
        model = name[4:]
        out = {}
        for cid in GOLD:
            ev = db.q1("SELECT id FROM evaluations WHERE conv_id=? AND model=? AND checklist_version=1 "
                       "ORDER BY id DESC LIMIT 1", (f"DEV:{cid}", model))
            if ev:
                v = service.evaluation_view(ev["id"])
                out[cid] = {"cid": cid, "cost_usd": v["cost_usd"],
                            "results": {k: {"answer": r.get("answer"), "vote_share": 1.0,
                                            "confidence": r.get("confidence")} for k, r in v["results"].items()}}
        return out
    p = RUNS / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def combine_jury(names: list[str]) -> dict:
    runs = [load(n) for n in names]
    crits = {c["id"]: c for c in service.get_checklist(1)["criteria"]}
    out = {}
    for cid in set.intersection(*[set(r) for r in runs]):
        res = {}
        for k in CRITS:
            ans = [r[cid]["results"][k]["answer"] for r in runs]
            a, share = majority(ans, crits[k])
            if share < 0.5:  # no majority: trust the first (strongest) voter
                a = ans[0]
            res[k] = {"answer": a, "vote_share": share}
        out[cid] = {"cid": cid, "results": res, "cost_usd": sum(r[cid].get("cost_usd", 0) for r in runs)}
    return out


def combine_cascade(base: str, strong: str, threshold: float) -> dict:
    """Trust-or-escalate: keep the cheap answer when its self-consistency vote is strong enough,
    otherwise take the strong model's answer. Cost of the strong model is pro-rated by the share
    of escalated criteria (estimate)."""
    b, s = load(base), load(strong)
    out = {}
    for cid in set(b) & set(s):
        res, esc = {}, 0
        for k in CRITS:
            rb = b[cid]["results"][k]
            if rb.get("vote_share", 0) >= threshold and not rb.get("errors"):
                res[k] = {"answer": rb["answer"], "escalated": False}
            else:
                res[k] = {"answer": s[cid]["results"][k]["answer"], "escalated": True}
                esc += 1
        frac = esc / len(CRITS)
        est = s[cid].get("cost_usd", 0) * (0.55 + 0.45 * frac) if esc else 0.0
        out[cid] = {"cid": cid, "results": res, "cost_usd": est, "escalated": esc}
    return out


def metrics(run_: dict, which: str) -> dict:
    cl = service.get_checklist(1)
    crits = {c["id"]: c for c in cl["criteria"]}
    ids = [i for i in ids_for(which) if i in run_]
    if not ids:
        return {"n": 0}
    hit, tot = Counter(), Counter()
    lang_hit, lang_tot = Counter(), Counter()
    mae, gross = [], Counter()
    esc = 0
    for cid in ids:
        lang = "CALL" if cid.startswith("p4") else cid.split("-")[1].upper()
        pred = {k: run_[cid]["results"][k]["answer"] for k in CRITS}
        gold = GOLD[cid]["labels"]
        for k in CRITS:
            ok = pred[k] == gold[k]
            hit[k] += ok; tot[k] += 1; lang_hit[lang] += ok; lang_tot[lang] += 1
        gt, pt = score(cl, gold)["total"], score(cl, {k: (v if v in allowed_answers(crits[k]) else "no") for k, v in pred.items()})["total"]
        if gt is not None and pt is not None:
            mae.append(abs(gt - pt))
        gross["tp"] += gold["c8"] == "yes" and pred["c8"] == "yes"
        gross["fn"] += gold["c8"] == "yes" and pred["c8"] != "yes"
        gross["fp"] += gold["c8"] != "yes" and pred["c8"] == "yes"
        esc += run_[cid].get("escalated", 0)
    n_lab = sum(tot.values())
    return {
        "n": len(ids), "accuracy": round(sum(hit.values()) / n_lab, 4),
        "per_criterion": {k: round(hit[k] / tot[k], 3) for k in CRITS},
        "per_language": {k: round(lang_hit[k] / lang_tot[k], 3) for k in sorted(lang_tot)},
        "total_mae": round(sum(mae) / len(mae), 2) if mae else None,
        "gross": dict(gross),
        "usd_per_dialogue": round(sum(run_[c].get("cost_usd", 0) for c in ids) / len(ids), 5),
        "escalated_share": round(esc / n_lab, 3) if esc else 0.0,
    }


def combine_router(candidates: list[str]) -> dict:
    """Per-criterion routing: for each criterion use the candidate with the best accuracy on the
    `dev` half (ties -> cheaper/earlier candidate). Evaluated honestly on `test`."""
    runs = {n: load(n) for n in candidates}
    runs = {n: r for n, r in runs.items() if r}
    dev = ids_for("dev")
    choice = {}
    for k in CRITS:
        best, best_acc = None, -1
        for n, r in runs.items():
            ids = [i for i in dev if i in r]
            if not ids:
                continue
            acc = sum(r[i]["results"][k]["answer"] == GOLD[i]["labels"][k] for i in ids) / len(ids)
            if acc > best_acc + 1e-9:
                best, best_acc = n, acc
        choice[k] = best
    out = {}
    common = set.intersection(*[set(r) for r in runs.values()])
    for cid in common:
        res = {k: {"answer": runs[choice[k]][cid]["results"][k]["answer"], "from": choice[k]} for k in CRITS}
        used = set(choice.values())
        cost = 0.0
        for n in used:  # a paid model is called once per dialogue with only its criteria
            share = sum(1 for k in CRITS if choice[k] == n) / len(CRITS)
            c = runs[n][cid].get("cost_usd", 0)
            cost += c * (0.55 + 0.45 * share) if c else 0.0
        out[cid] = {"cid": cid, "results": res, "cost_usd": cost}
    ROUTER_CHOICES[" + ".join(candidates)] = choice
    return out


def combine_router_median(base_choice: dict, scale_voters: list[str], scale_crits=("c4", "c6")) -> dict:
    """Router, but scale criteria take the median of several models (strict Sonnet vs lenient local
    models tend to cancel out)."""
    srcs = set(base_choice.values()) | set(scale_voters)
    runs = {n: load(n) for n in srcs}
    out = {}
    for cid in set.intersection(*[set(r) for r in runs.values()]):
        res = {}
        for k in CRITS:
            if k in scale_crits:
                vals = [runs[n][cid]["results"][k]["answer"] for n in scale_voters]
                nums = sorted(float(v) for v in vals if v not in (None, "na"))
                if nums and len(nums) == len(vals):
                    m = nums[len(nums) // 2]
                    res[k] = {"answer": str(int(m)) if float(m).is_integer() else str(m)}
                    continue
            res[k] = {"answer": runs[base_choice[k]][cid]["results"][k]["answer"]}
        out[cid] = {"cid": cid, "results": res,
                    "cost_usd": runs["app:claude-sonnet-5-5"][cid].get("cost_usd", 0) if "app:claude-sonnet-5-5" in runs else 0}
    return out


PROD_CHOICE = {"c1": "app:claude-sonnet-5-5", "c2": "app:claude-sonnet-5-5", "c3": "app:claude-sonnet-5-5",
               "c4": "qwen_sc5", "c5": "qwen_sc5", "c6": "qwen_sc5", "c7": "app:claude-sonnet-5-5",
               "c8": "app:claude-sonnet-5-5"}

ROUTER_CHOICES: dict[str, dict] = {}

def combine_parts(parts: dict[str, list[str]]) -> dict:
    """Assemble full results from per-criterion partial runs: {run_name: [criteria]}."""
    runs = {n: load(n) for n in parts}
    out = {}
    for cid in set.intersection(*[set(r) for r in runs.values()]):
        res = {}
        for n, ks in parts.items():
            for k in ks:
                res[k] = runs[n][cid]["results"][k]
        out[cid] = {"cid": cid, "results": res, "cost_usd": sum(runs[n][cid].get("cost_usd", 0) for n in parts)}
    return out


COMBOS = {
    "router_prod_qwen3crit": lambda: combine_parts({"app:claude-sonnet-5-5": ["c1", "c2", "c3", "c7", "c8"], "qwen_sc5_c456": ["c4", "c5", "c6"]}),
    "router_qwen3crit_sc9": lambda: combine_parts({"app:claude-sonnet-5-5": ["c1", "c2", "c3", "c7", "c8"], "qwen_sc9_c456": ["c4", "c5", "c6"]}),
    "router_qwen8crit_sc9": lambda: combine_parts({"app:claude-sonnet-5-5": ["c1", "c2", "c3", "c7", "c8"], "qwen_sc9": ["c4", "c5", "c6"]}),
    "router_median_scales": lambda: combine_router_median(PROD_CHOICE, ["app:claude-sonnet-5-5", "qwen_sc5", "gemma"]),
    "router_median_scales_c456": lambda: combine_router_median(PROD_CHOICE, ["app:claude-sonnet-5-5", "qwen_sc5", "gemma"], ("c4", "c5", "c6")),
    "router_sonnet_qwensc5": lambda: combine_router(["app:claude-sonnet-5-5", "qwen_sc5"]),
    "router_sonnet_qwen": lambda: combine_router(["app:claude-sonnet-5-5", "app:local:Qwen3.5-35B-A3B-GPTQ-Int4"]),
    "router_sonnet_qwensc5_haiku": lambda: combine_router(["app:claude-sonnet-5-5", "qwen_sc5", "haiku"]),
    "router_all": lambda: combine_router(["app:claude-sonnet-5-5", "haiku", "haiku_sub", "qwen_sc5", "qwen_sub_sc5", "qwen", "gemma"]),
    "router_free_local": lambda: combine_router(["qwen_sc5", "qwen_sub_sc5", "qwen", "qwen_percrit", "qwen_gloss", "gemma", "gemma_sc5"]),
    "router_cheap": lambda: combine_router(["haiku", "haiku_sub", "qwen_sc5", "qwen_sub_sc5", "gemma"]),
    "jury_qwen_gemma_haiku": lambda: combine_jury(["haiku", "qwen", "gemma"]),
    "jury_sonnet_qwen_haiku": lambda: combine_jury(["app:claude-sonnet-5-5", "qwen_sc5", "haiku"]),
    "jury_sonnet_haiku_sub_qwen_sub": lambda: combine_jury(["app:claude-sonnet-5-5", "haiku_sub", "qwen_sub_sc5"]),
    **{f"cascade_qwen_sc5_to_sonnet@{t}": (lambda t=t: combine_cascade("qwen_sc5", "app:claude-sonnet-5-5", t))
       for t in (0.6, 0.8, 1.0)},
    **{f"cascade_qwen_sub_sc5_to_sonnet@{t}": (lambda t=t: combine_cascade("qwen_sub_sc5", "app:claude-sonnet-5-5", t))
       for t in (0.6, 0.8, 1.0)},
}


SPEC = {"app:claude-sonnet-5-5": "claude:claude-sonnet-5-5", "qwen_sc5": "local_sc5", "qwen": "local",
        "app:local:Qwen3.5-35B-A3B-GPTQ-Int4": "local", "haiku": "claude:claude-haiku-5-5", "gemma": "gemma"}
CONF = {"high": 1.0, "medium": 0.7, "low": 0.4}


def risk_coverage(choice: dict, which: str = "all") -> list[dict]:
    """Selective review: sort criterion decisions by confidence (vote share for self-consistency,
    self-reported confidence otherwise); a reviewer checks the least confident X%. Accuracy of the
    rest = what the system gets right on its own."""
    runs = {n: load(n) for n in set(choice.values())}
    items = []
    for cid in ids_for(which):
        if not all(cid in r for r in runs.values()):
            continue
        for k in CRITS:
            r = runs[choice[k]][cid]["results"][k]
            conf = r.get("vote_share") if r.get("vote_share", 1.0) < 1.0 or choice[k].endswith("sc5") else CONF.get(r.get("confidence"), 0.85)
            items.append((conf if conf is not None else 0.85, r["answer"] == GOLD[cid]["labels"][k]))
    items.sort(key=lambda t: t[0])
    out = []
    for pct in (0, 5, 10, 15, 20, 30, 40, 50):
        cut = int(len(items) * pct / 100)
        rest = items[cut:]
        out.append({"review_pct": pct, "auto_accuracy": round(sum(ok for _, ok in rest) / max(1, len(rest)), 4),
                    "errors_caught": sum(1 for _, ok in items[:cut] if not ok),
                    "errors_total": sum(1 for _, ok in items if not ok)})
    return out


def promote(combo: str) -> None:
    """Write the per-criterion choice of a router combo (picked on dev) into config/router.json."""
    COMBOS[combo]()
    choice = ROUTER_CHOICES[next(k for k in ROUTER_CHOICES)]
    cl = service.get_checklist(1)
    crits = {c["id"]: c for c in cl["criteria"]}
    rc = {"default": "claude:claude-sonnet-5-5", "chosen_from": combo, "chosen_on": "dev half of eval/gold_labels.json",
          "criteria": {k: {"source": SPEC[v], "wording_hash": wording_hash(crits[k]), "title": crits[k]["title"]}
                       for k, v in choice.items()}}
    (ROOT / "config" / "router.json").write_text(json.dumps(rc, ensure_ascii=False, indent=1))
    print(json.dumps(rc, ensure_ascii=False, indent=1))


def report() -> dict:
    rows = {}
    names = [v for v in VARIANTS if not VARIANTS[v].get("partial")] + ["app:local:Qwen3.5-35B-A3B-GPTQ-Int4", "app:claude-sonnet-5-5"]
    for n in names:
        r = load(n)
        if r and len(r) >= len(GOLD):  # only complete runs are compared
            rows[n] = {s: metrics(r, s) for s in ("dev", "test", "all")}
    for n, f in COMBOS.items():
        try:
            r = f()
        except Exception:
            continue
        if r and len(r) >= len(GOLD):
            rows[n] = {s: metrics(r, s) for s in ("dev", "test", "all")}
    sm, qm = load("sonnet_mem"), load("qwen_sc5_mem")
    if sm and qm:  # appeals-as-memory: router with precedents vs without, on the test half only
        base = combine_router(["app:claude-sonnet-5-5", "qwen_sc5"])
        both = sorted(set(sm) & set(qm) & set(base) & set(ids_for("test")))
        merged = {cid: {"cid": cid, "cost_usd": sm[cid].get("cost_usd", 0),
                        "results": {**sm[cid]["results"], **qm[cid]["results"]}} for cid in both}
        rows["_memory"] = {"n_test_dialogues": len(both),
                           "without_memory": metrics({c: base[c] for c in both}, "test"),
                           "with_memory": metrics(merged, "test")}
        sh, qh = load("sonnet_memh"), load("qwen_sc5_memh")
        if sh and qh:
            bh = sorted(set(sh) & set(qh) & set(both))
            mh = {cid: {"cid": cid, "cost_usd": sh[cid].get("cost_usd", 0),
                        "results": {**sh[cid]["results"], **qh[cid]["results"]}} for cid in bh}
            rows["_memory"]["with_reviewer_memory"] = metrics(mh, "test")
    rows["_router_choices"] = ROUTER_CHOICES
    prod = ROUTER_CHOICES.get(" + ".join(["app:claude-sonnet-5-5", "qwen_sc5"])) or next(iter(ROUTER_CHOICES.values()), None)
    if prod:
        rows["_risk_coverage"] = risk_coverage(prod)
    (ROOT / "eval" / "experiments.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    lines = ["# Experiments: judging strategies vs reference labels\n",
             "Selection on `dev`, reported on `test` (deterministic split of 44 reference dialogues). "
             "Accuracy = exact match of the answer over 8 criteria.\n",
             "| variant | dev acc | test acc | all acc | KZ | RU | EN | CALL | total MAE | gross tp/fn/fp | $ / dialogue |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for n, m in sorted(((k, v) for k, v in rows.items() if not k.startswith("_")), key=lambda kv: -kv[1]["test"].get("accuracy", 0)):
        a = m["all"]
        pl = a.get("per_language", {})
        g = a.get("gross", {})
        lines.append(f"| {n} | {m['dev'].get('accuracy', '—')} | {m['test'].get('accuracy', '—')} | {a.get('accuracy')} | "
                     f"{pl.get('KZ', '—')} | {pl.get('RU', '—')} | {pl.get('EN', '—')} | {pl.get('CALL', '—')} | "
                     f"{a.get('total_mae')} | {g.get('tp', 0)}/{g.get('fn', 0)}/{g.get('fp', 0)} | {a.get('usd_per_dialogue')} |")
    (ROOT / "docs").mkdir(exist_ok=True)
    lines += ["", "Router choices (criterion -> source, picked on dev):"] + [f"- {k}: {v}" for k, v in ROUTER_CHOICES.items()]
    (ROOT / "docs" / "experiments.md").write_text("\n".join(lines) + "\n")
    (ROOT / "frontend" / "experiments.json").write_text(json.dumps(rows, ensure_ascii=False))
    print("\n".join(lines))
    return rows


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("variant"); r.add_argument("--ids", default="all")
    r.add_argument("--workers", type=int)
    sub.add_parser("report")
    pr = sub.add_parser("promote"); pr.add_argument("combo")
    a = p.parse_args()
    service.ensure_seed()
    if a.cmd == "run":
        run(a.variant, a.ids, a.workers)
    elif a.cmd == "promote":
        promote(a.combo)
    else:
        report()


if __name__ == "__main__":
    main()

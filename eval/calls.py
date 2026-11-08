"""Call experiments: what fixes the voice-call weak spot (5 real calls, 40 reference labels).

  python -m eval.calls run <variant>      # see VARIANTS
  python -m eval.calls report

Approaches from the literature, adapted:
- call-aware prompt: call structure + rules from the checklist (who greets after the agent joins,
  hang-up -> closing N/A, silences) and measured acoustic facts (AudioJudge: audio LLMs are near chance on
  paralinguistics, so we measure instead of asking an audio model);
- two ASR hypotheses per turn (organizers' ASR + Whisper large-v3-turbo) - the N-best idea of generative
  error correction (HyPoradise / GenSEC);
- constrained generative error correction (ClozeGER-style): the local model may only fix words where the
  two hypotheses disagree, keeps masks, adds no names or digits.
Privacy: Whisper hears what the organizers masked, so Whisper text and corrected text are used ONLY with
the local GPU model, never sent to Claude.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from backend import service  # noqa: E402
from backend.audio_align import acoustic_facts, whisper_turn_texts  # noqa: E402
from backend.datasource import facts  # noqa: E402
from backend.judge import ClaudeProvider, LocalProvider, build_messages, majority_sample, schema_for, validate  # noqa: E402
from backend.scoring import score  # noqa: E402

RUNS = ROOT / "eval" / "runs" / "calls"
GOLD = json.loads((ROOT / "eval" / "gold_calls.json").read_text())["labels"]
CALLS = sorted(GOLD)
CRITS = [f"c{i}" for i in range(1, 9)]
CALL_KEYS = ("operator_joined_turn", "first_operator_turn_after_join", "ivr_and_bot_turns_before_join",
             "operator_turns_after_client_hung_up", "client_last_words_before_hang_up")

VARIANTS = {
    "base_sonnet":         {"model": "sonnet"},
    "rules_sonnet":        {"model": "sonnet", "rules": True},
    "base_qwen5":          {"model": "qwen5"},
    "rules_qwen5":         {"model": "qwen5", "rules": True},
    "whisper_qwen5":       {"model": "qwen5", "alt": "whisper"},
    "rules_whisper_qwen5": {"model": "qwen5", "rules": True, "alt": "whisper"},
    "ger_qwen5":           {"model": "qwen5", "alt": "ger"},
    "rules_ger_qwen5":     {"model": "qwen5", "rules": True, "alt": "ger"},
}

_lock = threading.Lock()


def ger(conv: dict, whisper: dict[int, str]) -> dict[int, str]:
    """Constrained generative error correction with the local model (cached)."""
    path = RUNS / "ger" / f"{conv['conversation_id']}.json"
    if path.exists():
        return {int(k): v for k, v in json.loads(path.read_text()).items()}
    items = {f"t{t['i']}": {"asr": t["text"], "whisper": whisper[t["i"]]}
             for t in conv["turns"] if t["i"] in whisper and t["speaker"] in ("client", "operator")}
    if not items:
        return {}
    schema = {"type": "object", "properties": {k: {"type": "string"} for k in items},
              "required": list(items), "additionalProperties": False}
    system = ("Ты исправляешь ошибки распознавания речи в телефонном разговоре брокера с клиентом. Для каждой реплики "
              "даны две гипотезы распознавания одного и того же звука: asr и whisper. Верни исправленный текст реплики. "
              "Правила: исправляй только слова, где гипотезы расходятся и одна явно ошибочна по смыслу; если не уверен — "
              "оставь asr как есть; маски вида [Имя скрыто], [Данные идентификации скрыты], [Персональные данные скрыты] "
              "сохраняй дословно; не добавляй имён, фамилий, номеров и цифр, которых нет в asr; не перефразируй.")
    out = LocalProvider().complete(system, json.dumps(items, ensure_ascii=False, indent=1), schema,
                                   conv.get("key", ""), "ger")
    fixed = {int(k[1:]): v for k, v in out["data"].items() if isinstance(v, str)}
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(fixed, ensure_ascii=False))
    return fixed


def judge_call(cid: str, cfg: dict) -> dict:
    conv = service.get_conv(f"DEV:{cid}")
    cl = service.get_checklist(1)
    fx = facts(conv)
    if cfg.get("rules"):
        fx.update(acoustic_facts(conv))
    else:
        fx = {k: v for k, v in fx.items() if k not in CALL_KEYS}
    alt, label = None, "Whisper"
    if cfg.get("alt"):
        w = whisper_turn_texts(conv)
        if cfg["alt"] == "whisper":
            alt = w
        else:
            fixed = ger(conv, w)
            alt = {i: t for i, t in fixed.items() if t.strip() and t.strip() != conv["turns"][i]["text"].strip()}
            label = "исправлено"
    system, user = build_messages(conv, fx, cl["criteria"], {}, call_rules=bool(cfg.get("rules")), alt=alt, alt_label=label)
    if cfg["model"] == "sonnet":
        assert not cfg.get("alt"), "never send Whisper/corrected text (unmasked audio) to an external API"
        prov = ClaudeProvider(model="claude-sonnet-5-5")
    else:
        prov = LocalProvider(n=5, temperature=0.7)
    out = prov.complete(system, user, schema_for(cl["criteria"]), conv["key"], "calls-experiment")
    samples = out.get("samples") or [out["data"]]
    res = {}
    for c in cl["criteria"]:
        raw, share, votes = majority_sample(samples, c["id"], c) if len(samples) > 1 else (dict(samples[0].get(c["id"], {})), 1.0, {})
        r, errs = validate(c, raw, conv)
        res[c["id"]] = {"answer": r.get("answer"), "vote_share": share, "errors": len(errs),
                        "explanation": (r.get("explanation") or "")[:200]}
    return {"cid": cid, "results": res, "cost_usd": out.get("cost_usd", 0.0), "alt_turns": len(alt or {})}


def run(name: str):
    cfg = VARIANTS[name]
    path = RUNS / f"{name}.json"
    done = json.loads(path.read_text()) if path.exists() else {}
    todo = [c for c in CALLS if c not in done]

    def one(cid):
        try:
            r = judge_call(cid, cfg)
        except Exception as e:
            print("ERR", cid, type(e).__name__, str(e)[:200])
            return
        with _lock:
            done[cid] = r
            RUNS.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(done, ensure_ascii=False))
    with ThreadPoolExecutor(5) as ex:
        list(ex.map(one, todo))
    print(f"{name}: {len(done)}/{len(CALLS)} calls")


def load(name: str) -> dict:
    p = RUNS / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def app_router() -> dict:
    out = {}
    for cid in CALLS:
        v = service.evaluation_view(service.latest_evaluation_id(f"DEV:{cid}"))
        out[cid] = {"cid": cid, "results": {k: {"answer": r.get("answer")} for k, r in v["results"].items()}}
    return out


def router(sonnet: dict, qwen: dict) -> dict:
    out = {}
    for cid in set(sonnet) & set(qwen):
        out[cid] = {"cid": cid, "results": {k: (qwen if k in ("c4", "c5", "c6") else sonnet)[cid]["results"][k] for k in CRITS}}
    return out


def metrics(run: dict) -> dict:
    cl = service.get_checklist(1)
    ids = [c for c in CALLS if c in run]
    if not ids:
        return {}
    per_call = {c: [int(run[c]["results"][k]["answer"] == GOLD[c][k]) for k in CRITS] for c in ids}
    acc = sum(map(sum, per_call.values())) / (len(ids) * 8)
    rng = random.Random(3)
    boots = sorted(sum(sum(per_call[rng.choice(ids)]) for _ in ids) / (len(ids) * 8) for _ in range(3000))
    per_crit = {k: sum(run[c]["results"][k]["answer"] == GOLD[c][k] for c in ids) for k in CRITS}
    mae = []
    for c in ids:
        g = score(cl, GOLD[c])["total"]
        p = score(cl, {k: run[c]["results"][k]["answer"] for k in CRITS})["total"]
        if g is not None and p is not None:
            mae.append(abs(g - p))
    return {"n_calls": len(ids), "accuracy": round(acc, 3), "ci95": [round(boots[75], 3), round(boots[2924], 3)],
            "correct": f"{sum(map(sum, per_call.values()))}/{len(ids) * 8}", "per_criterion": per_crit,
            "total_mae": round(sum(mae) / len(mae), 1) if mae else None,
            "cost_usd": round(sum(run[c].get("cost_usd", 0) for c in ids), 4)}


def loo_router(candidates: dict[str, dict]) -> dict:
    """Leave-one-call-out: for each held-out call pick, per criterion, the candidate that was best on the other 4."""
    out = {}
    for held in CALLS:
        others = [c for c in CALLS if c != held]
        res = {}
        for k in CRITS:
            best = max(candidates, key=lambda n: (sum(candidates[n][c]["results"][k]["answer"] == GOLD[c][k] for c in others if c in candidates[n]), n == "rules_sonnet"))
            res[k] = candidates[best][held]["results"][k]
        out[held] = {"cid": held, "results": res}
    return out


def report():
    rows = {"production (latest run)": metrics(app_router())}
    runs = {n: load(n) for n in VARIANTS}
    for n, r in runs.items():
        if len(r) == len(CALLS):
            rows[n] = metrics(r)
    combos = {
        "router base (sonnet + qwen5)": ("base_sonnet", "base_qwen5"),
        "router + call rules": ("rules_sonnet", "rules_qwen5"),
        "router + call rules + Whisper (Qwen part)": ("rules_sonnet", "rules_whisper_qwen5"),
        "router + call rules + GER (Qwen part)": ("rules_sonnet", "rules_ger_qwen5"),
    }
    for name, (s, q) in combos.items():
        if len(runs.get(s, {})) == len(CALLS) and len(runs.get(q, {})) == len(CALLS):
            rows[name] = metrics(router(runs[s], runs[q]))
    if len(runs.get("rules_sonnet", {})) == len(CALLS) and len(runs.get("rules_qwen5", {})) == len(CALLS):
        # channel-aware routing for consultation: chosen per held-out call on the other 4 calls only
        s_, q_ = runs["rules_sonnet"], runs["rules_qwen5"]
        out, picks = {}, []
        for held in CALLS:
            others = [c for c in CALLS if c != held]
            sc = sum(s_[c]["results"]["c4"]["answer"] == GOLD[c]["c4"] for c in others)
            qc = sum(q_[c]["results"]["c4"]["answer"] == GOLD[c]["c4"] for c in others)
            src4 = s_ if sc >= qc else q_
            picks.append("sonnet" if sc >= qc else "qwen")
            out[held] = {"cid": held, "results": {k: (src4 if k == "c4" else (q_ if k in ("c5", "c6") else s_))[held]["results"][k] for k in CRITS}}
        rows["router + call rules + consultation by LOO (" + "/".join(sorted(set(picks))) + ")"] = metrics(out)
    full = {n: r for n, r in runs.items() if len(r) == len(CALLS)}
    if len(full) >= 2:
        rows["leave-one-call-out router over all variants"] = metrics(loo_router(full))
    (ROOT / "eval" / "calls_results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    (ROOT / "frontend" / "calls_results.json").write_text(json.dumps(rows, ensure_ascii=False))
    lines = ["# Voice calls: experiments (5 real calls × 8 criteria = 40 labels)\n",
             "| variant | correct | accuracy (95% CI by call) | total MAE | c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | $ |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for n, m in rows.items():
        if not m:
            continue
        pc = m["per_criterion"]
        lines.append(f"| {n} | {m['correct']} | {m['accuracy']:.1%} ({m['ci95'][0]:.0%}–{m['ci95'][1]:.0%}) | {m['total_mae']} | "
                     + " | ".join(f"{pc[k]}/5" for k in CRITS) + f" | {m['cost_usd']} |")
    (ROOT / "docs" / "calls_table.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("variant")
    sub.add_parser("report")
    a = p.parse_args()
    run(a.variant) if a.cmd == "run" else report()


if __name__ == "__main__":
    main()

"""Agreement of the judge with the reference labels (eval/gold_labels.json).

  python -m eval.metrics --model claude-sonnet-5-5 [--model local:Qwen3.5-35B-A3B-GPTQ-Int4 ...]

Writes eval/metrics_<model>.json, docs/metrics.md and frontend/metrics.json (shown in the UI).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from backend import db, service  # noqa: E402
from backend.scoring import score  # noqa: E402


def kappa(pairs: list[tuple[str, str]]) -> float | None:
    n = len(pairs)
    if not n:
        return None
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return None if pe >= 1 else round((po - pe) / (1 - pe), 3)


def evaluate_model(model: str, gold: dict, version: int) -> dict:
    cl = service.get_checklist(version)
    crits = {c["id"]: c for c in cl["criteria"]}
    rows = []
    for cid, g in gold.items():
        ev = db.q1("SELECT id FROM evaluations WHERE conv_id=? AND model=? AND checklist_version=? ORDER BY id DESC LIMIT 1",
                   (f"DEV:{cid}", model, version))
        if ev:
            rows.append((cid, g["labels"], service.evaluation_view(ev["id"])))
    if not rows:
        return {"model": model, "n_dialogues": 0}

    per_crit = defaultdict(list)
    per_lang = defaultdict(list)
    na_tp = na_fp = na_fn = 0
    false_pass = false_fail = 0
    binary_n = 0
    gross_tp = gross_fp = gross_fn = 0
    mae, first_pass_valid, n_results, needs_review = [], 0, 0, 0
    for cid, labels, v in rows:
        lang = cid.split("-")[1].upper()
        pred = {k: r["answer"] for k, r in v["results"].items()}
        for k, gl in labels.items():
            p = pred.get(k)
            per_crit[k].append((gl, p))
            per_lang[lang].append(gl == p)
            if crits[k].get("na_allowed"):
                na_tp += gl == "na" and p == "na"
                na_fp += gl != "na" and p == "na"
                na_fn += gl == "na" and p != "na"
            if crits[k].get("gross"):
                gross_tp += gl == "yes" and p == "yes"
                gross_fp += gl != "yes" and p == "yes"
                gross_fn += gl == "yes" and p != "yes"
            elif crits[k]["type"] == "binary" and gl in ("yes", "no") and p in ("yes", "no"):
                binary_n += 1
                false_pass += gl == "no" and p == "yes"
                false_fail += gl == "yes" and p == "no"
        g_total = score(cl, labels)["total"]
        p_total = v["original_score"]["total"]
        if g_total is not None and p_total is not None:
            mae.append(abs(g_total - p_total))
        for r in v["results"].values():
            n_results += 1
            first_pass_valid += not r.get("repaired") and not r.get("errors")
            needs_review += bool(r.get("needs_review"))

    crit_rows = []
    for k, pairs in sorted(per_crit.items()):
        acc = sum(a == b for a, b in pairs) / len(pairs)
        crit_rows.append({"id": k, "title": crits[k]["title"], "n": len(pairs), "accuracy": round(acc, 3),
                          "kappa": kappa(pairs),
                          "confusions": dict(Counter(f"{a}→{b}" for a, b in pairs if a != b).most_common(4))})
    all_pairs = [p for ps in per_crit.values() for p in ps]
    cost = db.q1("SELECT SUM(cost_usd) c, COUNT(DISTINCT conv_id) n, SUM(input_tokens) i, SUM(output_tokens) o, COUNT(*) calls"
                 " FROM api_calls WHERE model=?", (model,))
    return {
        "model": model, "checklist_version": version, "n_dialogues": len(rows), "n_labels": len(all_pairs),
        "overall_accuracy": round(sum(a == b for a, b in all_pairs) / len(all_pairs), 3),
        "per_language_accuracy": {k: round(sum(v) / len(v), 3) for k, v in sorted(per_lang.items())},
        "per_criterion": crit_rows,
        "na": {"precision": round(na_tp / (na_tp + na_fp), 3) if na_tp + na_fp else None,
               "recall": round(na_tp / (na_tp + na_fn), 3) if na_tp + na_fn else None},
        "gross_error": {"tp": gross_tp, "fp": gross_fp, "fn": gross_fn},
        "binary_error_direction": {"n": binary_n, "false_pass": false_pass, "false_fail": false_fail},
        "total_score_mae": round(sum(mae) / len(mae), 2) if mae else None,
        "evidence_valid_first_pass": round(first_pass_valid / n_results, 3) if n_results else None,
        "needs_review_share": round(needs_review / n_results, 3) if n_results else None,
        "cost": {"usd_total": round(cost["c"] or 0, 4), "dialogues": cost["n"], "calls": cost["calls"],
                 "usd_per_dialogue": round((cost["c"] or 0) / cost["n"], 4) if cost["n"] else None,
                 "input_tokens": cost["i"], "output_tokens": cost["o"]},
    }


def to_markdown(results: list[dict]) -> str:
    out = ["# Agreement with reference labels\n",
           "Reference: `eval/gold_labels.json` (33 DEV chats × 8 criteria). Accuracy = exact match of the answer "
           "(yes/no/N/A/scale step).\n"]
    for m in results:
        if not m.get("n_dialogues"):
            continue
        out.append(f"## {m['model']}\n")
        out.append(f"- dialogues: {m['n_dialogues']}, labels: {m['n_labels']}, **overall accuracy {m['overall_accuracy']:.1%}**")
        out.append("- by language: " + ", ".join(f"{k} {v:.1%}" for k, v in m["per_language_accuracy"].items()))
        out.append(f"- total score mean abs. error: {m['total_score_mae']} points")
        out.append(f"- N/A precision {m['na']['precision']}, recall {m['na']['recall']}")
        g = m["gross_error"]
        out.append(f"- gross errors: found {g['tp']}, missed {g['fn']}, false alarms {g['fp']}")
        d = m["binary_error_direction"]
        out.append(f"- binary errors: false pass {d['false_pass']}, false fail {d['false_fail']} (of {d['n']})")
        out.append(f"- evidence valid on first pass: {m['evidence_valid_first_pass']}; flagged for review: {m['needs_review_share']}")
        c = m["cost"]
        out.append(f"- cost: ${c['usd_total']} for {c['dialogues']} dialogues (≈ ${c['usd_per_dialogue']} per dialogue, {c['calls']} calls)\n")
        out.append("| criterion | n | accuracy | kappa | main confusions (gold→model) |\n|---|---|---|---|---|")
        for r in m["per_criterion"]:
            out.append(f"| {r['id']} {r['title']} | {r['n']} | {r['accuracy']:.0%} | {r['kappa']} | "
                       + ", ".join(f"{k}×{v}" for k, v in r["confusions"].items()) + " |")
        out.append("")
    return "\n".join(out)


def to_html(results: list[dict]) -> str:
    parts = []
    for m in results:
        if not m.get("n_dialogues"):
            continue
        rows = "".join(f"<tr><td>{r['id']} {r['title']}</td><td>{r['accuracy']:.0%}</td><td>{r['kappa']}</td></tr>"
                       for r in m["per_criterion"])
        g, c = m["gross_error"], m["cost"]
        parts.append(
            f"<h4>{m['model']}</h4><p>Точность {m['overall_accuracy']:.1%} на {m['n_dialogues']} диалогах; по языкам: "
            + ", ".join(f"{k} {v:.0%}" for k, v in m["per_language_accuracy"].items())
            + f". Ошибка итога: {m['total_score_mae']} балла. Грубые ошибки: найдено {g['tp']}, пропущено {g['fn']}, "
              f"ложных {g['fp']}. Стоимость ≈ ${c['usd_per_dialogue']} за диалог.</p>"
            f"<table class='tbl'><tr><th>Критерий</th><th>Точность</th><th>Каппа</th></tr>{rows}</table>")
    return "".join(parts)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", action="append", required=True)
    p.add_argument("--version", type=int, default=1)
    a = p.parse_args()
    gold = json.loads((ROOT / "eval" / "gold_labels.json").read_text())["labels"]
    results = [evaluate_model(m, gold, a.version) for m in a.model]
    for m in results:
        name = m["model"].replace(":", "_").replace("/", "_")
        (ROOT / "eval" / f"metrics_{name}.json").write_text(json.dumps(m, ensure_ascii=False, indent=1))
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "metrics.md").write_text(to_markdown(results))
    (ROOT / "frontend" / "metrics.json").write_text(json.dumps({"html": to_html(results), "results": results},
                                                               ensure_ascii=False))
    print(to_markdown(results))


if __name__ == "__main__":
    main()

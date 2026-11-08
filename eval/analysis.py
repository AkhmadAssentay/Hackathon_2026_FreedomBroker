"""Statistical analysis and error analysis of the judging strategies (no model calls).

  python -m eval.analysis

- Bootstrap 95% CIs (resampling whole dialogues) for accuracy, and a paired McNemar test
  router vs Sonnet (limitation #12 of the plan: "too few labels for guarantees").
- Error analysis of the production router: per criterion, direction, scale near-misses,
  language/channel (what is left to fix).
- RULERS-style calibration (limitation #16 "judge stricter/more lenient than humans"):
  a monotone mapping model step -> human step for scale criteria, fitted on `dev`, applied on `test`.
- Verifier-weighted self-consistency (test-time scaling with a verifier) when per-sample
  results exist (eval/runs/qwen_sc8_samples.json).
Writes eval/analysis.json, docs/analysis.md, frontend/analysis.json.
"""
from __future__ import annotations

import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eval.experiments import CRITS, GOLD, combine_parts, ids_for, load  # noqa: E402
from backend import service  # noqa: E402
from backend.scoring import score  # noqa: E402

PROD = "app:router(claude-sonnet-5-5, local:Qwen3.5-35B-A3B-GPTQ-Int4@sc5)"
SYSTEMS = {
    "Маршрутизатор (рабочий прогон)": PROD,
    "Claude Sonnet 5.5": "app:claude-sonnet-5-5",
    "Qwen × 5 голосов": "qwen_sc5",
    "Qwen (один ответ)": "app:local:Qwen3.5-35B-A3B-GPTQ-Int4",
    "Claude Haiku 5.5": "haiku",
}
SCALE = {"c4": [0, 5, 10, 15, 20], "c6": [0, 4, 7, 10]}


def correctness(run: dict, ids: list[str]) -> dict[str, list[int]]:
    """dialogue id -> list of 0/1 over the 8 criteria."""
    return {cid: [int(run[cid]["results"][k]["answer"] == GOLD[cid]["labels"][k]) for k in CRITS]
            for cid in ids if cid in run}


def bootstrap(per_dialog: dict[str, list[int]], n: int = 4000, seed: int = 7) -> tuple[float, float, float]:
    rng = random.Random(seed)
    keys = list(per_dialog)
    acc = sum(map(sum, per_dialog.values())) / (len(keys) * len(CRITS))
    samples = []
    for _ in range(n):
        pick = [per_dialog[rng.choice(keys)] for _ in keys]
        samples.append(sum(map(sum, pick)) / (len(pick) * len(CRITS)))
    samples.sort()
    return acc, samples[int(0.025 * n)], samples[int(0.975 * n) - 1]


def mcnemar(a: dict[str, list[int]], b: dict[str, list[int]]) -> dict:
    """Exact two-sided McNemar on paired per-label correctness."""
    n01 = n10 = 0
    for cid in set(a) & set(b):
        for x, y in zip(a[cid], b[cid]):
            n01 += x == 0 and y == 1
            n10 += x == 1 and y == 0
    n = n01 + n10
    k = min(n01, n10)
    p = min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n) if n else 1.0
    return {"a_right_b_wrong": n10, "a_wrong_b_right": n01, "p_value": round(p, 4)}


def error_analysis(run: dict) -> dict:
    by_crit, direction, near = Counter(), Counter(), Counter()
    scale_err, by_slice, tot_slice = Counter(), Counter(), Counter()
    examples = defaultdict(list)
    for cid, lab in GOLD.items():
        if cid not in run:
            continue
        sl = "звонки" if cid.startswith("p4") else cid.split("-")[1].upper()
        for k in CRITS:
            g, p = lab["labels"][k], run[cid]["results"][k]["answer"]
            tot_slice[sl] += 1
            if g == p:
                continue
            by_crit[k] += 1
            by_slice[sl] += 1
            direction[f"{k}: {g}→{p}"] += 1
            if k in SCALE and g not in ("na",) and p not in ("na", None):
                scale_err[k] += 1
                steps = SCALE[k]
                try:
                    if abs(steps.index(int(float(g))) - steps.index(int(float(p)))) == 1:
                        near[k] += 1
                except ValueError:
                    pass
            if len(examples[k]) < 3:
                examples[k].append(cid)
    n_err = sum(by_crit.values())
    return {
        "errors": n_err, "labels": sum(tot_slice.values()),
        "by_criterion": dict(by_crit.most_common()),
        "top_confusions": dict(direction.most_common(8)),
        "scale_errors": dict(scale_err), "scale_one_step_off": dict(near),
        "error_rate_by_slice": {k: round(by_slice[k] / tot_slice[k], 3) for k in tot_slice},
        "examples": dict(examples),
    }


def fit_calibration(run: dict, k: str) -> dict[str, str]:
    counts = defaultdict(Counter)
    for cid in ids_for("dev"):
        if cid in run:
            counts[run[cid]["results"][k]["answer"]][GOLD[cid]["labels"][k]] += 1
    steps = [str(s) for s in SCALE[k]]
    mapping, last = {}, -1
    for s in steps:  # monotone: a higher model step never maps below a lower one
        c = counts.get(s)
        tgt = c.most_common(1)[0][0] if c and sum(c.values()) >= 2 and c.most_common(1)[0][0] in steps else s
        idx = max(steps.index(tgt), last)
        mapping[s] = steps[idx]
        last = idx
    return mapping


def calibrate(run: dict) -> tuple[dict, dict]:
    maps = {k: fit_calibration(run, k) for k in SCALE}
    out = {}
    for cid, r in run.items():
        res = {k: dict(v) for k, v in r["results"].items()}
        for k, m in maps.items():
            a = res[k]["answer"]
            if a in m:
                res[k]["answer"] = m[a]
        out[cid] = dict(r, results=res)
    return out, maps


def _clopper_lower(k: int, n: int, alpha: float) -> float:
    """One-sided Clopper-Pearson lower bound via bisection on the binomial tail."""
    if n == 0:
        return 0.0
    if k == 0:
        return 0.0
    lo, hi = 0.0, k / n
    for _ in range(60):
        mid = (lo + hi) / 2
        tail = sum(math.comb(n, i) * mid ** i * (1 - mid) ** (n - i) for i in range(k, n + 1))
        if tail < alpha:
            lo = mid
        else:
            hi = mid
    return lo


def label_conf(r: dict) -> float:
    """Confidence of one criterion decision: vote share for self-consistency, self-report otherwise,
    reduced when the validator flagged it."""
    conf = {"high": 1.0, "medium": 0.75, "low": 0.4}
    c = r.get("vote_share", 1.0) if (r.get("model") or "").endswith("@sc5") else conf.get(r.get("confidence"), 0.75)
    return c * (0.5 if r.get("app_errors") else 1.0)


def conformal_escalation(run: dict, target: float = 0.95, alpha: float = 0.1) -> dict:
    """Trust-or-Escalate with a finite-sample guarantee: on dev choose the lowest confidence threshold whose
    auto-accepted decisions have a Clopper-Pearson lower bound >= target; decisions below go to a human.
    Report coverage and realised accuracy on test."""
    def items(which):
        return [(label_conf(run[c]["results"][k]), run[c]["results"][k]["answer"] == GOLD[c]["labels"][k])
                for c in ids_for(which) if c in run for k in CRITS]
    dev, test = items("dev"), items("test")
    best = None
    for t in sorted({c for c, _ in dev}):
        acc_ = [ok for c, ok in dev if c >= t]
        if acc_ and _clopper_lower(sum(acc_), len(acc_), alpha) >= target:
            best = t
            break
    if best is None:
        return {"target": target, "threshold": None}
    acc_t = [ok for c, ok in test if c >= best]
    return {"target": target, "alpha": alpha, "threshold": round(best, 3),
            "test_auto_share": round(len(acc_t) / len(test), 3),
            "test_auto_accuracy": round(sum(acc_t) / len(acc_t), 4) if acc_t else None,
            "test_to_human": len(test) - len(acc_t)}


def acc(run: dict, which: str) -> float | None:
    c = correctness(run, ids_for(which))
    return round(sum(map(sum, c.values())) / (len(c) * len(CRITS)), 4) if c else None


def total_mae(run: dict, which: str) -> float | None:
    cl = service.get_checklist(1)
    d = []
    for cid in ids_for(which):
        if cid in run:
            g = score(cl, GOLD[cid]["labels"])["total"]
            p = score(cl, {k: run[cid]["results"][k]["answer"] for k in CRITS})["total"]
            if g is not None and p is not None:
                d.append(abs(g - p))
    return round(sum(d) / len(d), 2) if d else None


def verifier_weighted() -> dict | None:
    """Test-time scaling with a verifier: 8 samples per dialogue for c4-c6, each vote weighted by
    whether its citations passed the code validator (and its self-reported confidence)."""
    s8 = load("qwen_sc8_samples")
    if not s8:
        return None
    sonnet = load("app:claude-sonnet-5-5")
    conf_w = {"high": 1.0, "medium": 0.7, "low": 0.4}
    variants = {}
    for name, wfun in {
        "majority (8 votes)": lambda s: 1.0,
        "verifier-weighted": lambda s: 1.0 if s["ok"] else 0.25,
        "verifier × confidence": lambda s: (1.0 if s["ok"] else 0.25) * conf_w.get(s.get("conf"), 0.7),
        "first 5 votes": None,
    }.items():
        run = {}
        for cid, r in s8.items():
            if cid not in sonnet:
                continue
            res = {k: sonnet[cid]["results"][k] for k in ("c1", "c2", "c3", "c7", "c8")}
            for k in ("c4", "c5", "c6"):
                samples = r["results"][k].get("samples", [])
                if wfun is None:
                    samples = samples[:5]
                    w = Counter(s["a"] for s in samples)
                else:
                    w = Counter()
                    for s in samples:
                        w[s["a"]] += wfun(s)
                res[k] = {"answer": w.most_common(1)[0][0] if w else None}
            run[cid] = {"cid": cid, "results": res}
        variants[name] = {"test": acc(run, "test"), "all": acc(run, "all"), "mae_all": total_mae(run, "all")}
    return variants


def main():
    out: dict = {"systems": {}, "notes": []}
    runs = {name: load(src) for name, src in SYSTEMS.items()}
    for name, run in runs.items():
        if not run:
            continue
        a_all = bootstrap(correctness(run, ids_for("all")))
        a_test = bootstrap(correctness(run, ids_for("test")))
        out["systems"][name] = {"all": [round(x, 4) for x in a_all], "test": [round(x, 4) for x in a_test],
                                "mae_all": total_mae(run, "all")}
    if runs.get("Маршрутизатор (рабочий прогон)") and runs.get("Claude Sonnet 5.5"):
        out["mcnemar_router_vs_sonnet"] = mcnemar(correctness(runs["Маршрутизатор (рабочий прогон)"], ids_for("all")),
                                                  correctness(runs["Claude Sonnet 5.5"], ids_for("all")))
    out["error_analysis_router"] = error_analysis(runs["Маршрутизатор (рабочий прогон)"])

    cal = {}
    for name in ("Claude Sonnet 5.5", "Qwen × 5 голосов", "Маршрутизатор (рабочий прогон)"):
        run = runs.get(name)
        if not run:
            continue
        crun, maps = calibrate(run)
        cal[name] = {"mapping": maps, "test_before": acc(run, "test"), "test_after": acc(crun, "test"),
                     "mae_before": total_mae(run, "test"), "mae_after": total_mae(crun, "test")}
    out["calibration"] = cal
    out["conformal"] = {f"{int(t*100)}%": conformal_escalation(runs["Маршрутизатор (рабочий прогон)"], t)
                        for t in (0.90, 0.93, 0.95)}
    vw = verifier_weighted()
    if vw:
        out["verifier_weighted_sc"] = vw
    c4sub = load("qwen_sc5_c456_c4sub")
    if c4sub:
        base = combine_parts({"app:claude-sonnet-5-5": ["c1", "c2", "c3", "c7", "c8"], "qwen_sc5_c456": ["c4", "c5", "c6"]})
        new = combine_parts({"app:claude-sonnet-5-5": ["c1", "c2", "c3", "c7", "c8"], "qwen_sc5_c456_c4sub": ["c4", "c5", "c6"]})
        def c4acc(run, which):
            ids = [i for i in ids_for(which) if i in run]
            return round(sum(run[i]["results"]["c4"]["answer"] == GOLD[i]["labels"]["c4"] for i in ids) / len(ids), 3) if ids else None
        out["c4_question_coverage"] = {"c4_all_before": c4acc(base, "all"), "c4_all_after": c4acc(new, "all"),
                                       "c4_test_before": c4acc(base, "test"), "c4_test_after": c4acc(new, "test"),
                                       "router_all_before": acc(base, "all"), "router_all_after": acc(new, "all")}
    (ROOT / "eval" / "analysis.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    (ROOT / "frontend" / "analysis.json").write_text(json.dumps(out, ensure_ascii=False))
    # markdown
    L = ["# Analysis: confidence intervals, error analysis, calibration\n",
         "| system | accuracy all 44 (95% CI) | held-out test (95% CI) | total MAE |", "|---|---|---|---|"]
    for name, m in out["systems"].items():
        a, t = m["all"], m["test"]
        L.append(f"| {name} | {a[0]:.1%} ({a[1]:.1%}–{a[2]:.1%}) | {t[0]:.1%} ({t[1]:.1%}–{t[2]:.1%}) | {m['mae_all']} |")
    if "mcnemar_router_vs_sonnet" in out:
        m = out["mcnemar_router_vs_sonnet"]
        L.append(f"\nMcNemar router vs Sonnet (paired labels): router right & Sonnet wrong {m['a_right_b_wrong']}, "
                 f"the reverse {m['a_wrong_b_right']}, p = {m['p_value']}")
    e = out["error_analysis_router"]
    L.append(f"\n## Remaining errors of the production router: {e['errors']} of {e['labels']} labels")
    L.append("- by criterion: " + ", ".join(f"{k} {v}" for k, v in e["by_criterion"].items()))
    L.append("- top confusions (gold→model): " + ", ".join(f"{k} ×{v}" for k, v in e["top_confusions"].items()))
    L.append(f"- scale errors one step off: " + ", ".join(f"{k} {e['scale_one_step_off'].get(k, 0)}/{v}" for k, v in e["scale_errors"].items()))
    L.append("- error rate by slice: " + ", ".join(f"{k} {v:.1%}" for k, v in e["error_rate_by_slice"].items()))
    L.append("\n## RULERS-style calibration of scale criteria (fit on dev, applied on test)")
    for name, c in cal.items():
        L.append(f"- {name}: test {c['test_before']} → {c['test_after']}, MAE {c['mae_before']} → {c['mae_after']}; mapping {c['mapping']}")
    L.append("\n## Conformal Trust-or-Escalate on the production router (threshold fit on dev, 90% confidence)")
    for t, c in out["conformal"].items():
        L.append(f"- target {t}: threshold {c.get('threshold')}, test auto-accepted {c.get('test_auto_share')} "
                 f"with accuracy {c.get('test_auto_accuracy')}, to human {c.get('test_to_human')}")
    if vw:
        L.append("\n## Verifier-weighted self-consistency (c4-c6 from 8 Qwen samples, rest Sonnet)")
        for k, v in vw.items():
            L.append(f"- {k}: test {v['test']}, all {v['all']}, MAE {v['mae_all']}")
    if "c4_question_coverage" in out:
        L.append(f"\n## Question-coverage decomposition for consultation\n- {out['c4_question_coverage']}")
    (ROOT / "docs" / "analysis.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()

"""Deterministic scoring engine. The LLM never computes numbers.

Rules (from the checklist PDF, "Порядок расчёта"):
 1. N/A only where allowed.
 2. Yes = full weight, No = 0. Scale: one of the listed steps.
 3. Scale -> points proportional to weight; the top step gives the full weight.
 4. Drop N/A criteria and redistribute their weight proportionally among the
    applicable weighted criteria, so the maximum stays 100.
 5. Round the total to 2 decimals. No applicable weighted criteria -> no total.
    Gross errors are flagged separately (policy "flag"), optionally "zero_total".
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any


def _round(x: float | None, nd: int) -> float | None:
    if x is None:
        return None
    q = Decimal(1).scaleb(-nd)  # 10^-nd
    return float(Decimal(str(x)).quantize(q, rounding=ROUND_HALF_UP))


def allowed_answers(crit: dict) -> list[str]:
    if crit["type"] == "scale":
        ans = [str(s["value"]) for s in crit["scale"]]
    else:
        ans = ["yes", "no"]
    if crit.get("na_allowed"):
        ans.append("na")
    return ans


def fraction(crit: dict, answer: str) -> float | None:
    """Share of the criterion weight earned; None for N/A."""
    if answer == "na":
        return None
    if crit["type"] == "scale":
        top = max(float(s["value"]) for s in crit["scale"])
        return 0.0 if top <= 0 else float(answer) / top
    # Gross-error criterion: "yes" means a violation exists; it has no weight anyway.
    return 1.0 if answer == "yes" else 0.0


def score(checklist: dict, answers: dict[str, str]) -> dict[str, Any]:
    """answers: criterion_id -> answer string ("yes"/"no"/"na"/scale value)."""
    nd = int(checklist.get("rounding", 2))
    crits = checklist["criteria"]
    weighted = [c for c in crits if not c.get("gross") and float(c.get("weight", 0)) > 0]
    applicable = [c for c in weighted if answers.get(c["id"], "na") != "na"]
    w_app = sum(float(c["weight"]) for c in applicable)
    w_all = sum(float(c["weight"]) for c in weighted)

    per: dict[str, dict] = {}
    earned_total = 0.0
    for c in crits:
        a = answers.get(c["id"])
        w = float(c.get("weight", 0))
        row = {"answer": a, "weight": w, "effective_weight": 0.0, "points": 0.0, "fraction": None}
        if c.get("gross") or w <= 0 or a is None:
            per[c["id"]] = row
            continue
        f = fraction(c, a)
        row["fraction"] = f
        if f is not None and w_app > 0:
            eff = w * 100.0 / w_app
            row["effective_weight"] = _round(eff, nd)
            row["points"] = _round(f * eff, nd)
            earned_total += f * eff
        row["raw_points"] = None if f is None else _round(f * w, nd)
        per[c["id"]] = row

    total = _round(earned_total, nd) if w_app > 0 else None

    sections = []
    for s in checklist.get("sections", []):
        sc = [c for c in applicable if c.get("section") == s["id"]]
        all_sc = [c for c in weighted if c.get("section") == s["id"]]
        if not all_sc:
            continue
        sw = sum(float(c["weight"]) for c in sc)
        se = sum((fraction(c, answers[c["id"]]) or 0.0) * float(c["weight"]) for c in sc)
        sections.append({
            "id": s["id"], "title": s["title"],
            "percent": _round(100.0 * se / sw, nd) if sw > 0 else None,
            "points": _round(se * 100.0 / w_app, nd) if w_app > 0 else None,
            "max_points": _round(sw * 100.0 / w_app, nd) if w_app > 0 else None,
        })

    gross_flags = [c["id"] for c in crits if c.get("gross") and answers.get(c["id"]) == "yes"]
    gross = bool(gross_flags)
    policy = checklist.get("gross_error_policy", "flag")
    final_total = total
    if gross and policy == "zero_total" and total is not None:
        final_total = 0.0

    return {
        "total": final_total,
        "total_before_gross_policy": total,
        "max_total": 100.0 if w_app > 0 else None,
        "applicable_weight": w_app,
        "configured_weight": w_all,
        "na_criteria": [c["id"] for c in weighted if answers.get(c["id"]) == "na"],
        "criteria": per,
        "sections": sections,
        "gross_error": gross,
        "gross_criteria": gross_flags,
        "gross_error_policy": policy,
    }

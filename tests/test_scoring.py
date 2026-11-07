import json
from pathlib import Path

from backend.scoring import allowed_answers, score

CL = json.loads((Path(__file__).parents[1] / "config" / "checklist_v1.json").read_text())


def all_yes():
    return {"c1": "yes", "c2": "yes", "c3": "yes", "c4": "20", "c5": "yes", "c6": "10", "c7": "yes", "c8": "no"}


def test_perfect_score_is_100():
    r = score(CL, all_yes())
    assert r["total"] == 100.0
    assert r["gross_error"] is False


def test_scale_proportional_to_weight():
    a = all_yes() | {"c6": "7"}  # 7/10 of weight 15 = 10.5 -> total 95.5
    assert score(CL, a)["total"] == 95.5
    a = all_yes() | {"c4": "15"}  # 15/20 of 20 = 15 -> 95
    assert score(CL, a)["total"] == 95.0


def test_na_redistributes_weight():
    # c3 (20) N/A -> remaining weights sum 80; c7 "no" (5) -> 75/80*100 = 93.75
    a = all_yes() | {"c3": "na", "c7": "no"}
    r = score(CL, a)
    assert r["total"] == 93.75
    assert r["criteria"]["c1"]["effective_weight"] == 12.5
    assert r["na_criteria"] == ["c3"]


def test_rounding_two_decimals():
    # c2, c3 N/A -> 65 applicable; c6 = 4 -> 6/15 earned; lose 9 of 65 -> 56/65 = 86.1538...
    a = all_yes() | {"c2": "na", "c3": "na", "c6": "4"}
    assert score(CL, a)["total"] == 86.15


def test_no_applicable_criteria_no_total():
    a = {"c1": "na", "c2": "na", "c3": "na", "c4": "na", "c5": "na", "c6": "na", "c7": "na", "c8": "no"}
    assert score(CL, a)["total"] is None


def test_gross_error_flag_only():
    a = all_yes() | {"c8": "yes"}
    r = score(CL, a)
    assert r["gross_error"] is True
    assert r["total"] == 100.0  # policy "flag": marked separately, total unchanged


def test_gross_error_zero_policy():
    cl = dict(CL, gross_error_policy="zero_total")
    r = score(cl, all_yes() | {"c8": "yes"})
    assert r["total"] == 0.0 and r["total_before_gross_policy"] == 100.0


def test_sections():
    r = score(CL, all_yes() | {"c2": "no"})
    start = next(s for s in r["sections"] if s["id"] == "start")
    assert start["percent"] == 40.0  # 10 of 25
    assert r["total"] == 85.0


def test_allowed_answers():
    c = {x["id"]: x for x in CL["criteria"]}
    assert allowed_answers(c["c1"]) == ["yes", "no"]
    assert allowed_answers(c["c4"]) == ["20", "15", "10", "5", "0", "na"]

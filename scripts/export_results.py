"""Export evaluations in the team's results format "JSON 1.0" (results/<set>/results.json).

  python -m scripts.export_results --group <ID> --out results/prod/results.json [--team Kaira]

Uses the latest evaluation of every dialogue in the group, with reviewer decisions applied.
Message numbers are 1-based (transcript index + 1).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from backend import service  # noqa: E402

IDS = {"c1": "contact", "c2": "discovery", "c3": "identification", "c4": "consultation",
       "c5": "empathy", "c6": "dialogue", "c7": "closure", "c8": "critical"}


def value(crit: dict, ans: str | None):
    if ans in (None, "na"):
        return None
    if crit["type"] == "scale":
        f = float(ans)
        return int(f) if f.is_integer() else f
    return ans == "yes"


def turns_of(r: dict, n_turns: int) -> list[int]:
    t = [e["turn"] + 1 for e in r.get("evidence", []) if isinstance(e.get("turn"), int)]
    if not t and isinstance(r.get("expected_turn"), int) and r["expected_turn"] >= 0:
        t = [r["expected_turn"] + 1]
    if not t and len(r.get("checked_span") or []) == 2:
        t = [r["checked_span"][0] + 1, r["checked_span"][1] + 1]
    return sorted({x for x in t if 1 <= x <= n_turns})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--group", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--team", default="Kaira")
    p.add_argument("--mode", default="hybrid")
    p.add_argument("--model", default="router: claude-sonnet-5-5 + Qwen3.5-35B-A3B (self-consistency x5)")
    a = p.parse_args()
    out = []
    for c in service.list_conversations(a.group):
        conv = service.get_conv(c["id"])
        if not c.get("evaluation_id"):
            out.append({"conversation_id": c["cid"], "status": "error", "error": "not evaluated"})
            continue
        v = service.evaluation_view(c["evaluation_id"])
        crits = []
        for crit in v["checklist"]["criteria"]:
            cid = crit["id"]
            r = v["results"].get(cid, {})
            ans = v["final_answers"].get(cid)
            crits.append({"criterion_id": IDS.get(cid, cid), "value": value(crit, ans),
                          "rationale": r.get("explanation", "") or r.get("na_reason", ""),
                          "evidence_turns": turns_of(r, len(conv["turns"]))})
        fs = v["final_score"]
        out.append({"conversation_id": c["cid"], "status": "ok", "criteria": crits,
                    "score": {"final_score": fs["total"], "critical_flag": bool(fs["gross_error"])}})
    doc = {"schema_version": "1.0", "team_name": a.team, "model": {"mode": a.mode, "name": a.model}, "results": out}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, indent=1))
    print(f"wrote {a.out}: {sum(r['status'] == 'ok' for r in out)} ok, {sum(r['status'] != 'ok' for r in out)} errors")


if __name__ == "__main__":
    main()

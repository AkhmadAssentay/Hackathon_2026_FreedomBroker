"""CLI for batch work (same code as the UI).

  python -m scripts.run fetch --group DEV
  python -m scripts.run evaluate --group DEV --provider claude [--model claude-haiku-5-5] [--version N] [--only p1-ru-001,...]
  python -m scripts.run export --group DEV --out results/DEV.json
  python -m scripts.run budget

Re-running `evaluate` is safe: criterion results are cached per (dialogue, transcript hash,
criterion definition, model), so an interrupted run resumes and an edited checklist only
re-evaluates the changed criteria.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from backend import budget, service  # noqa: E402


def cmd_fetch(a):
    if a.file:
        body = json.loads(Path(a.file).read_text())
        print(service.ingest(a.group, body["data"]["records"]))
    else:
        print(service.ingest(a.group))


def cmd_evaluate(a):
    convs = service.list_conversations(a.group)
    keys = [c["id"] for c in convs]
    if a.only:
        want = set(a.only.split(","))
        keys = [k for k in keys if k.split(":", 1)[1] in want]
    if a.limit:
        keys = keys[: a.limit]
    print(f"evaluating {len(keys)} dialogues with {a.provider} {a.model or ''} (checklist v{a.version or 'latest'})")
    t0, done, failed = time.time(), 0, 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(service.evaluate, k, a.version, a.provider, a.model): k for k in keys}
        for f in as_completed(futs):
            k = futs[f]
            try:
                eid = f.result()
                v = service.evaluation_view(eid)
                done += 1
                print(f"  ok  {k:24s} total={v['original_score']['total']} gross={v['original_score']['gross_error']}"
                      f" review={v['needs_review']} cost=${v['cost_usd']:.4f}")
            except budget.BudgetExceeded as e:
                failed += 1
                print(f"  STOP {k}: {e}")
                ex.shutdown(cancel_futures=True)
                break
            except Exception as e:
                failed += 1
                print(f"  ERR {k}: {e}")
    print(f"done={done} failed={failed} in {time.time() - t0:.0f}s; spent so far ${budget.spent():.4f} of ${budget.cap():.2f}")


def cmd_export(a):
    rows = []
    for c in service.list_conversations(a.group, a.version):
        if not c.get("evaluation_id"):
            continue
        v = service.evaluation_view(c["evaluation_id"])
        rows.append({
            "conversation_id": c["cid"], "channel": c["channel"], "language": c["language"],
            "checklist_version": v["checklist_version"], "model": v["model"],
            "total": v["original_score"]["total"], "final_total": v["final_score"]["total"],
            "gross_error": v["final_score"]["gross_error"], "sections": v["final_score"]["sections"],
            "criteria": {cid: {k: r.get(k) for k in ("answer", "evidence", "checked_span", "expected_turn",
                                                    "na_reason", "explanation", "confidence", "needs_review")}
                         for cid, r in v["results"].items()},
            "appeals": v["appeals"],
        })
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print(f"wrote {len(rows)} evaluations -> {out}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("--group", required=True); f.add_argument("--file")
    e = sub.add_parser("evaluate"); e.add_argument("--group", required=True)
    e.add_argument("--provider", default=None); e.add_argument("--model", default=None)
    e.add_argument("--version", type=int, default=None); e.add_argument("--only"); e.add_argument("--limit", type=int)
    e.add_argument("--workers", type=int, default=6)
    x = sub.add_parser("export"); x.add_argument("--group", required=True); x.add_argument("--out", required=True)
    x.add_argument("--version", type=int, default=None)
    sub.add_parser("budget")
    a = p.parse_args()
    service.ensure_seed()
    {"fetch": cmd_fetch, "evaluate": cmd_evaluate, "export": cmd_export,
     "budget": lambda a: print(json.dumps(budget.summary(), indent=1))}[a.cmd](a)


if __name__ == "__main__":
    main()

"""Static read-only snapshot of the UI's GET responses (for hosting without a backend, e.g. Vercel).

  python -m scripts.export_snapshot [--group DEV] [--base http://127.0.0.1:8000]

Writes frontend/snapshot.json. Voice calls are excluded: they are real customer conversations
(the 60 chats are synthetic). The UI switches to read-only mode when /api is unavailable.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import quote

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--group", default="DEV")
    p.add_argument("--base", default="http://127.0.0.1:8000")
    a = p.parse_args()
    c = httpx.Client(base_url=a.base, timeout=180)
    R: dict[str, object] = {}

    def get(path: str):
        r = c.get(path)
        r.raise_for_status()
        R[path] = r.json()
        return R[path]

    get("/api/health")
    groups = get("/api/groups")
    R["/api/groups"] = [g for g in groups if g["group_id"] == a.group]
    convs = get(f"/api/conversations?group_id={quote(a.group)}")
    keep = [x for x in convs if x["channel"] != "voice call"]
    R[f"/api/conversations?group_id={quote(a.group)}"] = keep
    keep_ids = {x["cid"] for x in keep}
    R["/api/groups"] = [dict(g, n=len(keep)) for g in R["/api/groups"]]
    for x in keep:
        d = get(f"/api/conversations/{quote(x['id'], safe='')}")
        if d.get("evaluation"):
            eid = d["evaluation"]["id"]
            R[f"/api/evaluations/{eid}"] = d["evaluation"]
            try:
                get(f"/api/evaluations/{eid}/insights")
            except httpx.HTTPError:
                pass
    an = get(f"/api/analytics?group_id={quote(a.group)}")
    an["gross"] = [g for g in an["gross"] if g in keep_ids]
    an["worst"] = [w for w in an["worst"] if w["cid"] in keep_ids]
    for path in ("/api/checklists", "/api/checklists/latest", "/api/appeals?status=open", "/api/appeals?status=decided",
                 "/api/appeals", "/api/budget"):
        get(path)
    for v in R["/api/checklists"]:
        get(f"/api/checklists/{v['version']}")
    R["_meta"] = {"group": a.group, "dialogues": len(keep), "note": "read-only snapshot, synthetic chats only"}
    out = ROOT / "frontend" / "snapshot.json"
    out.write_text(json.dumps(R, ensure_ascii=False))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(keep)} dialogues)")


if __name__ == "__main__":
    main()

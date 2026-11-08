"""FastAPI backend + static frontend.  Run:  uvicorn backend.app:app --port 8000"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import Body, FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from . import budget, service  # noqa: E402
from .datasource import ROOT, audio_peaks, facts, resolve_audio  # noqa: E402

app = FastAPI(title="CQA — Conversation Quality Analytics")
service.ensure_seed()


def _err(e: Exception, code: int = 400):
    raise HTTPException(status_code=code, detail=str(e))


@app.get("/api/health")
def health():
    return {"ok": True, "default_provider": os.environ.get("DEFAULT_PROVIDER", "router"),
            "claude_model": os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5"),
            "has_claude_key": bool(os.environ.get("ANTHROPIC_API_KEY"))}


# ---------------------------------------------------------------- data

@app.post("/api/datasets/{group_id}/fetch")
def fetch(group_id: str):
    try:
        return service.ingest(group_id)
    except Exception as e:
        _err(e, 502)


@app.get("/api/groups")
def groups():
    return service.groups()


@app.get("/api/conversations")
def conversations(group_id: str | None = None, version: int | None = None):
    return service.list_conversations(group_id, version)


@app.get("/api/conversations/{key}")
def conversation(key: str, version: int | None = None):
    try:
        conv = service.get_conv(key)
    except KeyError as e:
        _err(e, 404)
    eid = service.latest_evaluation_id(key, version)
    return {"conversation": conv, "facts": facts(conv),
            "evaluation": service.evaluation_view(eid) if eid else None,
            "history": service.db.q("SELECT id, checklist_version, model, created_at FROM evaluations "
                                    "WHERE conv_id=? ORDER BY id DESC", (key,))}


@app.get("/api/audio/{key}")
def audio(key: str, request: Request):
    conv = service.get_conv(key)
    if not conv.get("audio_url"):
        _err(KeyError("no audio"), 404)
    try:
        p = resolve_audio(conv["conversation_id"], conv["audio_url"])
    except Exception as e:
        _err(e, 502)
    return _ranged_file(p, request)


@app.get("/api/audio/{key}/peaks")
def peaks(key: str):
    conv = service.get_conv(key)
    if not conv.get("audio_url"):
        _err(KeyError("no audio"), 404)
    try:
        return audio_peaks(resolve_audio(conv["conversation_id"], conv["audio_url"]))
    except Exception as e:
        _err(e, 502)


@app.get("/api/audio/{key}/analysis")
def audio_analysis(key: str):
    from .audio_align import analysis
    a = analysis(service.get_conv(key))
    if not a:
        _err(KeyError("нет выравнивания по словам для этой записи (hpc/whisper.sbatch)"), 404)
    return a


@app.get("/api/analytics")
def analytics(group_id: str | None = None, version: int | None = None, model: str | None = None):
    return service.analytics(group_id, version, model)


def _ranged_file(p: Path, request: Request):
    size = p.stat().st_size
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(p, media_type="audio/mpeg", headers={"Accept-Ranges": "bytes"})
    start_s, _, end_s = rng.replace("bytes=", "").partition("-")
    start = int(start_s or 0)
    end = min(int(end_s) if end_s else size - 1, size - 1)
    with open(p, "rb") as f:
        f.seek(start)
        data = f.read(end - start + 1)
    return Response(data, status_code=206, media_type="audio/mpeg",
                    headers={"Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
                             "Content-Length": str(len(data))})


# ---------------------------------------------------------------- checklists

@app.get("/api/checklists")
def checklists():
    return service.list_checklists()


@app.get("/api/checklists/latest")
def checklist_latest():
    return service.get_checklist()


@app.get("/api/checklists/{version}")
def checklist(version: int):
    try:
        return service.get_checklist(version)
    except KeyError as e:
        _err(e, 404)


@app.post("/api/checklists")
def save_checklist(payload: dict = Body(...)):
    cl = payload.get("checklist") or payload
    for k in ("version", "created_at"):
        cl.pop(k, None)
    try:
        v = service.save_checklist(cl, payload.get("note", ""))
    except ValueError as e:
        _err(e)
    return {"version": v}


# ---------------------------------------------------------------- evaluation

@app.post("/api/evaluate")
def evaluate(payload: dict = Body(...)):
    keys = payload.get("keys") or []
    if payload.get("group_id") and not keys:
        keys = [c["id"] for c in service.list_conversations(payload["group_id"])]
    if not keys:
        _err(ValueError("нет диалогов для оценки"))
    jid = service.start_job(keys, payload.get("version"), payload.get("provider"), payload.get("model"))
    return service.JOBS[jid]


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = service.JOBS.get(jid)
    if not j:
        _err(KeyError(jid), 404)
    return j


@app.get("/api/evaluations/{eid}")
def evaluation(eid: int):
    try:
        return service.evaluation_view(eid)
    except KeyError as e:
        _err(e, 404)


@app.get("/api/evaluations/{eid}/insights")
def evaluation_insights(eid: int):
    try:
        return service.insights(eid)
    except KeyError as e:
        _err(e, 404)
    except Exception as e:
        _err(e, 502)


# ---------------------------------------------------------------- appeals

@app.post("/api/evaluations/{eid}/appeals")
def appeal(eid: int, payload: dict = Body(...)):
    try:
        aid = service.create_appeal(eid, payload["criterion_id"], payload.get("comment", ""),
                                    payload.get("author", "оператор"))
    except (KeyError, ValueError) as e:
        _err(e)
    return {"id": aid}


@app.get("/api/appeals")
def appeals(status: str | None = None):
    return service.list_appeals(status)


@app.post("/api/appeals/{aid}/decision")
def decision(aid: int, payload: dict = Body(...)):
    try:
        return service.decide_appeal(aid, payload.get("decision", ""), payload.get("new_answer"),
                                     payload.get("reason", ""), payload.get("reviewer", "проверяющий"))
    except (KeyError, ValueError) as e:
        _err(e)


@app.get("/api/budget")
def spend():
    return budget.summary()


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")

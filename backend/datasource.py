"""Organizer API adapter, transcript normalisation, computed facts, audio resolver.

The organizers' endpoint does not send CORS headers, so the browser never calls it
directly: the backend fetches, normalises and stores the records.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
AUDIO_DIR = DATA / "audio"
RAW_DIR = DATA / "raw"


def api_url(group_id: str) -> str:
    tpl = os.environ.get("CQA_API_URL_TEMPLATE", "")
    if "{group_id}" not in tpl:
        raise RuntimeError("CQA_API_URL_TEMPLATE is not set (see .env.example)")
    return tpl.replace("{group_id}", httpx.QueryParams({"g": group_id})["g"])


def fetch_group(group_id: str) -> list[dict]:
    """GET the dataset; keep an untouched raw copy under data/raw/."""
    r = httpx.get(api_url(group_id), timeout=120)
    r.raise_for_status()
    body = r.json()
    if not body.get("isSuccess"):
        raise RuntimeError(f"organizer API error: {body.get('error')}")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (RAW_DIR / f"{group_id}-{stamp}.json").write_text(json.dumps(body, ensure_ascii=False))
    return body["data"]["records"]


# ---------------------------------------------------------------- normalisation

_PAUSE = re.compile(r"(приостановлен|paused|тоқтатыл)", re.I)
_RESUME = re.compile(r"(возобновлен|resumed|жалғастырыл|қайта бастал)", re.I)


def _parse_ts(ts: str) -> float | None:
    ts = (ts or "").strip()
    m = re.fullmatch(r"(\d+):(\d{1,2})(?::(\d{1,2}))?", ts)
    if m:
        a, b, c = m.groups()
        return int(a) * 3600 + int(b) * 60 + int(c) if c else int(a) * 60 + int(b)
    try:
        # Python 3.11+ handles 7-digit fractions poorly; trim to microseconds.
        ts2 = re.sub(r"(\.\d{6})\d+", r"\1", ts)
        return datetime.fromisoformat(ts2).timestamp()
    except ValueError:
        return None


def normalise(rec: dict) -> dict:
    turns = rec.get("transcript") or []
    raw = [_parse_ts(t.get("timestamp", "")) for t in turns]
    t0 = next((x for x in raw if x is not None), 0.0)
    out, paused_total, pause_start = [], 0.0, None
    for i, t in enumerate(turns):
        sec = None if raw[i] is None else raw[i] - t0
        text = t.get("text", "") or ""
        spk = (t.get("speaker") or "").lower()
        audio_sec = None
        if sec is not None:
            audio_sec = sec - paused_total - ((sec - pause_start) if pause_start is not None else 0.0)
        if spk == "system" and sec is not None:
            if _PAUSE.search(text) and pause_start is None:
                pause_start = sec
            elif _RESUME.search(text) and pause_start is not None:
                paused_total += sec - pause_start
                pause_start = None
        out.append({
            "i": i, "speaker": spk, "text": text,
            "timestamp": t.get("timestamp", ""),
            "t": None if sec is None else round(sec, 2),
            "audio_t": None if audio_sec is None else round(max(audio_sec, 0.0), 2),
        })
    return {
        "conversation_id": rec["conversation_id"],
        "channel": rec.get("channel", ""),
        "language": rec.get("language", ""),
        "audio_url": rec.get("audio_url"),
        "turns": out,
    }


def transcript_hash(conv: dict) -> str:
    s = json.dumps([[t["speaker"], t["text"], t["timestamp"]] for t in conv["turns"]], ensure_ascii=False)
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def _mmss(sec: float | None) -> str:
    if sec is None:
        return "?"
    sec = int(round(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


def facts(conv: dict) -> dict[str, Any]:
    """Facts computed in code so the model never does timestamp arithmetic."""
    turns = conv["turns"]
    op = [t for t in turns if t["speaker"] == "operator"]
    f: dict[str, Any] = {
        "channel": conv["channel"], "language": conv["language"],
        "n_turns": len(turns), "operator_turns": [t["i"] for t in op],
        "duration": _mmss(turns[-1]["t"] if turns else None),
    }
    if op:
        first = op[0]
        handoff = next((t for t in reversed(turns[: first["i"]]) if t["speaker"] in ("system", "bot")), None)
        f["first_operator_turn"] = first["i"]
        if handoff and handoff["t"] is not None and first["t"] is not None:
            f["handoff_turn"] = handoff["i"]
            f["first_response_sec"] = round(first["t"] - handoff["t"])
        # longest wait for an operator reply after a client message
        delays, pending = [], None
        for t in turns:
            if t["speaker"] == "client" and pending is None:
                pending = t
            elif t["speaker"] == "operator" and pending is not None:
                if pending["t"] is not None and t["t"] is not None and pending["i"] > first["i"] - 1:
                    delays.append((round(t["t"] - pending["t"]), pending["i"], t["i"]))
                pending = None
        if delays:
            d = max(delays)
            f["max_reply_delay_sec"] = d[0]
            f["max_reply_delay_turns"] = [d[1], d[2]]
        f["last_operator_turn"] = op[-1]["i"]
    f["system_events"] = [f"t{t['i']}: {t['text']}" for t in turns if t["speaker"] == "system"]
    if turns:
        last = turns[-1]
        f["last_turn"] = f"t{last['i']} ({last['speaker']})"
    return f


# ---------------------------------------------------------------- audio

def _audio_key(conv_id: str, url: str) -> str:
    m = re.search(r"Conversation/([0-9a-fA-F-]{36})", url or "")
    return f"{conv_id}-{m.group(1)[:8]}" if m else f"{conv_id}-{hashlib.sha1((url or '').encode()).hexdigest()[:8]}"


def audio_path(conv_id: str, url: str) -> Path:
    return AUDIO_DIR / f"{_audio_key(conv_id, url)}.mp3"


def resolve_audio(conv_id: str, url: str) -> Path:
    """audio_url returns an HTML player whose <source src> is a 1-hour signed MP3 link.
    Resolve it once and cache the MP3 so the browser can seek (Range) from our server."""
    p = audio_path(conv_id, url)
    if p.exists() and p.stat().st_size > 1000:
        return p
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=120, follow_redirects=True) as c:
        r = c.get(url)
        r.raise_for_status()
        if "audio" in r.headers.get("content-type", ""):
            data = r.content
        else:
            m = re.search(r'<source[^>]+src="([^"]+)"', r.text) or re.search(r'src="(https://[^"]+)"', r.text)
            if not m:
                raise RuntimeError("no audio source in player page")
            src = m.group(1).replace("&amp;", "&")
            r2 = c.get(src)
            r2.raise_for_status()
            data = r2.content
    tmp = p.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.rename(p)
    return p

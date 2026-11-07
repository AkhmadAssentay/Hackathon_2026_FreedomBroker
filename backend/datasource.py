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
# Hold / consultation (ported from the Node prototype): while the client is on hold the
# operator talks to a colleague; those turns are internal and are not evaluated.
_HOLD_END = re.compile(r"больше не находится на удержании|снят с удержания|off hold|no longer on hold|ұстаудан шықты", re.I)
_HOLD_START = re.compile(r"на удержании|on hold|ұстауда", re.I)
_CONSULT_START = re.compile(r"началась консультация|консультация с агентом началась|consultation (has )?started", re.I)
_CONSULT_END = re.compile(r"агент вышел из разговора|consultation (has )?ended", re.I)
_OP_CLOSED = re.compile(r"оператор закрыл чат|agent closed the chat|оператор чатты жапты|оператор чатты аяқтады", re.I)
_CLIENT_ENDED = re.compile(r"клиент завершил|клиент покинул|client (has )?(ended|left)|клиент чаттан шықты|клиент қоңырауды аяқтады|"
                           r"соединение с клиентом прервано|клиентпен байланыс үзілді|connection to customer lost", re.I)
_ID_OK = re.compile(r"личност\S*\s+(клиента\s+)?подтвержд|жеке\s+басы\s+расталды|identity\s+(has\s+been\s+|was\s+)?(verified|confirmed)|"
                    r"идентификац\S*\s+(успешно\s+)?(пройден|подтвержд|выполнен)", re.I)
# Phrases that suggest a gross error. A hint and cross-check for the model, never a verdict.
_GROSS = [
    (re.compile(r"(переведите|перевести|скиньте|отправьте|киньте).{0,40}(мне|на мою|лично|на мой)", re.I), "деньги оператору лично"),
    (re.compile(r"(маған|менің карта).{0,30}(аударыңыз|жіберіңіз|салыңыз)", re.I), "деньги оператору лично"),
    (re.compile(r"(transfer|send).{0,30}(to me|my (personal )?(card|account))", re.I), "деньги оператору лично"),
    (re.compile(r"(личн\w* номер|whatsapp|телеграм|telegram|жеке нөмір|personal number).{0,80}(плат|частн|ақылы|charge|private)", re.I), "платная частная консультация"),
    (re.compile(r"(плат|частн|ақылы|charge|private).{0,80}(личн\w* номер|жеке нөмір|personal number)", re.I), "платная частная консультация"),
    (re.compile(r"(дурак|идиот|тупой|кретин|stupid|idiot|moron|ақымақ|читать (не )?умеете|совсем не понимаете)", re.I), "возможное оскорбление"),
]
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
    hold = consult = False
    for i, t in enumerate(turns):
        sec = None if raw[i] is None else raw[i] - t0
        text = t.get("text", "") or ""
        spk = (t.get("speaker") or "").lower()
        audio_sec = None
        if sec is not None:
            audio_sec = sec - paused_total - ((sec - pause_start) if pause_start is not None else 0.0)
        if spk == "system":
            if _HOLD_END.search(text):
                hold = False
            elif _HOLD_START.search(text):
                hold = True
            if _CONSULT_START.search(text):
                consult = True
            elif _CONSULT_END.search(text):
                consult = False
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
            "internal": spk == "operator" and (hold or consult),
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
    op = [t for t in turns if t["speaker"] == "operator" and not t.get("internal")]
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
    internal = [t["i"] for t in turns if t.get("internal")]
    if internal:
        f["internal_operator_turns"] = f"t{internal[0]}–t{internal[-1]} ({len(internal)} turns): client on hold, operator talks to a colleague — context only, do not evaluate"
    sys_t = [t for t in turns if t["speaker"] == "system"]
    for key, rx in (("closed_by_operator_turn", _OP_CLOSED), ("ended_by_client_turn", _CLIENT_ENDED), ("identity_confirmed_turn", _ID_OK)):
        hit = next((t["i"] for t in sys_t if rx.search(t["text"])), None)
        if hit is not None:
            f[key] = hit
    sig = [f"t{t['i']}: {why}" for t in op for rx, why in _GROSS if rx.search(t["text"])]
    if sig:
        f["possible_gross_error_signals"] = sorted(set(sig))
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


def audio_peaks(path: Path, buckets: int = 900) -> dict:
    """Max-abs amplitude per bucket (for a waveform), computed once with ffmpeg and cached."""
    import array
    import shutil
    import subprocess
    cache = path.with_suffix(f".peaks{buckets}.json")
    if cache.exists():
        return json.loads(cache.read_text())
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    pcm = array.array("h")
    pcm.frombytes(raw[: len(raw) // 2 * 2])
    n = len(pcm)
    step = max(1, n // buckets)
    peaks = [max((abs(x) for x in pcm[i:i + step]), default=0) / 32768 for i in range(0, n, step)][:buckets]
    out = {"duration": round(n / 8000, 2), "peaks": [round(p, 3) for p in peaks]}
    cache.write_text(json.dumps(out))
    return out

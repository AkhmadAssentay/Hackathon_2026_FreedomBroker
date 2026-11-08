"""Align transcript turns to Whisper word timestamps; speech metrics for calls.

Whisper (hpc/whisper_words.py, GPU) gives word-level times for the recording. Turns are
matched in order to the word stream (monotonic fuzzy matching), which replaces the
estimate from system timestamps with the real moment in the audio. From the aligned
turns we compute talk share, speech rate per speaker and the longest silence.
"""
from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path

from .datasource import AUDIO_DIR, audio_path

WORDS_DIR = AUDIO_DIR.parent / "words"


def _tok(s: str) -> list[str]:
    s = s.lower().replace("ё", "е")
    return [w for w in re.findall(r"[a-zа-яәғқңөұүһі0-9]+", s) if len(w) > 1]


def load_words(conv_id: str, audio_url: str) -> dict | None:
    stem = audio_path(conv_id, audio_url).stem
    p = WORDS_DIR / f"{stem}.words.json"
    return json.loads(p.read_text()) if p.exists() else None


def align(conv: dict, words: list[dict]) -> dict[int, dict]:
    """Global monotonic alignment: transcript tokens vs Whisper tokens (difflib matching blocks).
    A turn takes the time of its first..last matched token; turns with too few matches get no time."""
    a_tok, a_turn = [], []
    for t in conv["turns"]:
        if t["speaker"] in ("client", "operator", "bot"):
            for w in _tok(t["text"]):
                a_tok.append(w)
                a_turn.append(t["i"])
    b_tok, b_idx = [], []
    for j, w in enumerate(words):
        for x in _tok(w["w"]):
            b_tok.append(x)
            b_idx.append(j)
    hits: dict[int, list[int]] = {}
    sm = SequenceMatcher(None, a_tok, b_tok, autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            hits.setdefault(a_turn[blk.a + k], []).append(b_idx[blk.b + k])
    # fuzzy pass for tokens that differ only in spelling (ASR engines disagree): stem match of 5 chars
    out: dict[int, dict] = {}
    n_tok = {}
    for i in a_turn:
        n_tok[i] = n_tok.get(i, 0) + 1
    for i, js in hits.items():
        need = 1 if n_tok[i] <= 3 else 2
        if len(js) < need:
            continue
        js.sort()
        out[i] = {"start": words[js[0]]["s"], "end": words[js[-1]]["e"] or words[js[-1]]["s"],
                  "score": round(len(js) / n_tok[i], 2)}
    return out


def analysis(conv: dict) -> dict | None:
    if not conv.get("audio_url"):
        return None
    data = load_words(conv["conversation_id"], conv["audio_url"])
    if not data:
        return None
    words = [w for w in data["words"] if w.get("s") is not None]
    al = align(conv, words)
    turns = {t["i"]: t for t in conv["turns"]}
    talk = {"operator": 0.0, "client": 0.0, "bot": 0.0}
    nwords = {"operator": 0, "client": 0}
    for i, a in al.items():
        if turns[i].get("internal"):  # operator <-> colleague while the client is on hold
            continue
        spk = turns[i]["speaker"]
        dur = max(0.0, (a["end"] or a["start"]) - a["start"])
        talk[spk] = talk.get(spk, 0.0) + dur
        if spk in nwords:
            nwords[spk] += len(_tok(turns[i]["text"]))
    gaps = []
    for w0, w1 in zip(words, words[1:]):
        if w0.get("e") is not None and w1["s"] - w0["e"] > 0:
            gaps.append((round(w1["s"] - w0["e"], 1), round(w0["e"], 1)))
    gaps.sort(reverse=True)
    rate = {k: round(60 * nwords[k] / talk[k]) if talk.get(k, 0) > 5 else None for k in nwords}
    known = [(turns[i]["audio_t"], a["start"]) for i, a in al.items() if turns[i].get("audio_t") is not None]
    drift = round(sum(abs(x - y) for x, y in known) / len(known), 1) if known else None
    total_talk = talk["operator"] + talk["client"]
    return {
        "duration": round(data["duration"], 1),
        "aligned_turns": len(al), "aligned": {str(k): v for k, v in al.items()},
        "talk_seconds": {k: round(v, 1) for k, v in talk.items()},
        "operator_talk_share": round(talk["operator"] / total_talk, 2) if total_talk else None,
        "speech_rate_wpm": rate,
        "longest_silences": [{"seconds": g, "at": at} for g, at in gaps[:3]],
        "timestamp_estimate_error_sec": drift,
    }


WAIT_RX = re.compile(r"(минут|подожд|ожида|уточню|проверю|момент|посмотрю|секунд|күте тұрыңыз|тексеремін|wait|one moment|let me check|hold on)", re.I)


def whisper_turn_texts(conv: dict) -> dict[int, str]:
    """Second ASR hypothesis per turn: Whisper words that fall inside the turn's aligned time span."""
    data = load_words(conv["conversation_id"], conv["audio_url"]) if conv.get("audio_url") else None
    if not data:
        return {}
    words = [w for w in data["words"] if w.get("s") is not None]
    al = align(conv, words)
    out = {}
    for i, a in al.items():
        txt = " ".join(w["w"] for w in words if a["start"] - 0.2 <= w["s"] <= (a["end"] or a["start"]) + 0.2)
        if txt:
            out[i] = txt
    return out


def acoustic_facts(conv: dict, min_gap: float = 8.0) -> dict:
    """Measured from the recording (AudioJudge: audio LLMs are near chance on paralinguistics, so we give
    the judge measurements, not an audio model's opinion)."""
    a = analysis(conv)
    if not a:
        return {}
    data = load_words(conv["conversation_id"], conv["audio_url"])
    words = [w for w in data["words"] if w.get("s") is not None]
    al = {int(k): v for k, v in a["aligned"].items()}
    turns = {t["i"]: t for t in conv["turns"]}
    silences = []
    for w0, w1 in zip(words, words[1:]):
        gap = w1["s"] - (w0.get("e") or w0["s"])
        if gap < min_gap:
            continue
        at = w0.get("e") or w0["s"]
        before = [i for i, x in al.items() if (x["end"] or x["start"]) <= at + 0.5 and turns[i]["speaker"] == "operator"
                  and not turns[i].get("internal")]
        last_op = max(before) if before else None
        warned = bool(last_op is not None and WAIT_RX.search(turns[last_op]["text"]))
        silences.append({"seconds": round(gap, 1), "at_sec": round(at, 1), "after_operator_turn": last_op,
                         "operator_warned": warned})
    return {"operator_talk_share": a["operator_talk_share"], "speech_rate_wpm": a["speech_rate_wpm"],
            "long_silences": silences[:6]}

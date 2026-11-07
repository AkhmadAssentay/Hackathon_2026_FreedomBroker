"""LLM judge: prompt, providers (Claude API / local vLLM), evidence validator.

The model reads the transcript and points at turns; code checks every pointer.
One request evaluates a group of criteria (all of them normally, only the changed
one after a checklist edit); each criterion has its own schema slot, so answers
are constrained to that criterion's allowed values.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
from typing import Any

import httpx

from . import budget
from .scoring import allowed_answers

PROMPT_VERSION = "p4"  # part of the cache key: bump when prompt wording changes

SYSTEM = """You are a quality-assurance auditor for Freedom Broker customer support (a securities brokerage).
You evaluate ONLY the human operator (speaker = operator). Bot and system turns are context: system events
(escalation to an operator, identity verified, chat closed, connection lost, recording paused) are facts you may cite.
Client turns show what the client needed. Dialogues are in Russian, Kazakh or English, sometimes mixed.
Voice calls are speech-to-text output: never penalise recognition errors, masked data ([Имя скрыто]) or duplicated lines.

For every criterion, work in this order: (1) applicability — N/A only if the criterion allows it AND its N/A condition holds;
(2) evidence; (3) answer.

Evidence rules (checked by code — invalid citations are rejected):
- Cite turns by their number N from "[tN | ...]" and copy a short VERBATIM quote (max ~15 words) from that exact turn,
  in the original language, never translated or paraphrased.
- A positive answer ("yes", or a scale value above the minimum) must cite the operator or system turn that proves it.
- "no" means the action was needed but missing or wrong: set checked_span = [first, last] turn numbers you searched and
  expected_turn = the turn where the action was expected (e.g. the operator's first reply for a missing greeting).
  Cite the closest relevant turn as evidence when one exists.
- For answers other than "no", set checked_span to [] and expected_turn to -1.
- "na": na_reason_ru states which N/A condition holds; otherwise na_reason_ru is "".
- For a gross-error criterion "yes" means a violation EXISTS; "no" means none of the listed violations occurred
  (then checked_span covers the operator part of the dialogue and expected_turn is -1).
- explanation_ru and na_reason_ru: ALWAYS IN RUSSIAN, also for Kazakh and English dialogues (only quotes stay in the
  original language). 1–2 sentences, e.g. «Завершение — Нет. После ответа на вопрос оператор закрыл чат без прощания.
  Основание — последняя реплика оператора и сообщение о закрытии чата.»
- confidence: high if the transcript is unambiguous, medium if a reasonable reviewer could disagree, low if unsure.
"""


def _crit_block(c: dict, precedents: list[str]) -> str:
    kind = "шкала " + "/".join(str(s["value"]) for s in c["scale"]) if c["type"] == "scale" else "Да/Нет"
    lines = [
        f"### {c['id']} — {c['title']}",
        f"Type: {kind}{' (gross error flag, no points)' if c.get('gross') else ''}; weight {c.get('weight', 0)}; "
        f"N/A {'allowed' if c.get('na_allowed') else 'NOT allowed'}",
        f"Definition: {c['description']}",
    ]
    if c.get("na_allowed") and c.get("na_condition"):
        lines.append(f"N/A condition: {c['na_condition']}")
    if c["type"] == "scale":
        lines.append("Scale:")
        lines += [f"  {s['value']} — {s['label']}" for s in c["scale"]]
    lines.append("Allowed answers: " + " | ".join(allowed_answers(c)))
    if c.get("guidelines"):
        lines.append("Guidelines:")
        lines += [f"  - {g}" for g in c["guidelines"]]
    if precedents:
        lines.append("Reviewer decisions on earlier appeals (follow them in similar cases):")
        lines += [f"  - {p}" for p in precedents]
    return "\n".join(lines)


def render_transcript(conv: dict) -> str:
    out = []
    for t in conv["turns"]:
        ts = t["timestamp"] if conv["channel"] != "voice call" else _mmss(t["t"])
        out.append(f"[t{t['i']} | {ts} | {t['speaker']}] {t['text']}")
    return "\n".join(out)


def _mmss(sec):
    if sec is None:
        return "?"
    s = int(round(sec))
    return f"{s // 60:02d}:{s % 60:02d}"


def criterion_hash(c: dict, precedents: list[str]) -> str:
    keep = {k: c.get(k) for k in ("id", "title", "type", "weight", "na_allowed", "gross",
                                  "description", "na_condition", "scale", "guidelines")}
    s = json.dumps([PROMPT_VERSION, keep, precedents], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def schema_for(criteria: list[dict]) -> dict:
    props = {}
    for c in criteria:
        props[c["id"]] = {
            "type": "object",
            "properties": {
                "evidence": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"turn": {"type": "integer"}, "quote": {"type": "string"}},
                    "required": ["turn", "quote"], "additionalProperties": False}},
                "checked_span": {"type": "array", "items": {"type": "integer"}},
                "expected_turn": {"type": "integer"},
                "na_reason_ru": {"type": "string", "description": "на русском языке"},
                "explanation_ru": {"type": "string", "description": "1–2 предложения на русском языке"},
                "answer": {"type": "string", "enum": allowed_answers(c)},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            },
            "required": ["evidence", "checked_span", "expected_turn", "na_reason_ru", "explanation_ru",
                         "answer", "confidence"],
            "additionalProperties": False,
        }
    return {"type": "object", "properties": props, "required": [c["id"] for c in criteria],
            "additionalProperties": False}


def build_messages(conv: dict, facts: dict, criteria: list[dict], precedents: dict[str, list[str]],
                   repair_note: str = "") -> tuple[str, str]:
    system = SYSTEM + "\n## Criteria to evaluate\n\n" + "\n\n".join(
        _crit_block(c, precedents.get(c["id"], [])) for c in criteria)
    user = ("## Facts computed from timestamps (reliable)\n" + json.dumps(facts, ensure_ascii=False, indent=1)
            + f"\n\n## Transcript ({conv['conversation_id']}, {conv['channel']}, {conv['language']})\n"
            + render_transcript(conv)
            + "\n\nEvaluate the operator on every criterion above. Write every explanation_ru and na_reason_ru in Russian "
              "(даже если диалог на казахском или английском); quotes stay verbatim. Return JSON only.")
    if repair_note:
        user += "\n\n## Your previous answer failed validation — fix exactly these problems:\n" + repair_note
    return system, user


# ------------------------------------------------------------------ providers

class Provider:
    name = "base"
    model = ""

    def complete(self, system: str, user: str, schema: dict, conv_id: str, purpose: str) -> dict:
        raise NotImplementedError


class ClaudeProvider(Provider):
    name = "claude"

    def __init__(self, model: str | None = None, effort: str = "low", max_tokens: int = 8000):
        import anthropic  # lazy: the local-only setup does not need it
        self.model = model or os.environ.get("CLAUDE_MODEL", "claude-sonnet-5-5")
        self.effort = effort
        self.max_tokens = max_tokens
        self.client = anthropic.Anthropic(max_retries=3, timeout=180)

    def complete(self, system, user, schema, conv_id, purpose):
        est_in = int((len(system) + len(user)) / 2.0) + 200  # conservative for Cyrillic/Kazakh
        reserved = budget.reserve(self.model, est_in, self.max_tokens)
        try:
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user}],
                output_config={"effort": self.effort,
                               "format": {"type": "json_schema", "schema": schema}},
            )
        finally:
            budget.release(reserved)
        u = resp.usage
        usage = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
                 "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
                 "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0}
        cost = budget.record("claude", self.model, usage, purpose, conv_id)
        if resp.stop_reason == "refusal":
            raise RuntimeError("model refused")
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("output truncated (max_tokens)")
        text = next(b.text for b in resp.content if b.type == "text")
        return {"data": json.loads(text), "usage": usage, "cost_usd": cost}


class LocalProvider(Provider):
    """vLLM OpenAI-compatible server (HPC, via SSH tunnel). Free; data stays on-prem."""
    name = "local"

    def __init__(self, base_url: str | None = None, model: str | None = None, max_tokens: int = 6000):
        self.base = (base_url or os.environ.get("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8001/v1")).rstrip("/")
        self.served = model or os.environ.get("LOCAL_LLM_MODEL", "local-judge")
        self.key = os.environ.get("LOCAL_LLM_API_KEY", "")
        self.max_tokens = max_tokens
        self.model = f"local:{self._real_name()}"

    def _real_name(self) -> str:
        try:
            r = httpx.get(f"{self.base}/models", headers={"Authorization": f"Bearer {self.key}"}, timeout=5)
            data = r.json().get("data", [])
            root = data[0].get("root") if data else None
            return (root or self.served).split("/")[-1]
        except Exception:
            return self.served

    def complete(self, system, user, schema, conv_id, purpose):
        body = {
            "model": self.served, "temperature": 0, "max_tokens": self.max_tokens,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "cqa_eval", "schema": schema, "strict": True}},
            "chat_template_kwargs": {"enable_thinking": False},
        }
        last_err = None
        for attempt in range(2):  # retry once on malformed / truncated JSON
            if attempt:
                body["temperature"] = 0.3
            r = httpx.post(f"{self.base}/chat/completions", json=body, timeout=600,
                           headers={"Authorization": f"Bearer {self.key}"})
            r.raise_for_status()
            js = r.json()
            u = js.get("usage", {})
            usage = {"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)}
            budget.record("local", self.model, usage, purpose, conv_id)
            text = js["choices"][0]["message"]["content"]
            text = re.sub(r"^```(?:json)?|```$", "", text.strip()).strip()
            try:
                return {"data": json.loads(text), "usage": usage, "cost_usd": 0.0}
            except json.JSONDecodeError as e:
                last_err = e
        raise RuntimeError(f"local model returned invalid JSON twice: {last_err}")


def get_provider(name: str | None = None, model: str | None = None) -> Provider:
    name = name or os.environ.get("DEFAULT_PROVIDER", "claude")
    if name == "local":
        return LocalProvider()
    return ClaudeProvider(model=model)


# ------------------------------------------------------------------ validator

def _norm(s: str) -> str:
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[«»\"'“”„`…\.,!?;:()\[\]—–-]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def quote_matches(quote: str, text: str) -> bool:
    q, t = _norm(quote), _norm(text)
    if not q:
        return False
    if q in t:
        return True
    m = difflib.SequenceMatcher(None, q, t, autojunk=False).find_longest_match(0, len(q), 0, len(t))
    return m.size >= max(8, int(0.8 * len(q)))


def validate(crit: dict, res: dict, conv: dict) -> tuple[dict, list[str]]:
    """Check (and where safe, repair) one criterion result. Returns (result, errors)."""
    for k in ("explanation", "na_reason"):
        if f"{k}_ru" in res:
            res[k] = res.pop(f"{k}_ru")
    turns = conv["turns"]
    n = len(turns)
    errs: list[str] = []
    notes: list[str] = []
    ans = res.get("answer")
    if ans not in allowed_answers(crit):
        errs.append(f"answer '{ans}' not allowed")

    good_ev = []
    for ev in res.get("evidence", []):
        ti, quote = ev.get("turn"), ev.get("quote", "")
        if isinstance(ti, int) and 0 <= ti < n and quote_matches(quote, turns[ti]["text"]):
            good_ev.append({"turn": ti, "quote": quote, "speaker": turns[ti]["speaker"]})
            continue
        # off-by-one / wrong turn number: re-point to the turn that really contains the quote
        hit = next((t["i"] for t in turns if quote_matches(quote, t["text"])), None)
        if hit is not None:
            good_ev.append({"turn": hit, "quote": quote, "speaker": turns[hit]["speaker"]})
            notes.append(f"evidence t{ti}→t{hit} corrected by validator")
        else:
            errs.append(f"quote not found in transcript: t{ti} «{quote[:60]}»")
    res["evidence"] = good_ev

    positive = (ans == "yes") if crit["type"] != "scale" else (
        ans not in ("na", None) and float(ans) > min(float(s["value"]) for s in crit["scale"]))
    if positive and not any(e["speaker"] in ("operator", "system") for e in good_ev):
        errs.append("positive answer needs at least one operator/system turn as evidence")

    if ans == "no" and not crit.get("gross"):
        span = res.get("checked_span") or []
        exp = res.get("expected_turn", -1)
        if len(span) != 2 or not all(isinstance(x, int) and 0 <= x < n for x in span) or span[0] > span[1]:
            errs.append("'no' needs checked_span [first,last] with valid turn numbers")
        elif not (isinstance(exp, int) and span[0] <= exp <= span[1]):
            errs.append("'no' needs expected_turn inside checked_span")
    if ans == "na" and not (res.get("na_reason") or "").strip():
        errs.append("'na' needs na_reason")
    if not (res.get("explanation") or "").strip():
        errs.append("explanation is empty")

    res["validator_notes"] = notes
    return res, errs


# ------------------------------------------------------------------ language guard

_KZ = re.compile(r"[әғқңөұүһі]", re.I)


def needs_russian(text: str) -> bool:
    """True if the text (outside «quotes») is Kazakh or mostly Latin, i.e. not Russian."""
    t = re.sub(r"«[^»]*»|\"[^\"]*\"", " ", text or "")
    if _KZ.search(t):
        return True
    lat, cyr = len(re.findall(r"[a-z]", t, re.I)), len(re.findall(r"[а-яё]", t, re.I))
    return lat > 40 and lat > cyr


TRANSLATE_SYSTEM = ("Ты переводчик. Переведи каждое поле на русский язык. Цитаты в кавычках «…», номера реплик "
                    "(t5), названия разделов приложения и тикеры оставь без изменений. Сохраняй смысл, ничего не добавляй.")


def translate_to_russian(prov: "Provider", items: dict[str, dict], conv_id: str) -> dict[str, dict]:
    """items: cid -> {explanation, na_reason}. Returns the same shape in Russian."""
    props = {cid: {"type": "object",
                   "properties": {"explanation_ru": {"type": "string"}, "na_reason_ru": {"type": "string"}},
                   "required": ["explanation_ru", "na_reason_ru"], "additionalProperties": False}
             for cid in items}
    schema = {"type": "object", "properties": props, "required": list(items), "additionalProperties": False}
    user = "Переведи на русский язык:\n" + json.dumps(
        {cid: {"explanation": v.get("explanation", ""), "na_reason": v.get("na_reason", "")} for cid, v in items.items()},
        ensure_ascii=False, indent=1)
    out = prov.complete(TRANSLATE_SYSTEM, user, schema, conv_id, "translate")
    return {cid: {"explanation": d.get("explanation_ru", ""), "na_reason": d.get("na_reason_ru", "")}
            for cid, d in out["data"].items()}, out["cost_usd"]

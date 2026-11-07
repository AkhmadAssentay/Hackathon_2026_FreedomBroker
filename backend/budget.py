"""Spend ledger with a hard cap for paid API calls (Claude).

Every paid call is recorded in SQLite with its real token usage. Before a call we
reserve its worst case (estimated input + max_tokens output); if that could cross
CLAUDE_BUDGET_USD the call is refused. Prices: USD per 1M tokens (Anthropic list
prices, Nov 2026).
"""
from __future__ import annotations

import os
import threading

from . import db

PRICES = {  # input, output, cache_read, cache_write(5m)
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-opus-5-5": (4.00, 20.00, 0.40, 5.00),
}

_lock = threading.Lock()
_reserved = 0.0


class BudgetExceeded(RuntimeError):
    pass


def cap() -> float:
    return float(os.environ.get("CLAUDE_BUDGET_USD", "4.50"))


def spent() -> float:
    r = db.q1("SELECT COALESCE(SUM(cost_usd),0) AS s FROM api_calls WHERE provider='claude'")
    return float(r["s"]) if r else 0.0


def cost(model: str, inp: int, out: int, cache_read: int = 0, cache_write: int = 0) -> float:
    pi, po, pr, pw = PRICES.get(model, PRICES["claude-opus-5-5"])
    return (inp * pi + out * po + cache_read * pr + cache_write * pw) / 1e6


def reserve(model: str, est_input_tokens: int, max_tokens: int) -> float:
    global _reserved
    worst = cost(model, est_input_tokens, max_tokens)
    with _lock:
        if spent() + _reserved + worst > cap():
            raise BudgetExceeded(
                f"Claude budget cap ${cap():.2f} reached (spent ${spent():.4f}); call refused")
        _reserved += worst
    return worst


def release(amount: float) -> None:
    global _reserved
    with _lock:
        _reserved = max(0.0, _reserved - amount)


def record(provider: str, model: str, usage: dict, purpose: str, conv_id: str = "") -> float:
    c = 0.0
    if provider == "claude":
        c = cost(model, usage.get("input_tokens", 0), usage.get("output_tokens", 0),
                 usage.get("cache_read", 0), usage.get("cache_write", 0))
    db.ex("INSERT INTO api_calls(ts,provider,model,input_tokens,output_tokens,cache_read,cache_write,cost_usd,purpose,conv_id)"
          " VALUES (?,?,?,?,?,?,?,?,?,?)",
          (db.now(), provider, model, usage.get("input_tokens", 0), usage.get("output_tokens", 0),
           usage.get("cache_read", 0), usage.get("cache_write", 0), c, purpose, conv_id))
    return c


def summary() -> dict:
    rows = db.q("SELECT provider, model, COUNT(*) n, SUM(input_tokens) inp, SUM(output_tokens) out,"
                " SUM(cache_read) cr, SUM(cost_usd) cost, COUNT(DISTINCT conv_id) convs"
                " FROM api_calls GROUP BY provider, model")
    return {"cap_usd": cap(), "spent_usd": round(spent(), 4), "by_model": rows}

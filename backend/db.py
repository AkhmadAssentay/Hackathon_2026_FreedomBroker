"""SQLite storage. Evaluations are immutable; appeals/decisions are stored next to them."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .datasource import DATA

DB_PATH = DATA / "cqa.db"
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, cid TEXT, group_id TEXT, channel TEXT, language TEXT,
  audio_url TEXT, conv_json TEXT, thash TEXT, fetched_at REAL
);
CREATE TABLE IF NOT EXISTS checklists (
  version INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, note TEXT,
  json TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS criterion_cache (
  conv_id TEXT, thash TEXT, chash TEXT, model TEXT, result_json TEXT, created_at REAL,
  PRIMARY KEY (conv_id, thash, chash, model)
);
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT, checklist_version INTEGER,
  model TEXT, result_json TEXT, score_json TEXT, created_at REAL
);
CREATE INDEX IF NOT EXISTS ev_conv ON evaluations(conv_id);
CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, evaluation_id INTEGER, criterion_id TEXT,
  comment TEXT, author TEXT, created_at REAL, status TEXT DEFAULT 'open',
  decision TEXT, new_answer TEXT, reason TEXT, reviewer TEXT, decided_at REAL
);
CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, provider TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_usd REAL, purpose TEXT, conv_id TEXT
);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    with _lock:
        con = connect()
        try:
            yield con
            con.commit()
        finally:
            con.close()


def init() -> None:
    with tx() as con:
        con.executescript(SCHEMA)


def q(sql: str, args: tuple = ()) -> list[dict[str, Any]]:
    with tx() as con:
        return [dict(r) for r in con.execute(sql, args).fetchall()]


def q1(sql: str, args: tuple = ()) -> dict[str, Any] | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def ex(sql: str, args: tuple = ()) -> int:
    with tx() as con:
        cur = con.execute(sql, args)
        return cur.lastrowid


def now() -> float:
    return time.time()


def dumps(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False, sort_keys=True)

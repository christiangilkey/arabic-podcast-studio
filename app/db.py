"""SQLite storage: schema, migrations and connection helpers.

A fresh connection is opened per unit of work (cheap for SQLite) so request threads and
the background worker never share a connection. WAL mode lets readers proceed while the
worker writes a transcript.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import paths

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS feeds (
    id              INTEGER PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    image           TEXT,
    link            TEXT,
    auto_transcribe INTEGER NOT NULL DEFAULT 0,
    last_checked    REAL,
    last_error      TEXT,
    etag            TEXT,
    modified        TEXT,
    created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
    id             INTEGER PRIMARY KEY,
    feed_id        INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid           TEXT NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    published      REAL,
    duration       REAL,
    image          TEXT,
    audio_url      TEXT NOT NULL,
    audio_type     TEXT,
    audio_path     TEXT,
    status         TEXT NOT NULL DEFAULT 'new',
    progress       REAL NOT NULL DEFAULT 0,
    error          TEXT,
    model          TEXT,
    transcribed_at REAL,
    created_at     REAL NOT NULL,
    UNIQUE(feed_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_episodes_feed ON episodes(feed_id, published DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);

CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY,
    episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    state       TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
    error       TEXT,
    created_at  REAL NOT NULL,
    started_at  REAL,
    finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, created_at);

CREATE TABLE IF NOT EXISTS segments (
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    start      REAL NOT NULL,
    end        REAL NOT NULL,
    text       TEXT NOT NULL,
    norm       TEXT NOT NULL,
    PRIMARY KEY (episode_id, idx)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS words (
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    seg_idx    INTEGER NOT NULL,
    start      REAL NOT NULL,
    end        REAL NOT NULL,
    text       TEXT NOT NULL,
    prob       REAL,
    PRIMARY KEY (episode_id, idx)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
    norm, episode_id UNINDEXED, seg_idx UNINDEXED, tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS vocab (
    id         INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
    text       TEXT NOT NULL,
    norm       TEXT NOT NULL,
    sentence   TEXT NOT NULL DEFAULT '',
    start      REAL,
    end        REAL,
    sent_start REAL,
    sent_end   REAL,
    meaning    TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    episode_title TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- AI word definitions, cached per (word, marked sentence, explanation language).
CREATE TABLE IF NOT EXISTS definitions (
    key        TEXT PRIMARY KEY,
    word       TEXT NOT NULL,
    sentence   TEXT NOT NULL,
    data       TEXT NOT NULL,
    provider   TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
"""

_init_lock = threading.Lock()
_initialized: set[Path] = set()


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or paths.db_path()
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def init_db(path: Path | None = None) -> None:
    path = path or paths.db_path()
    with _init_lock:
        conn = connect(path)
        try:
            conn.executescript(SCHEMA)
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            if current < SCHEMA_VERSION:
                # Future migrations go here, keyed on `current`.
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.commit()
        finally:
            conn.close()
        _initialized.add(path)


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    """Connection that commits on success and rolls back on error."""
    path = paths.db_path()
    if path not in _initialized:
        init_db(path)
    conn = connect(path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


# --- settings -------------------------------------------------------------------------

DEFAULT_SETTINGS: dict[str, Any] = {
    "model_size": None,             # chosen during first-run setup
    "delete_audio_after": False,    # delete local audio once transcribed
    "stream_from_source": False,    # play from the original URL; audio is only kept temporarily
    "theme": "system",              # system | light | dark
    "font_size": 26,                # transcript font size in px
    "welcome_seen": False,
    "beam_size": 5,
    # AI word definitions (users bring their own API key).
    "definer_provider": "claude",
    "definer_language": "English",
    "definer_model_claude": "",
    "definer_model_gemini": "",
    "definer_model_openai": "",
    "definer_model_grok": "",
    "llm_key_claude": "",
    "llm_key_gemini": "",
    "llm_key_openai": "",
    "llm_key_grok": "",
}

# Settings that hold secrets: never exported in backups.
SECRET_SETTINGS = ("llm_key_claude", "llm_key_gemini", "llm_key_openai", "llm_key_grok")


def get_settings() -> dict[str, Any]:
    with session() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except json.JSONDecodeError:
            continue
    return out


def get_setting(key: str) -> Any:
    return get_settings().get(key)


def set_settings(values: dict[str, Any]) -> dict[str, Any]:
    with session() as conn:
        for key, value in values.items():
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )
    return get_settings()

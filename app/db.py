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

SCHEMA_VERSION = 3

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
    kind       TEXT,           -- imported web pages: h1 | h2 | h3 | p | li | q
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
    -- clip (added by migration): 1 when the word has its own audio clip (it was shared by a
    -- friend), stored as clips/<uid>.ogg; start/end/sent_start/sent_end are then times
    -- inside that clip instead of inside an episode.
);

-- Vocab folders (schema v3). A word can be in several: vocab.folders holds a JSON list of folder uids.
CREATE TABLE IF NOT EXISTS vocab_folders (
    id         INTEGER PRIMARY KEY,
    uid        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL
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
            _migrate(conn)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.commit()
        finally:
            conn.close()
        _initialized.add(path)


# --- migrations ----------------------------------------------------------------------------

NOW_SQL = "((julianday('now') - 2440587.5) * 86400.0)"

# Sync columns (schema v2). Added idempotently so old and new databases converge.
_SYNC_COLUMNS = {
    "feeds": [("uid", "TEXT"), ("updated_at", "REAL"), ("deleted", "INTEGER NOT NULL DEFAULT 0")],
    "episodes": [("uid", "TEXT"), ("updated_at", "REAL"), ("transcribe_requested_at", "REAL"),
                 ("remote_audio", "INTEGER NOT NULL DEFAULT 0"), ("synced_rev", "REAL"),
                 ("sync_audio_path", "TEXT"), ("deleted", "INTEGER NOT NULL DEFAULT 0")],
    "vocab": [("uid", "TEXT"), ("updated_at", "REAL"), ("deleted", "INTEGER NOT NULL DEFAULT 0"),
              ("episode_uid", "TEXT"), ("folders", "TEXT NOT NULL DEFAULT '[]'"),
              ("clip", "INTEGER NOT NULL DEFAULT 0")],
    "segments": [("kind", "TEXT")],
}

# updated_at is bumped automatically whenever a synced field changes locally. Sync writes
# run inside `sync_writes()`, which parks a row in sync_guard for the length of their own
# transaction so the triggers stand down (no other connection ever sees that row).
_TRIGGER_NAMES = ("feeds_ins", "feeds_upd", "episodes_ins", "episodes_upd", "vocab_ins", "vocab_upd",
                  "folders_ins", "folders_upd")
_TRIGGERS = f"""
CREATE TABLE IF NOT EXISTS sync_guard (active INTEGER);
CREATE TRIGGER IF NOT EXISTS feeds_ins AFTER INSERT ON feeds WHEN NEW.updated_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_guard)
BEGIN UPDATE feeds SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS feeds_upd AFTER UPDATE ON feeds
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM sync_guard) AND (NEW.auto_transcribe IS NOT OLD.auto_transcribe
  OR NEW.deleted IS NOT OLD.deleted OR NEW.title IS NOT OLD.title OR NEW.image IS NOT OLD.image)
BEGIN UPDATE feeds SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS episodes_ins AFTER INSERT ON episodes WHEN NEW.updated_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_guard)
BEGIN UPDATE episodes SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS episodes_upd AFTER UPDATE ON episodes
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM sync_guard) AND (NEW.title IS NOT OLD.title OR NEW.audio_url IS NOT OLD.audio_url
  OR NEW.duration IS NOT OLD.duration OR NEW.transcribe_requested_at IS NOT OLD.transcribe_requested_at
  OR NEW.synced_rev IS NOT OLD.synced_rev OR NEW.remote_audio IS NOT OLD.remote_audio OR NEW.deleted IS NOT OLD.deleted)
BEGIN UPDATE episodes SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS vocab_ins AFTER INSERT ON vocab WHEN NEW.updated_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_guard)
BEGIN UPDATE vocab SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS vocab_upd AFTER UPDATE ON vocab
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM sync_guard) AND (NEW.text IS NOT OLD.text OR NEW.meaning IS NOT OLD.meaning
  OR NEW.notes IS NOT OLD.notes OR NEW.deleted IS NOT OLD.deleted OR NEW.folders IS NOT OLD.folders
  OR NEW.clip IS NOT OLD.clip)
BEGIN UPDATE vocab SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS folders_ins AFTER INSERT ON vocab_folders WHEN NEW.updated_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_guard)
BEGIN UPDATE vocab_folders SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS folders_upd AFTER UPDATE ON vocab_folders
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM sync_guard) AND (NEW.name IS NOT OLD.name OR NEW.deleted IS NOT OLD.deleted)
BEGIN UPDATE vocab_folders SET updated_at = {NOW_SQL} WHERE id = NEW.id; END;
"""


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn: sqlite3.Connection) -> None:
    from . import ids

    for table, cols in _SYNC_COLUMNS.items():
        have = _columns(conn, table)
        for name, decl in cols:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    for name in _TRIGGER_NAMES:  # recreate so trigger changes in new versions take effect
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")
    conn.executescript(_TRIGGERS)
    conn.execute("DELETE FROM sync_guard")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_uid ON feeds(uid)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_uid ON episodes(uid)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_uid ON vocab(uid)")

    # Backfill global ids for rows created before sync existed.
    for row in conn.execute("SELECT id, url, created_at FROM feeds WHERE uid IS NULL").fetchall():
        conn.execute("UPDATE feeds SET uid = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?",
                     (ids.feed_uid(row[1]), row[2], row[0]))
    for row in conn.execute(
        "SELECT e.id, f.uid, e.guid, e.created_at FROM episodes e JOIN feeds f ON f.id = e.feed_id WHERE e.uid IS NULL"
    ).fetchall():
        conn.execute("UPDATE episodes SET uid = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?",
                     (ids.episode_uid(row[1], row[2]), row[3], row[0]))
    for row in conn.execute(
        "SELECT v.id, v.created_at, e.uid FROM vocab v LEFT JOIN episodes e ON e.id = v.episode_id WHERE v.uid IS NULL"
    ).fetchall():
        conn.execute("UPDATE vocab SET uid = ?, updated_at = COALESCE(updated_at, ?), episode_uid = ? WHERE id = ?",
                     (ids.new_uid(), row[1], row[2], row[0]))


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


@contextmanager
def sync_writes(conn: sqlite3.Connection) -> Iterator[None]:
    """Within this block, writes keep the updated_at values they set (no trigger bumps)."""
    conn.execute("INSERT INTO sync_guard(active) VALUES(1)")
    try:
        yield
    finally:
        conn.execute("DELETE FROM sync_guard")


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
    # Google Drive sync.
    "google_refresh_token": "",
    "google_email": "",
    "sync_audio": True,             # upload compressed audio copies so other devices play identical audio
    "device_id": "",
}

# Settings that hold secrets: never exported in backups.
SECRET_SETTINGS = ("llm_key_claude", "llm_key_gemini", "llm_key_openai", "llm_key_grok",
                   "google_refresh_token")


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

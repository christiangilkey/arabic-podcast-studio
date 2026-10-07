"""Feed subscription endpoints."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db, feeds, paths, sync

router = APIRouter(prefix="/feeds", tags=["feeds"])
_refresh_lock = threading.Lock()


class FeedIn(BaseModel):
    url: str


class FeedPatch(BaseModel):
    auto_transcribe: bool | None = None


@router.get("")
def list_feeds() -> list[dict[str, Any]]:
    with db.session() as conn:
        rows = conn.execute(
            """SELECT f.*,
                      COUNT(e.id) AS episode_count,
                      SUM(e.status = 'done') AS done_count,
                      MAX(e.published) AS latest
               FROM feeds f LEFT JOIN episodes e ON e.feed_id = f.id
               WHERE f.deleted = 0
               GROUP BY f.id ORDER BY f.title COLLATE NOCASE"""
        ).fetchall()
    return db.rows_to_dicts(rows)


@router.post("")
def add_feed(body: FeedIn) -> dict[str, Any]:
    if not body.url.strip():
        raise HTTPException(400, "Paste an RSS feed URL.")
    try:
        feed = feeds.add_feed(body.url)
        sync.request()
        return feed
    except feeds.FeedError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/{feed_id}")
def update_feed(feed_id: int, body: FeedPatch) -> dict[str, Any]:
    with db.session() as conn:
        if body.auto_transcribe is not None:
            conn.execute("UPDATE feeds SET auto_transcribe = ? WHERE id = ?", (int(body.auto_transcribe), feed_id))
        row = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Feed not found.")
    sync.request()
    return dict(row)


@router.delete("/{feed_id}")
def delete_feed(feed_id: int) -> dict[str, bool]:
    from .. import jobs

    with db.session() as conn:
        eps = conn.execute("SELECT id, audio_path, sync_audio_path FROM episodes WHERE feed_id = ?",
                           (feed_id,)).fetchall()
    for ep in eps:
        jobs.cancel(ep["id"])
    with db.session() as conn:
        for ep in eps:
            conn.execute("DELETE FROM segments_fts WHERE episode_id = ?", (ep["id"],))
        conn.execute("DELETE FROM episodes WHERE feed_id = ?", (feed_id,))
        # Keep a tombstone so the deletion reaches other devices through sync.
        conn.execute("UPDATE feeds SET deleted = 1, etag = NULL, modified = NULL WHERE id = ?", (feed_id,))
    audio_root = paths.audio_dir().resolve()
    for ep in eps:
        for stored in (ep["audio_path"], ep["sync_audio_path"]):
            if stored:
                p = Path(stored)
                if p.resolve().parent == audio_root:
                    p.unlink(missing_ok=True)
    sync.request()
    return {"ok": True}


@router.post("/refresh")
def refresh(feed_id: int | None = None) -> dict[str, Any]:
    if not _refresh_lock.acquire(blocking=False):
        return {"ok": True, "already_running": True}
    try:
        if feed_id is not None:
            new = len(feeds.refresh_feed(feed_id))
        else:
            new = feeds.refresh_all()
    finally:
        _refresh_lock.release()
    return {"ok": True, "new_episodes": new}


def refresh_in_background() -> None:
    def run() -> None:
        if _refresh_lock.acquire(blocking=False):
            try:
                feeds.refresh_all()
            finally:
                _refresh_lock.release()

    threading.Thread(target=run, name="feed-refresh", daemon=True).start()

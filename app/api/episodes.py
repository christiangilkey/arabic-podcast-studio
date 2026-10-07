"""Episode listing, transcription control, transcripts, audio and exports."""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from pydantic import BaseModel

from .. import db, exporters, jobs

router = APIRouter(tags=["episodes"])

STATUS_FILTERS = {
    "new": ("new",),
    "queued": ("queued",),
    "active": ("downloading", "transcribing"),
    "done": ("done",),
    "failed": ("failed",),
}


class TranscribeIn(BaseModel):
    ids: list[int]


def _episode(episode_id: int) -> dict[str, Any]:
    with db.session() as conn:
        row = conn.execute(
            "SELECT e.*, f.title AS feed_title, f.image AS feed_image FROM episodes e "
            "JOIN feeds f ON f.id = e.feed_id WHERE e.id = ?",
            (episode_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "Episode not found.")
    return dict(row)


@router.get("/episodes")
def list_episodes(feed_id: int | None = None, status: str | None = None, q: str | None = None,
                  limit: int = 100, offset: int = 0) -> dict[str, Any]:
    where, args = [], []
    if feed_id is not None:
        where.append("e.feed_id = ?")
        args.append(feed_id)
    if status and status in STATUS_FILTERS:
        values = STATUS_FILTERS[status]
        where.append(f"e.status IN ({','.join('?' * len(values))})")
        args.extend(values)
    if q:
        where.append("e.title LIKE ?")
        args.append(f"%{q}%")
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    limit = max(1, min(limit, 500))
    with db.session() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM episodes e {clause}", args).fetchone()[0]
        rows = conn.execute(
            f"""SELECT e.id, e.feed_id, e.title, e.published, e.duration, e.image, e.status, e.progress,
                       e.error, e.audio_path IS NOT NULL AS has_audio, f.title AS feed_title, f.image AS feed_image
                FROM episodes e JOIN feeds f ON f.id = e.feed_id {clause}
                ORDER BY COALESCE(e.published, e.created_at) DESC, e.id DESC LIMIT ? OFFSET ?""",
            [*args, limit, offset],
        ).fetchall()
        counts = dict(conn.execute(
            f"SELECT e.status, COUNT(*) FROM episodes e {'WHERE e.feed_id = ?' if feed_id is not None else ''} "
            "GROUP BY e.status", [feed_id] if feed_id is not None else []).fetchall())
    return {"total": total, "items": db.rows_to_dicts(rows), "counts": counts,
            "current": jobs.worker.current_episode}


@router.get("/episodes/{episode_id}")
def get_episode(episode_id: int) -> dict[str, Any]:
    return _episode(episode_id)


@router.post("/episodes/transcribe")
def transcribe(body: TranscribeIn) -> dict[str, Any]:
    return {"queued": jobs.enqueue(body.ids)}


@router.post("/episodes/{episode_id}/cancel")
def cancel(episode_id: int) -> dict[str, bool]:
    jobs.cancel(episode_id)
    return {"ok": True}


@router.get("/episodes/{episode_id}/transcript")
def transcript(episode_id: int) -> dict[str, Any]:
    ep = _episode(episode_id)
    with db.session() as conn:
        segs = conn.execute("SELECT idx, start, end, text FROM segments WHERE episode_id = ? ORDER BY idx",
                            (episode_id,)).fetchall()
        words = conn.execute("SELECT start, end, text, seg_idx FROM words WHERE episode_id = ? ORDER BY idx",
                             (episode_id,)).fetchall()
    # Columnar layout keeps a 10k-word payload small and lets the client build typed arrays directly.
    return {
        "episode": ep,
        "segments": db.rows_to_dicts(segs),
        "words": {
            "start": [round(w["start"], 3) for w in words],
            "end": [round(w["end"], 3) for w in words],
            "text": [w["text"] for w in words],
            "seg": [w["seg_idx"] for w in words],
        },
    }


@router.get("/episodes/{episode_id}/audio")
def episode_audio(episode_id: int) -> Response:
    ep = _episode(episode_id)
    if ep["audio_path"] and Path(ep["audio_path"]).exists():
        path = Path(ep["audio_path"])
        media = ep["audio_type"] or mimetypes.guess_type(path.name)[0] or "audio/mpeg"
        return FileResponse(path, media_type=media)  # supports HTTP Range for seeking
    return RedirectResponse(ep["audio_url"], status_code=307)


def _safe_filename(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", title).strip()
    return (name or "transcript")[:120]


@router.get("/episodes/{episode_id}/export/{fmt}")
def export(episode_id: int, fmt: str) -> Response:
    ep = _episode(episode_id)
    with db.session() as conn:
        segs = db.rows_to_dicts(conn.execute(
            "SELECT start, end, text FROM segments WHERE episode_id = ? ORDER BY idx", (episode_id,)).fetchall())
    if not segs:
        raise HTTPException(404, "This episode has no transcript yet.")
    if fmt == "txt":
        body, media = exporters.to_txt(segs, ep["title"]), "text/plain"
    elif fmt == "srt":
        body, media = exporters.to_srt(segs), "application/x-subrip"
    elif fmt == "vtt":
        body, media = exporters.to_vtt(segs), "text/vtt"
    else:
        raise HTTPException(400, "Format must be txt, srt or vtt.")
    filename = f"{_safe_filename(ep['title'])}.{fmt}"
    from urllib.parse import quote

    return PlainTextResponse(body, media_type=f"{media}; charset=utf-8",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})


@router.get("/jobs")
def job_queue() -> dict[str, Any]:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT j.id, j.episode_id, j.state, j.created_at, e.title FROM jobs j "
            "JOIN episodes e ON e.id = j.episode_id WHERE j.state IN ('queued','running') "
            "ORDER BY j.created_at, j.id").fetchall()
    return {"jobs": db.rows_to_dicts(rows), "current": jobs.worker.current_episode}

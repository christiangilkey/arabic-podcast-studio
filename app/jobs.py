"""Persistent transcription queue with a single background worker.

Jobs live in SQLite, so the queue survives restarts. Anything left 'running' from a
previous session (crash or quit mid-transcription) is reset to 'queued' and its partial
transcript discarded, then picked up again in order.
"""

from __future__ import annotations

import logging
import threading
import time
import traceback
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from . import arabic, audio, db, downloader, events, paths, sync, transcriber, videos
from .transcriber import Segment, TranscriptionCancelled

log = logging.getLogger(__name__)

ACTIVE_STATUSES = ("queued", "downloading", "transcribing")


class Worker:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._cancel_current = threading.Event()
        self._current_episode: int | None = None
        self._thread: threading.Thread | None = None

    # --- lifecycle ----------------------------------------------------------------------
    def start(self) -> None:
        recover()
        self._thread = threading.Thread(target=self._run, name="transcribe-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._cancel_current.set()
        self._wake.set()

    def wake(self) -> None:
        self._wake.set()

    def cancel_episode(self, episode_id: int) -> None:
        if self._current_episode == episode_id:
            self._cancel_current.set()

    @property
    def current_episode(self) -> int | None:
        return self._current_episode

    # --- loop ---------------------------------------------------------------------------
    def _run(self) -> None:
        while not self._stop.is_set():
            job = _claim_next()
            if job is None:
                self._wake.wait(timeout=5)
                self._wake.clear()
                continue
            self._current_episode = job["episode_id"]
            self._cancel_current.clear()
            try:
                _process(job, self._cancel_current)
            except Exception:  # never let the worker thread die
                log.exception("Unexpected worker error")
            finally:
                self._current_episode = None


worker = Worker()


# --- queue operations ------------------------------------------------------------------------

def _episode_event(episode_id: int, **fields: Any) -> None:
    events.publish("episode", {"id": episode_id, **fields})


def _set_episode(conn: Any, episode_id: int, **fields: Any) -> None:
    cols = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE episodes SET {cols} WHERE id = ?", (*fields.values(), episode_id))


def recover() -> None:
    """Reset work interrupted by a previous shutdown."""
    with db.session() as conn:
        stale = [r["episode_id"] for r in conn.execute("SELECT episode_id FROM jobs WHERE state = 'running'")]
        conn.execute("UPDATE jobs SET state = 'queued', started_at = NULL WHERE state = 'running'")
        for ep in stale:
            _clear_transcript(conn, ep)
        conn.execute(
            "UPDATE episodes SET status = 'queued', progress = 0 WHERE status IN ('downloading', 'transcribing')"
        )
    if stale:
        log.info("Re-queued %d interrupted job(s)", len(stale))
    for part in paths.audio_dir().glob("*.tmp*"):
        part.unlink(missing_ok=True)


def enqueue(episode_ids: Iterable[int]) -> list[int]:
    queued: list[int] = []
    now = time.time()
    with db.session() as conn:
        for ep in episode_ids:
            row = conn.execute("SELECT status, deleted FROM episodes WHERE id = ?", (ep,)).fetchone()
            if row is None or row["deleted"] or row["status"] in ACTIVE_STATUSES:
                continue
            conn.execute("INSERT INTO jobs(episode_id, state, created_at) VALUES(?, 'queued', ?)", (ep, now))
            _set_episode(conn, ep, status="queued", progress=0, error=None)
            queued.append(ep)
    for ep in queued:
        _episode_event(ep, status="queued", progress=0, error=None)
    worker.wake()
    return queued


def cancel(episode_id: int) -> None:
    with db.session() as conn:
        conn.execute(
            "UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE episode_id = ? AND state = 'queued'",
            (time.time(), episode_id),
        )
        row = conn.execute("SELECT status FROM episodes WHERE id = ?", (episode_id,)).fetchone()
        if row and row["status"] == "queued":
            _set_episode(conn, episode_id, status="new", progress=0)
            _episode_event(episode_id, status="new", progress=0)
    worker.cancel_episode(episode_id)


def _claim_next() -> dict[str, Any] | None:
    with db.session() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        conn.execute("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?", (time.time(), row["id"]))
        return dict(row)


def _clear_transcript(conn: Any, episode_id: int) -> None:
    conn.execute("DELETE FROM words WHERE episode_id = ?", (episode_id,))
    conn.execute("DELETE FROM segments WHERE episode_id = ?", (episode_id,))
    conn.execute("DELETE FROM segments_fts WHERE episode_id = ?", (episode_id,))


# --- processing --------------------------------------------------------------------------------

def _friendly_error(exc: BaseException) -> str:
    if isinstance(exc, (transcriber.NoModelError, downloader.DownloadError, audio.AudioError)):
        return str(exc)
    msg = str(exc) or exc.__class__.__name__
    if "out of memory" in msg.lower():
        return "Ran out of memory. Try a smaller model in Settings."
    return f"{exc.__class__.__name__}: {msg}"


def _ensure_audio(ep: dict[str, Any], cancel: threading.Event) -> tuple[Path, bool]:
    """Return (local audio path, is_temporary)."""
    if ep["audio_path"] and Path(ep["audio_path"]).exists():
        return Path(ep["audio_path"]), False
    ep_id = ep["id"]
    with db.session() as conn:
        _set_episode(conn, ep_id, status="downloading", progress=0)
    _episode_event(ep_id, status="downloading", progress=0)

    last = [0.0]

    def prog(done: int, total: int | None) -> None:
        now = time.monotonic()
        if total and now - last[0] > 0.3:
            last[0] = now
            _episode_event(ep_id, status="downloading", progress=round(100 * done / total, 1))

    ext = downloader.guess_extension(ep["audio_url"], ep["audio_type"])
    stream_only = bool(db.get_setting("stream_from_source"))
    dest = paths.audio_dir() / (f"{ep_id}.tmp{ext}" if stream_only else f"{ep_id}{ext}")
    if videos.is_drive_media(ep["audio_url"]):
        # A video uploaded from another device: it lives in the user's Google Drive.
        if not ep["remote_audio"]:
            raise downloader.DownloadError("The video is still uploading from the other device. Try again shortly.")
        try:
            sync.fetch_media(videos.drive_name(ep["audio_url"]), dest, prog)
        except FileNotFoundError as exc:
            raise downloader.DownloadError("The video isn't in your Google Drive any more.") from exc
        except sync.DriveError as exc:
            raise downloader.DownloadError(str(exc)) from exc
    else:
        downloader.download(ep["audio_url"], dest, prog, cancel=cancel)
    if not stream_only:
        with db.session() as conn:
            _set_episode(conn, ep_id, audio_path=str(dest))
    return dest, stream_only


def _store(episode_id: int, segments: list[Segment], model: str) -> int:
    with db.session() as conn:
        _clear_transcript(conn, episode_id)
        widx = 0
        for sidx, seg in enumerate(segments):
            norm = arabic.normalize(seg.text)
            conn.execute(
                "INSERT INTO segments(episode_id, idx, start, end, text, norm) VALUES(?,?,?,?,?,?)",
                (episode_id, sidx, seg.start, seg.end, seg.text, norm),
            )
            conn.execute("INSERT INTO segments_fts(norm, episode_id, seg_idx) VALUES(?,?,?)", (norm, episode_id, sidx))
            words = seg.words or []
            if not words and seg.text:
                # Engine gave no word timings: spread words evenly so the player still works.
                toks = seg.text.split()
                step = (seg.end - seg.start) / max(1, len(toks))
                words = [transcriber.Word(seg.start + i * step, seg.start + (i + 1) * step, t) for i, t in enumerate(toks)]
            conn.executemany(
                "INSERT INTO words(episode_id, idx, seg_idx, start, end, text, prob) VALUES(?,?,?,?,?,?,?)",
                [(episode_id, widx + i, sidx, w.start, w.end, w.text, w.prob) for i, w in enumerate(words)],
            )
            widx += len(words)
        _set_episode(conn, episode_id, status="done", progress=100, error=None, model=model,
                     transcribed_at=time.time())
    return widx


def _make_sync_copy(ep_id: int, source: Path) -> None:
    """Compressed copy of the exact audio just transcribed, for other devices (only when syncing)."""
    if not (sync.oauth.signed_in() and db.get_setting("sync_audio")):
        return
    with db.session() as conn:
        row = conn.execute("SELECT audio_url FROM episodes WHERE id = ?", (ep_id,)).fetchone()
    if row and videos.is_drive_media(row["audio_url"]):
        return  # the video itself is in Drive; other devices play that
    dest = paths.audio_dir() / f"{ep_id}.sync.ogg"
    try:
        audio.encode_speech_copy(source, dest)
    except audio.AudioError as exc:
        log.warning("Couldn't make the sync audio copy for episode %s: %s", ep_id, exc)
        return
    with db.session() as conn:
        _set_episode(conn, ep_id, sync_audio_path=str(dest), remote_audio=0)


def _process(job: dict[str, Any], cancel: threading.Event) -> None:
    ep_id = job["episode_id"]
    with db.session() as conn:
        ep = db.row_to_dict(conn.execute("SELECT * FROM episodes WHERE id = ?", (ep_id,)).fetchone())
    if ep is None:
        with db.session() as conn:
            conn.execute("UPDATE jobs SET state = 'cancelled' WHERE id = ?", (job["id"],))
        return
    temp_audio: Path | None = None
    try:
        engine = transcriber.get()  # fail fast if no model, before downloading audio
        audio_path, is_temp = _ensure_audio(ep, cancel)
        if is_temp:
            temp_audio = audio_path
        duration = audio.probe_duration(audio_path)
        with db.session() as conn:
            _set_episode(conn, ep_id, status="transcribing", progress=0, duration=duration or ep["duration"])
        _episode_event(ep_id, status="transcribing", progress=0, duration=duration)

        samples = audio.decode(audio_path)
        if not duration:
            duration = len(samples) / audio.SAMPLE_RATE

        segments: list[Segment] = []
        last_emit = 0.0
        last_pct = -1.0
        for seg in engine.transcribe(samples, cancel):
            segments.append(seg)
            pct = min(99.9, round(100 * seg.end / duration, 1)) if duration else 0.0
            now = time.monotonic()
            if pct - last_pct >= 0.5 or now - last_emit > 1.0:
                last_emit, last_pct = now, pct
                with db.session() as conn:
                    _set_episode(conn, ep_id, progress=pct)
                _episode_event(ep_id, status="transcribing", progress=pct)
        del samples

        if cancel.is_set():
            raise TranscriptionCancelled()
        n_words = _store(ep_id, segments, f"{engine.engine}:{engine.model_size}:{engine.device}")
        _make_sync_copy(ep_id, audio_path)
        with db.session() as conn:
            conn.execute("UPDATE jobs SET state = 'done', finished_at = ? WHERE id = ?", (time.time(), job["id"]))
        if db.get_setting("delete_audio_after") and not is_temp and not videos.is_drive_media(ep["audio_url"]):
            audio_path.unlink(missing_ok=True)
            with db.session() as conn:
                _set_episode(conn, ep_id, audio_path=None)
        log.info("Transcribed episode %s: %d segments, %d words", ep_id, len(segments), n_words)
        _episode_event(ep_id, status="done", progress=100, title=ep["title"], words=n_words)
        sync.request()
    except (TranscriptionCancelled, downloader.Cancelled):
        if worker._stop.is_set():
            # App is quitting: keep the job queued so it restarts on next launch.
            with db.session() as conn:
                conn.execute("UPDATE jobs SET state = 'queued', started_at = NULL WHERE id = ?", (job["id"],))
                _set_episode(conn, ep_id, status="queued", progress=0)
            return
        with db.session() as conn:
            conn.execute("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE id = ?", (time.time(), job["id"]))
            _set_episode(conn, ep_id, status="new", progress=0)
        _episode_event(ep_id, status="new", progress=0)
    except Exception as exc:
        log.error("Job for episode %s failed:\n%s", ep_id, traceback.format_exc())
        message = _friendly_error(exc)
        with db.session() as conn:
            conn.execute("UPDATE jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?",
                         (message, time.time(), job["id"]))
            _set_episode(conn, ep_id, status="failed", error=message)
        _episode_event(ep_id, status="failed", error=message, title=ep["title"])
    finally:
        if temp_audio is not None:
            temp_audio.unlink(missing_ok=True)

"""Background Google Drive sync.

Call :func:`request` after any change worth syncing; the manager debounces and runs one
sync at a time on its own thread, plus a periodic sync every few minutes.
"""

from __future__ import annotations

import logging
import platform
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .. import db, events
from . import engine, oauth
from .drive import DriveError, GoogleDrive

log = logging.getLogger(__name__)

PERIOD = 300  # seconds between automatic syncs
DEBOUNCE = 4  # seconds to wait after a change before syncing


class Manager:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._due = 0.0
        self._thread: threading.Thread | None = None
        self._run_lock = threading.Lock()
        self.state: dict[str, Any] = {"state": "idle", "last_sync": None, "error": None, "last_result": None}

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="drive-sync", daemon=True)
            self._thread.start()
        self.request(delay=2)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def request(self, delay: float = DEBOUNCE) -> None:
        if not oauth.signed_in():
            return
        due = time.monotonic() + delay
        self._due = min(self._due, due) if self._due else due
        self._wake.set()

    def _publish(self, **kw: Any) -> None:
        self.state.update(kw)
        events.publish("sync", status())

    def _loop(self) -> None:
        next_periodic = time.monotonic() + PERIOD
        while not self._stop.is_set():
            now = time.monotonic()
            wait = min(next_periodic - now, (self._due - now) if self._due else PERIOD)
            if wait > 0:
                self._wake.wait(timeout=wait)
                self._wake.clear()
                continue
            if self._due and time.monotonic() >= self._due or time.monotonic() >= next_periodic:
                self._due = 0.0
                next_periodic = time.monotonic() + PERIOD
                if oauth.signed_in():
                    self.sync_now()

    def sync_now(self) -> dict[str, Any]:
        if not self._run_lock.acquire(blocking=False):
            return status()
        drive = None
        try:
            self._publish(state="syncing", error=None)
            drive = GoogleDrive(lambda force: oauth.access_token(force))
            settings = db.get_settings()
            result = engine.run(drive, device_id(), bool(settings.get("sync_audio", True)), can_transcribe=True)
            if result.new_feeds:
                # Podcasts added on the phone (or another computer): fetch their episodes here,
                # then sync again so every device gets the episode list.
                from .. import feeds as feeds_mod

                for feed_id in result.new_feeds:
                    feeds_mod.refresh_feed(feed_id)
                self.request(delay=1)
            summary = result.summary()
            self._publish(state="idle", last_sync=time.time(), last_result=summary)
            if result.downloaded_transcripts or any(result.merged.values()):
                events.publish("feeds", {"refreshed": True, "synced": True})
            log.info("Sync finished: %s", summary)
        except (oauth.AuthError, DriveError) as exc:
            log.warning("Sync failed: %s", exc)
            self._publish(state="error", error=str(exc))
        except Exception as exc:
            log.exception("Sync failed")
            self._publish(state="error", error=f"{exc.__class__.__name__}: {exc}")
        finally:
            if drive is not None:
                drive.close()
            self._run_lock.release()
        return status()


manager = Manager()


def request(delay: float = DEBOUNCE) -> None:
    """Schedule a sync soon (no-op when not signed in)."""
    manager.request(delay)


def device_id() -> str:
    did = db.get_setting("device_id")
    if not did:
        did = f"{platform.node() or 'desktop'}-{uuid.uuid4().hex[:6]}"
        db.set_settings({"device_id": did})
    return str(did)


def status() -> dict[str, Any]:
    s = db.get_settings()
    return {
        "configured": oauth.configured(),
        "signed_in": bool(s.get("google_refresh_token")),
        "email": s.get("google_email") or "",
        "sync_audio": bool(s.get("sync_audio", True)),
        **manager.state,
    }


def audio_copy(episode_id: int) -> Path | None:
    """Fetch the synced audio copy for an episode (used by the player)."""
    if not oauth.signed_in():
        return None
    drive = GoogleDrive(lambda force: oauth.access_token(force))
    try:
        return engine.fetch_audio_copy(drive, episode_id)
    except Exception as exc:
        log.warning("Couldn't fetch synced audio for episode %s: %s", episode_id, exc)
        return None
    finally:
        drive.close()

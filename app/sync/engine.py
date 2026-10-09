"""Sync engine: merge the local library with the copy in the user's Google Drive.

Drive layout (hidden app folder, shared by desktop and Android):
    library.json.gz      feeds, episodes, vocab, definitions (small; merged record by record)
    t_<episode>.json.gz  one transcript per episode (written once per transcription)
    a_<episode>.ogg      compressed copy of the exact audio that was transcribed

Merge rule: per record, the newest `updated_at` wins. Deletions are kept as tombstones so
they propagate instead of being resurrected by another device.
"""

from __future__ import annotations

import gzip
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import arabic, audio, db, paths
from .drive import Drive

log = logging.getLogger(__name__)

LIBRARY = "library.json.gz"
FORMAT_VERSION = 1


def transcript_name(uid: str) -> str:
    return f"t_{uid}.json.gz"


def audio_name(uid: str) -> str:
    return f"a_{uid}.ogg"


@dataclass
class Result:
    uploaded_transcripts: int = 0
    downloaded_transcripts: int = 0
    uploaded_audio: int = 0
    merged: dict[str, int] = field(default_factory=lambda: {"feeds": 0, "episodes": 0, "vocab": 0, "definitions": 0})
    library_uploaded: bool = False
    requested_transcriptions: list[int] = field(default_factory=list)
    new_feeds: list[int] = field(default_factory=list)  # added on another device; need an RSS fetch here

    def summary(self) -> dict[str, Any]:
        return {"uploaded_transcripts": self.uploaded_transcripts,
                "downloaded_transcripts": self.downloaded_transcripts,
                "uploaded_audio": self.uploaded_audio, "merged": self.merged,
                "library_uploaded": self.library_uploaded,
                "requested_transcriptions": len(self.requested_transcriptions)}


def _gz(obj: Any) -> bytes:
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0)


def _ungz(data: bytes) -> Any:
    return json.loads(gzip.decompress(data).decode("utf-8"))


# ---------------------------------------------------------------------------------- snapshot

def snapshot(device_id: str) -> dict[str, Any]:
    with db.session() as conn:
        feeds = [dict(r) for r in conn.execute(
            "SELECT uid, url, title, substr(description, 1, 1000) AS description, image, link, auto_transcribe, "
            "deleted, created_at, updated_at FROM feeds ORDER BY uid")]
        episodes = [dict(r) for r in conn.execute(
            "SELECT e.uid, f.uid AS feed_uid, e.guid, e.title, substr(e.description, 1, 1500) AS description, "
            "e.published, e.duration, e.image, e.audio_url, e.audio_type, e.synced_rev AS transcript_rev, e.model, "
            "e.transcribe_requested_at, e.remote_audio, e.created_at, e.updated_at "
            "FROM episodes e JOIN feeds f ON f.id = e.feed_id WHERE f.deleted = 0 ORDER BY e.uid")]
        vocab = [dict(r) for r in conn.execute(
            "SELECT uid, episode_uid, text, sentence, start, end, sent_start, sent_end, meaning, notes, "
            "episode_title, deleted, created_at, updated_at FROM vocab ORDER BY uid")]
        defs = [{**dict(r), "data": json.loads(r["data"])} for r in conn.execute(
            "SELECT key, word, sentence, data, provider, model, created_at FROM definitions ORDER BY key")]
    return {"format": FORMAT_VERSION, "device": device_id, "feeds": feeds, "episodes": episodes,
            "vocab": vocab, "definitions": defs}


def _content(lib: dict[str, Any]) -> str:
    """Canonical form used to decide whether an upload is needed (ignores who wrote it)."""
    return json.dumps({k: lib.get(k) for k in ("feeds", "episodes", "vocab", "definitions")},
                      ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------------------------- merge

def _newer(remote: dict[str, Any], local: Any) -> bool:
    return (remote.get("updated_at") or 0) > ((local["updated_at"] if local is not None else None) or 0)


def merge(remote: dict[str, Any], result: Result) -> list[tuple[int, str, float]]:
    """Apply remote records that are newer than local ones. Returns transcripts to download
    as (local episode id, episode uid, revision)."""
    downloads: list[tuple[int, str, float]] = []
    with db.session() as conn, db.sync_writes(conn):
        # Feeds
        for r in remote.get("feeds", []):
            local = conn.execute("SELECT * FROM feeds WHERE uid = ? OR url = ?", (r["uid"], r["url"])).fetchone()
            if local is None:
                conn.execute(
                    "INSERT INTO feeds(uid, url, title, description, image, link, auto_transcribe, deleted, created_at, "
                    "updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (r["uid"], r["url"], r["title"], r["description"] or "", r["image"], r["link"],
                     r["auto_transcribe"], r["deleted"], r["created_at"], r["updated_at"]))
                if not r["deleted"]:
                    result.new_feeds.append(int(conn.execute("SELECT last_insert_rowid()").fetchone()[0]))
                result.merged["feeds"] += 1
            elif _newer(r, local):
                conn.execute(
                    "UPDATE feeds SET title=?, description=?, image=?, link=?, auto_transcribe=?, deleted=?, "
                    "updated_at=? WHERE id=?",
                    (r["title"], r["description"] or "", r["image"], r["link"], r["auto_transcribe"], r["deleted"],
                     r["updated_at"], local["id"]))
                if r["deleted"] and not local["deleted"]:
                    _purge_feed_episodes(conn, local["id"])
                elif local["deleted"] and not r["deleted"]:
                    result.new_feeds.append(local["id"])  # re-subscribed elsewhere
                result.merged["feeds"] += 1

        # Episodes
        feed_ids = {row["uid"]: (row["id"], row["deleted"]) for row in conn.execute("SELECT id, uid, deleted FROM feeds")}
        for r in remote.get("episodes", []):
            feed = feed_ids.get(r["feed_uid"])
            if feed is None or feed[1]:
                continue
            local = conn.execute("SELECT * FROM episodes WHERE uid = ?", (r["uid"],)).fetchone()
            if local is None:
                local = conn.execute("SELECT * FROM episodes WHERE feed_id = ? AND guid = ?",
                                     (feed[0], r["guid"])).fetchone()
            if local is None:
                cur = conn.execute(
                    "INSERT INTO episodes(feed_id, uid, guid, title, description, published, duration, image, audio_url, "
                    "audio_type, transcribe_requested_at, remote_audio, created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (feed[0], r["uid"], r["guid"], r["title"], r["description"] or "", r["published"], r["duration"],
                     r["image"], r["audio_url"], r["audio_type"], r["transcribe_requested_at"], r["remote_audio"] or 0,
                     r["created_at"], r["updated_at"]))
                local_id, local_rev = int(cur.lastrowid), None
                result.merged["episodes"] += 1
            else:
                local_id, local_rev = local["id"], local["transcribed_at"]
                if _newer(r, local):
                    conn.execute(
                        "UPDATE episodes SET uid=?, title=?, description=?, published=COALESCE(?, published), "
                        "duration=COALESCE(duration, ?), image=?, audio_url=?, audio_type=?, "
                        "transcribe_requested_at=MAX(COALESCE(transcribe_requested_at, 0), COALESCE(?, 0)), "
                        "remote_audio=MAX(remote_audio, ?), updated_at=? WHERE id=?",
                        (r["uid"], r["title"], r["description"] or "", r["published"], r["duration"], r["image"],
                         r["audio_url"], r["audio_type"], r["transcribe_requested_at"], r["remote_audio"] or 0,
                         r["updated_at"], local_id))
                    result.merged["episodes"] += 1
            rev = r.get("transcript_rev")
            if rev and (local_rev is None or rev > local_rev + 1e-3):
                downloads.append((local_id, r["uid"], rev))

        # Vocab
        ep_ids = {row["uid"]: row["id"] for row in conn.execute("SELECT id, uid FROM episodes")}
        for r in remote.get("vocab", []):
            local = conn.execute("SELECT * FROM vocab WHERE uid = ?", (r["uid"],)).fetchone()
            values = (r["text"], arabic.normalize(r["text"]), r["sentence"], r["start"], r["end"], r["sent_start"],
                      r["sent_end"], r["meaning"], r["notes"], r["episode_title"], r["deleted"], r["episode_uid"],
                      ep_ids.get(r["episode_uid"]), r["updated_at"])
            if local is None:
                conn.execute(
                    "INSERT INTO vocab(text, norm, sentence, start, end, sent_start, sent_end, meaning, notes, "
                    "episode_title, deleted, episode_uid, episode_id, updated_at, uid, created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (*values, r["uid"], r["created_at"]))
                result.merged["vocab"] += 1
            elif _newer(r, local):
                conn.execute(
                    "UPDATE vocab SET text=?, norm=?, sentence=?, start=?, end=?, sent_start=?, sent_end=?, meaning=?, "
                    "notes=?, episode_title=?, deleted=?, episode_uid=?, episode_id=?, updated_at=? WHERE id=?",
                    (*values, local["id"]))
                result.merged["vocab"] += 1

        # Definitions (immutable cache entries): union
        for r in remote.get("definitions", []):
            cur = conn.execute(
                "INSERT OR IGNORE INTO definitions(key, word, sentence, data, provider, model, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (r["key"], r["word"], r["sentence"], json.dumps(r["data"], ensure_ascii=False), r["provider"],
                 r["model"], r["created_at"]))
            result.merged["definitions"] += cur.rowcount
    return downloads


def _purge_feed_episodes(conn: Any, feed_id: int) -> None:
    rows = conn.execute("SELECT id, audio_path, sync_audio_path FROM episodes WHERE feed_id = ?", (feed_id,)).fetchall()
    for row in rows:
        conn.execute("DELETE FROM segments_fts WHERE episode_id = ?", (row["id"],))
        for p in (row["audio_path"], row["sync_audio_path"]):
            if p and Path(p).resolve().parent == paths.audio_dir().resolve():
                Path(p).unlink(missing_ok=True)
    conn.execute("DELETE FROM episodes WHERE feed_id = ?", (feed_id,))


# ---------------------------------------------------------------------------------- transcripts

def transcript_payload(episode_id: int) -> dict[str, Any]:
    with db.session() as conn:
        ep = conn.execute("SELECT transcribed_at, model FROM episodes WHERE id = ?", (episode_id,)).fetchone()
        segs = conn.execute("SELECT start, end, text FROM segments WHERE episode_id = ? ORDER BY idx",
                            (episode_id,)).fetchall()
        words = conn.execute("SELECT start, end, text, seg_idx FROM words WHERE episode_id = ? ORDER BY idx",
                             (episode_id,)).fetchall()
    return {
        "format": FORMAT_VERSION, "rev": ep["transcribed_at"], "model": ep["model"],
        "segments": [[round(s["start"], 3), round(s["end"], 3), s["text"]] for s in segs],
        "words": {"start": [round(w["start"], 3) for w in words], "end": [round(w["end"], 3) for w in words],
                  "text": [w["text"] for w in words], "seg": [w["seg_idx"] for w in words]},
    }


def store_transcript(episode_id: int, payload: dict[str, Any]) -> None:
    """Write a downloaded transcript, marking the episode done without re-uploading it."""
    w = payload["words"]
    with db.session() as conn, db.sync_writes(conn):
        conn.execute("DELETE FROM words WHERE episode_id = ?", (episode_id,))
        conn.execute("DELETE FROM segments WHERE episode_id = ?", (episode_id,))
        conn.execute("DELETE FROM segments_fts WHERE episode_id = ?", (episode_id,))
        for idx, (start, end, text) in enumerate(payload["segments"]):
            norm = arabic.normalize(text)
            conn.execute("INSERT INTO segments(episode_id, idx, start, end, text, norm) VALUES(?,?,?,?,?,?)",
                         (episode_id, idx, start, end, text, norm))
            conn.execute("INSERT INTO segments_fts(norm, episode_id, seg_idx) VALUES(?,?,?)", (norm, episode_id, idx))
        conn.executemany(
            "INSERT INTO words(episode_id, idx, seg_idx, start, end, text) VALUES(?,?,?,?,?,?)",
            [(episode_id, i, w["seg"][i], w["start"][i], w["end"][i], w["text"][i]) for i in range(len(w["text"]))])
        # A local download of this episode may not match the audio the other device transcribed
        # (dynamically inserted ads), so playback switches to the synced copy.
        old = conn.execute("SELECT audio_path FROM episodes WHERE id = ?", (episode_id,)).fetchone()
        if old and old["audio_path"] and Path(old["audio_path"]).resolve().parent == paths.audio_dir().resolve():
            Path(old["audio_path"]).unlink(missing_ok=True)
        conn.execute(
            "UPDATE episodes SET status='done', progress=100, error=NULL, model=?, transcribed_at=?, synced_rev=?, "
            "audio_path=NULL WHERE id=? AND status NOT IN ('downloading', 'transcribing')",
            (payload.get("model"), payload["rev"], payload["rev"], episode_id))


# ---------------------------------------------------------------------------------- run

def run(drive: Drive, device_id: str, sync_audio: bool, can_transcribe: bool) -> Result:
    result = Result()
    files = {f["name"]: f for f in drive.list()}

    # 1. Publish transcripts finished on this device (before the library refers to them).
    with db.session() as conn:
        pending = conn.execute(
            "SELECT id, uid, transcribed_at FROM episodes WHERE status = 'done' AND transcribed_at IS NOT NULL "
            "AND (synced_rev IS NULL OR synced_rev < transcribed_at)").fetchall()
    for ep in pending:
        name = transcript_name(ep["uid"])
        meta = drive.upload(name, _gz(transcript_payload(ep["id"])), "application/gzip",
                            files.get(name, {}).get("id"))
        files[name] = meta
        with db.session() as conn:
            conn.execute("UPDATE episodes SET synced_rev = ? WHERE id = ?", (ep["transcribed_at"], ep["id"]))
        result.uploaded_transcripts += 1

    # 2. Publish compressed audio copies.
    if sync_audio:
        upload_audio_copies(drive, files, result)

    # 3-5. Merge the library, fetch new transcripts, upload the merged library.
    for _attempt in range(3):
        lib_meta = files.get(LIBRARY)
        remote = _ungz(drive.download(lib_meta["id"])) if lib_meta else None
        downloads = merge(remote, result) if remote else []
        for local_id, uid, rev in downloads:
            meta = files.get(transcript_name(uid))
            if meta is None:
                continue  # library ahead of the transcript upload; next sync picks it up
            payload = _ungz(drive.download(meta["id"]))
            if abs((payload.get("rev") or 0) - rev) < 1e-3 or (payload.get("rev") or 0) > rev:
                store_transcript(local_id, payload)
                result.downloaded_transcripts += 1

        local = snapshot(device_id)
        if remote is not None and _content(remote) == _content(local):
            break
        if lib_meta is not None:
            # Someone else may have written the library while we merged: re-check before overwriting.
            current = drive.get(lib_meta["id"])
            if current.get("modifiedTime") != lib_meta.get("modifiedTime"):
                files[LIBRARY] = current
                continue
        files[LIBRARY] = drive.upload(LIBRARY, _gz(local), "application/gzip", lib_meta["id"] if lib_meta else None)
        result.library_uploaded = True
        break

    # 6. Transcription requests from other devices (e.g. the phone).
    if can_transcribe:
        result.requested_transcriptions = requested_transcriptions()
    return result


def upload_audio_copies(drive: Drive, files: dict[str, dict[str, Any]], result: Result) -> None:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT id, uid, audio_path, sync_audio_path FROM episodes "
            "WHERE status = 'done' AND remote_audio = 0 AND (sync_audio_path IS NOT NULL OR audio_path IS NOT NULL)"
        ).fetchall()
    for ep in rows:
        copy = Path(ep["sync_audio_path"]) if ep["sync_audio_path"] else None
        if copy is None or not copy.exists():
            src = Path(ep["audio_path"]) if ep["audio_path"] else None
            if src is None or not src.exists():
                continue
            copy = paths.audio_dir() / f"{ep['id']}.sync.ogg"
            try:
                audio.encode_speech_copy(src, copy)
            except audio.AudioError as exc:
                log.warning("Skipping audio copy for episode %s: %s", ep["id"], exc)
                continue
            with db.session() as conn:
                conn.execute("UPDATE episodes SET sync_audio_path = ? WHERE id = ?", (str(copy), ep["id"]))
        name = audio_name(ep["uid"])
        if name not in files:
            files[name] = drive.upload(name, copy, "audio/ogg")
        with db.session() as conn:
            conn.execute("UPDATE episodes SET remote_audio = 1 WHERE id = ?", (ep["id"],))
        result.uploaded_audio += 1


def requested_transcriptions() -> list[int]:
    """Episodes another device asked this one to transcribe, not yet done or attempted."""
    from .. import jobs

    with db.session() as conn:
        rows = conn.execute(
            """SELECT e.id FROM episodes e JOIN feeds f ON f.id = e.feed_id
               WHERE f.deleted = 0 AND e.transcribe_requested_at IS NOT NULL
                 AND e.status IN ('new', 'failed')
                 AND e.transcribe_requested_at > COALESCE(e.transcribed_at, 0)
                 AND e.transcribe_requested_at > COALESCE(
                       (SELECT MAX(j.created_at) FROM jobs j WHERE j.episode_id = e.id), 0)""").fetchall()
    ids = [r["id"] for r in rows]
    return jobs.enqueue(ids) if ids else []


def fetch_audio_copy(drive: Drive, episode_id: int) -> Path | None:
    """Download the synced audio copy for an episode transcribed on another device."""
    with db.session() as conn:
        ep = conn.execute("SELECT uid, remote_audio FROM episodes WHERE id = ?", (episode_id,)).fetchone()
    if ep is None or not ep["remote_audio"]:
        return None
    match = [f for f in drive.list() if f["name"] == audio_name(ep["uid"])]
    if not match:
        return None
    dest = paths.audio_dir() / f"{episode_id}.sync.ogg"
    drive.download_to(match[0]["id"], dest)
    with db.session() as conn:
        conn.execute("UPDATE episodes SET sync_audio_path = ? WHERE id = ?", (str(dest), episode_id))
    return dest


"""Two simulated devices syncing through an in-memory fake Google Drive."""

from __future__ import annotations

import itertools
import time
from pathlib import Path
from typing import Any

import pytest

from app import db, ids, paths
from app.sync import engine
from app.transcriber import Segment, Word


class FakeDrive:
    def __init__(self) -> None:
        self.files: dict[str, dict[str, Any]] = {}
        self._ids = itertools.count(1)
        self._clock = itertools.count(1)
        self.before_get = None  # hook to simulate another device writing mid-sync

    def _meta(self, f: dict[str, Any]) -> dict[str, Any]:
        return {"id": f["id"], "name": f["name"], "modifiedTime": f"t{f['mtime']}", "size": str(len(f["data"]))}

    def list(self):
        return [self._meta(f) for f in self.files.values()]

    def get(self, file_id):
        if self.before_get:
            hook, self.before_get = self.before_get, None
            hook()
        return self._meta(self.files[file_id])

    def download(self, file_id):
        return self.files[file_id]["data"]

    def download_to(self, file_id, dest: Path):
        dest.write_bytes(self.files[file_id]["data"])

    def upload(self, name, data, mime, file_id=None):
        if isinstance(data, Path):
            data = data.read_bytes()
        fid = file_id or f"id{next(self._ids)}"
        self.files[fid] = {"id": fid, "name": name, "data": data, "mtime": next(self._clock)}
        return self._meta(self.files[fid])

    def delete(self, file_id):
        del self.files[file_id]

    def by_name(self, name):
        return next((f for f in self.files.values() if f["name"] == name), None)


class Device:
    """Points the app's database and data folders at one simulated device."""

    def __init__(self, root: Path, name: str, monkeypatch) -> None:
        self.dir = root / name
        self.dir.mkdir()
        (self.dir / "audio").mkdir()
        self.name = name
        self.mp = monkeypatch

    def __enter__(self):
        self.mp.setattr(paths, "db_path", lambda: self.dir / "library.db")
        self.mp.setattr(paths, "audio_dir", lambda: self.dir / "audio")
        db.init_db(self.dir / "library.db")
        return self

    def __exit__(self, *exc):
        return False

    def sync(self, drive, can_transcribe=False, sync_audio=False):
        with self:
            return engine.run(drive, self.name, sync_audio=sync_audio, can_transcribe=can_transcribe)


def seed_library(conn) -> dict[str, int]:
    """One feed with two episodes; episode 1 transcribed, plus a vocab item and a definition."""
    url = "https://example.com/rss"
    conn.execute("INSERT INTO feeds(url, uid, title, created_at) VALUES(?,?,?,?)", (url, ids.feed_uid(url), "Feed", 1.0))
    fuid = ids.feed_uid(url)
    for n in (1, 2):
        conn.execute("INSERT INTO episodes(feed_id, uid, guid, title, audio_url, created_at) VALUES(1,?,?,?,?,?)",
                     (ids.episode_uid(fuid, f"g{n}"), f"g{n}", f"Episode {n}", f"https://cdn/ep{n}.mp3", 1.0))
    conn.execute("INSERT INTO vocab(uid, episode_id, episode_uid, text, norm, sentence, meaning, created_at) "
                 "VALUES(?,?,?,?,?,?,?,?)", ("vword1", 1, ids.episode_uid(fuid, "g1"), "كتاب", "كتاب", "هذا كتاب", "book", 2.0))
    conn.execute("INSERT INTO definitions(key, word, sentence, data, created_at) VALUES('k1','كتاب','هذا ⟦كتاب⟧','{\"meaning\":\"book\"}',3)")
    return {"ep1": 1, "ep2": 2}


def transcribe_locally(episode_id: int) -> None:
    from app import jobs

    segs = [Segment(0.0, 1.5, "مرحبا بكم", [Word(0.0, 0.7, "مرحبا"), Word(0.8, 1.5, "بكم")])]
    jobs._store(episode_id, segs, "faster-whisper:test:cpu")


@pytest.fixture()
def world(tmp_path, monkeypatch):
    drive = FakeDrive()
    a = Device(tmp_path, "A", monkeypatch)
    b = Device(tmp_path, "B", monkeypatch)
    with a:
        with db.session() as conn:
            seed_library(conn)
        transcribe_locally(1)
    return drive, a, b


def test_first_sync_uploads_library_and_transcript(world):
    drive, a, _ = world
    r = a.sync(drive)
    assert r.uploaded_transcripts == 1 and r.library_uploaded
    assert drive.by_name("library.json.gz") and drive.by_name(engine.transcript_name(ids.episode_uid(ids.feed_uid("https://example.com/rss"), "g1")))
    # Nothing changed: a second sync uploads nothing.
    r2 = a.sync(drive)
    assert r2.uploaded_transcripts == 0 and not r2.library_uploaded


def test_new_device_receives_everything_without_echo(world):
    drive, a, b = world
    a.sync(drive)
    r = b.sync(drive)
    assert r.downloaded_transcripts == 1
    assert not r.library_uploaded, "receiving data must not trigger a re-upload"
    with b:
        with db.session() as conn:
            assert conn.execute("SELECT COUNT(*) FROM feeds").fetchone()[0] == 1
            ep = conn.execute("SELECT * FROM episodes WHERE guid='g1'").fetchone()
            assert ep["status"] == "done"
            words = [w[0] for w in conn.execute("SELECT text FROM words WHERE episode_id=? ORDER BY idx", (ep["id"],))]
            assert words == ["مرحبا", "بكم"]
            assert conn.execute("SELECT meaning FROM vocab WHERE uid='vword1'").fetchone()[0] == "book"
            assert conn.execute("SELECT COUNT(*) FROM definitions").fetchone()[0] == 1
            # Search works on synced transcripts.
            assert conn.execute("SELECT COUNT(*) FROM segments_fts").fetchone()[0] == 1
    # And A doesn't re-download its own transcript.
    assert a.sync(drive).downloaded_transcripts == 0


def test_edits_and_deletes_propagate_newest_wins(world):
    drive, a, b = world
    a.sync(drive)
    b.sync(drive)
    with b:
        with db.session() as conn:
            conn.execute("UPDATE vocab SET meaning='a book' WHERE uid='vword1'")
    b.sync(drive)
    a.sync(drive)
    with a:
        with db.session() as conn:
            assert conn.execute("SELECT meaning FROM vocab WHERE uid='vword1'").fetchone()[0] == "a book"
            conn.execute("UPDATE vocab SET deleted=1 WHERE uid='vword1'")
    a.sync(drive)
    b.sync(drive)
    with b:
        with db.session() as conn:
            assert conn.execute("SELECT deleted FROM vocab WHERE uid='vword1'").fetchone()[0] == 1


def test_older_remote_edit_does_not_overwrite_newer_local(world):
    drive, a, b = world
    a.sync(drive)
    b.sync(drive)
    with a:
        with db.session() as conn:
            conn.execute("UPDATE vocab SET meaning='old edit', updated_at=? WHERE uid='vword1'", (time.time() - 100,))
    with b:
        with db.session() as conn:
            conn.execute("UPDATE vocab SET meaning='new edit' WHERE uid='vword1'")
    b.sync(drive)
    a.sync(drive)
    for dev in (a, b):
        with dev:
            with db.session() as conn:
                assert conn.execute("SELECT meaning FROM vocab WHERE uid='vword1'").fetchone()[0] == "new edit"


def test_transcription_request_from_another_device(world, monkeypatch):
    drive, a, b = world
    a.sync(drive)
    b.sync(drive)
    with b:
        with db.session() as conn:
            conn.execute("UPDATE episodes SET transcribe_requested_at=? WHERE guid='g2'", (time.time(),))
    b.sync(drive)
    queued = []
    from app import jobs

    monkeypatch.setattr(jobs, "enqueue", lambda ids_: queued.extend(ids_) or list(ids_))
    a.sync(drive, can_transcribe=True)
    assert queued == [2]


def test_feed_removal_propagates(world):
    drive, a, b = world
    a.sync(drive)
    b.sync(drive)
    with a:
        with db.session() as conn:
            conn.execute("DELETE FROM episodes WHERE feed_id=1")
            conn.execute("UPDATE feeds SET deleted=1 WHERE id=1")
    a.sync(drive)
    b.sync(drive)
    with b:
        with db.session() as conn:
            assert conn.execute("SELECT deleted FROM feeds").fetchone()[0] == 1
            assert conn.execute("SELECT COUNT(*) FROM episodes").fetchone()[0] == 0
            assert conn.execute("SELECT COUNT(*) FROM words").fetchone()[0] == 0


def test_concurrent_write_is_merged_not_lost(world):
    drive, a, b = world
    a.sync(drive)
    b.sync(drive)
    with a:
        with db.session() as conn:
            conn.execute("UPDATE vocab SET notes='from A' WHERE uid='vword1'")
    # While A syncs, B saves a new word and uploads first.
    def b_writes():
        with b:
            with db.session() as conn:
                conn.execute("INSERT INTO vocab(uid, text, norm, created_at) VALUES('vfromB','قلم','قلم',5)")
            engine.run(drive, "B", sync_audio=False, can_transcribe=False)
        a.__enter__()  # back to A's database for the rest of A's sync

    drive.before_get = b_writes
    a.sync(drive)
    lib = engine._ungz(drive.by_name("library.json.gz")["data"])
    uids = {v["uid"]: v for v in lib["vocab"]}
    assert "vfromB" in uids, "B's word must survive A's upload"
    assert uids["vword1"]["notes"] == "from A"


def test_audio_copy_upload(world, monkeypatch):
    drive, a, _ = world
    from app import audio

    with a:
        src = a.dir / "audio" / "1.mp3"
        src.write_bytes(b"fake mp3")
        with db.session() as conn:
            conn.execute("UPDATE episodes SET audio_path=? WHERE id=1", (str(src),))
    monkeypatch.setattr(audio, "encode_speech_copy", lambda s, d: (d.write_bytes(b"opus"), d)[1])
    r = a.sync(drive, sync_audio=True)
    assert r.uploaded_audio == 1
    uid = ids.episode_uid(ids.feed_uid("https://example.com/rss"), "g1")
    assert drive.by_name(engine.audio_name(uid))["data"] == b"opus"
    lib = engine._ungz(drive.by_name("library.json.gz")["data"])
    assert next(e for e in lib["episodes"] if e["uid"] == uid)["remote_audio"] == 1

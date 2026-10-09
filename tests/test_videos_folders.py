"""Own videos ("My videos") and vocab folders: storage, API and sync between two devices."""

from __future__ import annotations

import asyncio
import json
import time

import pytest

from app import audio, db, ids, jobs, sync, videos
from app.sync import engine

from test_sync import FakeDrive, world  # noqa: F401  (pytest fixture)


async def _chunks(data: bytes):
    for i in range(0, len(data), 7):
        yield data[i:i + 7]


def add_video(monkeypatch, name="Lesson 1.mp4", data=b"fake video bytes") -> dict:
    monkeypatch.setattr(audio, "probe_duration", lambda p: 42.0)
    return asyncio.run(videos.save_upload(name, _chunks(data)))


def test_upload_creates_my_videos_episode(world, monkeypatch):
    _, a, _ = world
    with a:
        ep = add_video(monkeypatch)
        assert ep["title"] == "Lesson 1" and ep["audio_type"] == "video/mp4" and ep["duration"] == 42.0
        assert ep["audio_url"] == f"drive:v_{ep['uid']}.mp4"
        with db.session() as conn:
            feed = conn.execute("SELECT * FROM feeds WHERE id = ?", (ep["feed_id"],)).fetchone()
        assert feed["url"] == videos.LOCAL_FEED_URL and feed["uid"] == ids.feed_uid(videos.LOCAL_FEED_URL)
        from pathlib import Path
        assert Path(ep["audio_path"]).read_bytes() == b"fake video bytes"
        # A second upload reuses the same feed.
        assert add_video(monkeypatch, "b.webm")["feed_id"] == ep["feed_id"]


def test_upload_rejects_non_video(world, monkeypatch):
    _, a, _ = world
    with a, pytest.raises(videos.UploadError):
        add_video(monkeypatch, "notes.txt")


def test_video_syncs_to_drive_and_other_device(world, monkeypatch):
    drive, a, b = world
    with a:
        ep = add_video(monkeypatch)
    r = a.sync(drive)
    assert r.uploaded_videos == 1
    name = f"v_{ep['uid']}.mp4"
    assert drive.by_name(name)["data"] == b"fake video bytes"
    assert a.sync(drive).uploaded_videos == 0, "uploaded once only"
    lib = engine._ungz(drive.by_name("library.json.gz")["data"])
    rec = next(e for e in lib["episodes"] if e["uid"] == ep["uid"])
    assert rec["remote_audio"] == 1 and rec["audio_url"] == f"drive:{name}"

    b.sync(drive)
    with b:
        with db.session() as conn:
            row = conn.execute("SELECT * FROM episodes WHERE uid = ?", (ep["uid"],)).fetchone()
        assert row["audio_type"] == "video/mp4" and row["remote_audio"] == 1
        # Transcribing on B fetches the video from Drive instead of a URL.
        monkeypatch.setattr(sync, "fetch_media", lambda n, dest, prog=None: (dest.write_bytes(drive.by_name(n)["data"]), dest)[1])
        monkeypatch.setattr(db, "get_setting", lambda k: False)
        path, temp = jobs._ensure_audio(dict(row), None)
        assert path.read_bytes() == b"fake video bytes" and not temp


def test_no_audio_copy_is_made_for_videos(world, monkeypatch):
    drive, a, _ = world
    with a:
        ep = add_video(monkeypatch)
        with db.session() as conn:
            conn.execute("UPDATE episodes SET status = 'done', transcribed_at = 5 WHERE id = ?", (ep["id"],))
    monkeypatch.setattr(audio, "encode_speech_copy", lambda s, d: pytest.fail("no audio copy for videos"))
    r = a.sync(drive, sync_audio=True)
    assert r.uploaded_audio == 0 and drive.by_name(engine.audio_name(ep["uid"])) is None


def test_deleting_a_video_propagates_and_frees_drive(world, monkeypatch):
    drive, a, b = world
    with a:
        ep = add_video(monkeypatch)
        jobs._store(ep["id"], [], "test")
    a.sync(drive)
    b.sync(drive)
    with b:
        with db.session() as conn:
            bid = conn.execute("SELECT id FROM episodes WHERE uid = ?", (ep["uid"],)).fetchone()["id"]
            videos.delete_episode_files(conn, bid)
            conn.execute("UPDATE episodes SET deleted = 1 WHERE id = ?", (bid,))
    b.sync(drive)
    assert drive.by_name(f"v_{ep['uid']}.mp4") is None, "the video is removed from Drive"
    a.sync(drive)
    with a:
        with db.session() as conn:
            row = conn.execute("SELECT * FROM episodes WHERE uid = ?", (ep["uid"],)).fetchone()
        assert row["deleted"] == 1 and row["audio_path"] is None
        from pathlib import Path
        assert not Path(ep["audio_path"]).exists(), "A's local copy is deleted too"


def test_video_added_on_phone_is_transcribed_by_desktop(world, monkeypatch):
    drive, a, _ = world
    a.sync(drive)
    lib = engine._ungz(drive.by_name("library.json.gz")["data"])
    fuid = ids.feed_uid(videos.LOCAL_FEED_URL)
    now = time.time()
    lib["feeds"].append({"uid": fuid, "url": videos.LOCAL_FEED_URL, "title": "My videos", "description": "",
                         "image": None, "link": None, "auto_transcribe": 0, "deleted": 0,
                         "created_at": now, "updated_at": now})
    lib["episodes"].append({"uid": "ephonevideo00000000000", "feed_uid": fuid, "guid": "p1", "title": "From phone",
                            "description": "", "published": now, "duration": 30, "image": None,
                            "audio_url": "drive:v_ephonevideo00000000000.mp4", "audio_type": "video/mp4",
                            "transcript_rev": None, "model": None, "transcribe_requested_at": now,
                            "remote_audio": 1, "deleted": 0, "created_at": now, "updated_at": now})
    drive.upload("v_ephonevideo00000000000.mp4", b"phone video", "video/mp4")
    drive.upload("library.json.gz", engine._gz(lib), "application/gzip", drive.by_name("library.json.gz")["id"])
    queued = []
    monkeypatch.setattr(jobs, "enqueue", lambda ids_: queued.extend(ids_) or list(ids_))
    r = a.sync(drive, can_transcribe=True)
    assert r.new_feeds == [], "My videos has no RSS to fetch"
    assert len(queued) == 1


def test_folders_and_memberships_sync(world):
    drive, a, b = world
    with a:
        with db.session() as conn:
            conn.execute("INSERT INTO vocab_folders(uid, name, created_at) VALUES('dfood', 'Food', 1)")
            conn.execute("INSERT INTO vocab_folders(uid, name, created_at) VALUES('dweek', 'Week 1', 1)")
            conn.execute("""UPDATE vocab SET folders = '["dfood","dweek"]' WHERE uid = 'vword1'""")
    a.sync(drive)
    b.sync(drive)
    with b:
        with db.session() as conn:
            names = [r[0] for r in conn.execute("SELECT name FROM vocab_folders WHERE deleted = 0 ORDER BY name")]
            assert names == ["Food", "Week 1"]
            assert json.loads(conn.execute("SELECT folders FROM vocab WHERE uid='vword1'").fetchone()[0]) == ["dfood", "dweek"]
            # B renames a folder and takes the word out of another.
            conn.execute("UPDATE vocab_folders SET name = 'Food & drink' WHERE uid = 'dfood'")
            conn.execute("""UPDATE vocab SET folders = '["dfood"]' WHERE uid = 'vword1'""")
            changed = conn.execute("SELECT updated_at, created_at FROM vocab WHERE uid='vword1'").fetchone()
            assert changed["updated_at"] > changed["created_at"], "changing folders counts as a modification"
    b.sync(drive)
    a.sync(drive)
    with a:
        with db.session() as conn:
            assert conn.execute("SELECT name FROM vocab_folders WHERE uid='dfood'").fetchone()[0] == "Food & drink"
            assert json.loads(conn.execute("SELECT folders FROM vocab WHERE uid='vword1'").fetchone()[0]) == ["dfood"]


def test_library_from_older_app_without_folders_still_merges(world):
    drive, a, b = world
    a.sync(drive)
    lib = engine._ungz(drive.by_name("library.json.gz")["data"])
    lib.pop("folders", None)
    for v in lib["vocab"]:
        v.pop("folders", None)
    for e in lib["episodes"]:
        e.pop("deleted", None)
    drive.upload("library.json.gz", engine._gz(lib), "application/gzip", drive.by_name("library.json.gz")["id"])
    b.sync(drive)
    with b:
        with db.session() as conn:
            assert conn.execute("SELECT folders FROM vocab WHERE uid='vword1'").fetchone()[0] == "[]"
            assert conn.execute("SELECT COUNT(*) FROM episodes WHERE deleted = 0").fetchone()[0] == 2


# ----- API -----

@pytest.fixture()
def client(fresh_db):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(start_worker=False)) as c:
        yield c


def test_vocab_folder_api(client):
    w1 = client.post("/api/vocab", json={"text": "كتاب"}).json()
    w2 = client.post("/api/vocab", json={"text": "قلم"}).json()
    assert w1["folders"] == []
    f = client.post("/api/vocab/folders", json={"name": "  School  "}).json()
    assert f["name"] == "School" and f["uid"].startswith("d")
    assert client.post("/api/vocab/folders", json={"name": " "}).status_code == 400
    assert client.post("/api/vocab/bulk-folders", json={"ids": [w1["id"], w2["id"]], "add": [f["uid"]]}).json() == {"changed": 2}
    assert [v["text"] for v in client.get(f"/api/vocab?folder={f['uid']}").json()] == ["قلم", "كتاب"]
    client.patch(f"/api/vocab/{w2['id']}", json={"folders": []})
    assert [v["text"] for v in client.get("/api/vocab?folder=none").json()] == ["قلم"]
    client.patch(f"/api/vocab/folders/{f['uid']}", json={"name": "Class"})
    assert client.get("/api/vocab/folders").json()[0]["name"] == "Class"
    # Export exactly the words shown, in the order shown.
    csv = client.get(f"/api/vocab/export/csv?ids={w2['id']},{w1['id']}").text
    assert csv.index("قلم") < csv.index("كتاب")
    # Deleting a folder keeps its words and takes them out of it.
    client.delete(f"/api/vocab/folders/{f['uid']}")
    assert client.get("/api/vocab/folders").json() == []
    assert all(v["folders"] == [] for v in client.get("/api/vocab").json())
    assert len(client.get("/api/vocab").json()) == 2


def test_video_api_upload_list_and_delete(client, monkeypatch):
    monkeypatch.setattr(audio, "probe_duration", lambda p: 12.0)
    monkeypatch.setattr(jobs, "enqueue", lambda ids_: list(ids_))
    r = client.post("/api/videos?filename=Clip.mov", content=b"\x00" * 1000)
    assert r.status_code == 200, r.text
    ep = r.json()
    assert ep["audio_type"] == "video/quicktime"
    feeds = client.get("/api/feeds").json()
    mine = next(f for f in feeds if f["url"] == videos.LOCAL_FEED_URL)
    assert mine["episode_count"] == 1
    # The local file is served for playback, with Range support for seeking.
    part = client.get(f"/api/episodes/{ep['id']}/audio", headers={"Range": "bytes=0-9"})
    assert part.status_code == 206 and len(part.content) == 10
    assert client.delete(f"/api/feeds/{mine['id']}").status_code == 400, "My videos itself can't be removed"
    assert client.delete(f"/api/episodes/{ep['id']}").json() == {"ok": True}
    assert client.get(f"/api/episodes/{ep['id']}").status_code == 404
    assert client.get(f"/api/episodes?feed_id={mine['id']}").json()["total"] == 0
    assert client.post("/api/videos?filename=x.txt", content=b"abc").status_code == 400

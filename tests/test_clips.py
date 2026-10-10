"""Audio clips that travel with shared vocab words: cutting, storing, playing and syncing."""

from __future__ import annotations

import base64
import math
import struct
import wave

import pytest

from app import audio, db, paths
from app.sync import engine

from test_sync import FakeDrive, world  # noqa: F401  (pytest fixture)


def make_wav(path, seconds=12.0, rate=16000):
    """A real audio file: a tone that rises over time."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(seconds * rate)):
            t = i / rate
            frames += struct.pack("<h", int(12000 * math.sin(2 * math.pi * (220 + 40 * t) * t)))
        w.writeframes(bytes(frames))
    return path


def test_cut_clip_takes_the_requested_part(tmp_path):
    src = make_wav(tmp_path / "ep.wav")
    out = tmp_path / "clip.ogg"
    began = audio.cut_clip(src, 4.0, 7.0, out)
    assert 3.9 <= began <= 4.0, "the clip starts at (or a frame before) the requested time"
    assert 2.9 <= audio.probe_duration(out) <= 3.3
    assert out.stat().st_size < 40_000, "a few seconds of speech-quality audio is small"
    # Asking for more than the file has just gives what is there.
    audio.cut_clip(src, 10.5, 99.0, out)
    assert 1.2 <= audio.probe_duration(out) <= 1.8
    with pytest.raises(audio.AudioError):
        audio.cut_clip(src, 50.0, 55.0, out)


@pytest.fixture()
def client(fresh_db, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app

    (tmp_path / "clips").mkdir()
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(paths, "clips_dir", lambda: tmp_path / "clips")
    monkeypatch.setattr(paths, "tmp_dir", lambda: tmp_path / "tmp")
    with TestClient(create_app(start_worker=False)) as c:
        c.tmp = tmp_path
        yield c


def add_episode_word(client):
    """An episode with real audio and a vocab word saved from 5.0-5.6 s of a 4.5-7.5 s sentence."""
    src = make_wav(client.tmp / "episode.wav")
    with db.session() as conn:
        conn.execute("INSERT INTO feeds(url, uid, title, created_at) VALUES('https://x/rss', 'f1', 'Feed', 1)")
        conn.execute("INSERT INTO episodes(feed_id, uid, guid, title, audio_url, audio_path, status, created_at) "
                     "VALUES(1, 'e1', 'g', 'Episode', 'https://x/a.mp3', ?, 'done', 1)", (str(src),))
    return client.post("/api/vocab", json={"text": "كتاب", "sentence": "هذا كتاب جميل", "episode_id": 1, "start": 5.0,
                                           "end": 5.6, "sent_start": 4.5, "sent_end": 7.5, "meaning": "book"}).json()


def test_share_clip_then_receive_and_play(client):
    word = add_episode_word(client)
    assert word["clip"] == 0

    # Sender: the clip to send, with the word's and sentence's positions inside it.
    r = client.get(f"/api/vocab/{word['id']}/share-clip")
    assert r.status_code == 200, r.text
    clip = r.json()
    data = base64.b64decode(clip["audio"])
    t = clip["times"]
    assert data[:4] == b"OggS"
    assert 0.25 <= t["sent_start"] <= 0.36, "the sentence starts just after the short lead-in"
    assert abs((t["start"] - t["sent_start"]) - 0.5) < 0.01, "the word is 0.5 s into the sentence, as in the episode"
    assert abs((t["end"] - t["start"]) - 0.6) < 0.01 and abs((t["sent_end"] - t["sent_start"]) - 3.0) < 0.01

    # Recipient: save the word, then its clip; the word now plays from its own audio.
    got = client.post("/api/vocab", json={"text": "كتاب", "sentence": "هذا كتاب جميل", "meaning": "book"}).json()
    assert client.get(f"/api/vocab/{got['id']}/clip").status_code == 404
    saved = client.put(f"/api/vocab/{got['id']}/clip", params=t, content=data).json()
    assert saved["clip"] == 1 and saved["start"] == t["start"] and saved["sent_end"] == t["sent_end"]
    played = client.get(f"/api/vocab/{got['id']}/clip")
    assert played.status_code == 200 and played.content == data and played.headers["content-type"] == "audio/ogg"

    # Passing a received word on to someone else reuses its clip unchanged.
    again = client.get(f"/api/vocab/{got['id']}/share-clip").json()
    assert base64.b64decode(again["audio"]) == data and again["times"] == t


def test_words_without_audio_have_no_clip(client):
    manual = client.post("/api/vocab", json={"text": "قلم"}).json()
    assert client.get(f"/api/vocab/{manual['id']}/share-clip").status_code == 404
    assert client.put(f"/api/vocab/{manual['id']}/clip", content=b"").status_code == 400
    assert client.put("/api/vocab/999/clip", content=b"OggS").status_code == 404


def test_clip_syncs_to_the_users_other_device(world, monkeypatch):
    drive, a, b = world
    for dev in (a, b):
        (dev.dir / "clips").mkdir()
    with a:
        monkeypatch.setattr(paths, "clips_dir", lambda: a.dir / "clips")
        engine.clip_path("vword1").write_bytes(b"OggS-clip")
        with db.session() as conn:
            conn.execute("UPDATE vocab SET clip = 1, start = 0.5, end = 1.1, sent_start = 0.3, sent_end = 3.3 WHERE uid = 'vword1'")
    a.sync(drive)
    assert drive.by_name("c_vword1.ogg")["data"] == b"OggS-clip"
    lib = engine._ungz(drive.by_name("library.json.gz")["data"])
    assert next(v for v in lib["vocab"] if v["uid"] == "vword1")["clip"] == 1

    monkeypatch.setattr(paths, "clips_dir", lambda: b.dir / "clips")
    b.sync(drive)
    with b:
        with db.session() as conn:
            row = conn.execute("SELECT clip, start, sent_end FROM vocab WHERE uid = 'vword1'").fetchone()
        assert (row["clip"], row["start"], row["sent_end"]) == (1, 0.5, 3.3)
        assert engine.fetch_clip(drive, "vword1").read_bytes() == b"OggS-clip", "fetched when first played"

    # Deleting the word removes its clip from Drive.
    with a:
        monkeypatch.setattr(paths, "clips_dir", lambda: a.dir / "clips")
        with db.session() as conn:
            conn.execute("UPDATE vocab SET deleted = 1 WHERE uid = 'vword1'")
    a.sync(drive)
    assert drive.by_name("c_vword1.ogg") is None

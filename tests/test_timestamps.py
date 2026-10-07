"""Timestamp formatting, transcript storage/word lookup, exports, and queue recovery."""

import pytest

from app import exporters

SEGMENTS = [
    {"start": 0.0, "end": 2.5, "text": "مرحبا بكم"},
    {"start": 2.5, "end": 3661.042, "text": "في الحلقة"},
]


@pytest.mark.parametrize(
    "sec,srt,vtt",
    [(0, "00:00:00,000", "00:00:00.000"), (2.5, "00:00:02,500", "00:00:02.500"),
     (3661.042, "01:01:01,042", "01:01:01.042"), (59.9996, "00:01:00,000", "00:01:00.000"), (-1, "00:00:00,000", "00:00:00.000")],
)
def test_timestamp_formats(sec, srt, vtt):
    assert exporters.srt_timestamp(sec) == srt
    assert exporters.vtt_timestamp(sec) == vtt


def test_srt_and_vtt():
    srt = exporters.to_srt(SEGMENTS)
    assert srt.startswith("1\n00:00:00,000 --> 00:00:02,500\n‏مرحبا بكم\n")
    assert "2\n00:00:02,500 --> 01:01:01,042\n" in srt
    vtt = exporters.to_vtt(SEGMENTS)
    assert vtt.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:02.500\n")
    assert exporters.to_txt(SEGMENTS, "T") == "T\n\nمرحبا بكم\nفي الحلقة\n"


def test_anki_export_marks_word_in_sentence():
    out = exporters.vocab_to_anki([{"text": "كتاب", "sentence": "هذا كتاب جميل", "meaning": "book", "notes": "",
                                    "episode_title": "Ep", "start": 65.0, "end": 65.5}])
    lines = out.splitlines()
    assert lines[0] == "#separator:tab"
    row = lines[-1].split("\t")
    assert len(row) == 5
    assert "<b>كتاب</b>" in row[2]
    assert row[1] == "book"
    assert "00:01:05" in row[3]


def test_csv_has_bom_for_excel():
    out = exporters.vocab_to_csv([{"text": "كتاب", "sentence": "", "meaning": "book", "notes": "",
                                   "episode_title": "", "start": None, "end": None}])
    assert out.startswith("﻿")
    assert "كتاب,book" in out


def _seed_episode(conn, ep_id=1, status="new"):
    conn.execute("INSERT OR IGNORE INTO feeds(id, url, title, created_at) VALUES(1, 'u', 'F', 0)")
    conn.execute("INSERT INTO episodes(id, feed_id, guid, title, audio_url, created_at, status) VALUES(?,1,?,?,?,0,?)",
                 (ep_id, f"g{ep_id}", f"E{ep_id}", "http://x/a.mp3", status))


def test_store_and_transcript_endpoint_word_order(fresh_db):
    from fastapi.testclient import TestClient

    from app import db, jobs
    from app.main import create_app
    from app.transcriber import Segment, Word

    with db.session() as conn:
        _seed_episode(conn)
    segs = [
        Segment(0.0, 1.6, "مرحبا بكم.", [Word(0.0, 0.7, "مرحبا"), Word(0.8, 1.6, "بكم.")]),
        Segment(2.0, 3.0, "في الحلقة", []),  # no word timings -> spread evenly
    ]
    assert jobs._store(1, segs, "test") == 4
    with TestClient(create_app(start_worker=False)) as client:
        t = client.get("/api/episodes/1/transcript").json()
    w = t["words"]
    assert w["text"] == ["مرحبا", "بكم.", "في", "الحلقة"]
    assert w["seg"] == [0, 0, 1, 1]
    assert w["start"] == sorted(w["start"]), "word starts must be sorted for binary search"
    assert w["start"][2:] == [2.0, 2.5]
    assert t["episode"]["status"] == "done"


def test_recover_requeues_interrupted_jobs(fresh_db):
    from app import db, jobs

    with db.session() as conn:
        _seed_episode(conn, 1, "transcribing")
        _seed_episode(conn, 2, "queued")
        conn.execute("INSERT INTO jobs(episode_id, state, created_at) VALUES(1, 'running', 1)")
        conn.execute("INSERT INTO jobs(episode_id, state, created_at) VALUES(2, 'queued', 2)")
        conn.execute("INSERT INTO segments(episode_id, idx, start, end, text, norm) VALUES(1,0,0,1,'partial','partial')")
    jobs.recover()
    with db.session() as conn:
        states = [r[0] for r in conn.execute("SELECT state FROM jobs ORDER BY created_at")]
        assert states == ["queued", "queued"]
        assert conn.execute("SELECT status FROM episodes WHERE id=1").fetchone()[0] == "queued"
        assert conn.execute("SELECT COUNT(*) FROM segments WHERE episode_id=1").fetchone()[0] == 0
    # Oldest job is claimed first.
    assert jobs._claim_next()["episode_id"] == 1


def test_enqueue_skips_active_and_cancel_resets(fresh_db):
    from app import db, jobs

    with db.session() as conn:
        _seed_episode(conn, 1)
        _seed_episode(conn, 2, "transcribing")
    assert jobs.enqueue([1, 2]) == [1]
    assert jobs.enqueue([1]) == []  # already queued
    jobs.cancel(1)
    with db.session() as conn:
        assert conn.execute("SELECT status FROM episodes WHERE id=1").fetchone()[0] == "new"
        assert conn.execute("SELECT state FROM jobs WHERE episode_id=1").fetchone()[0] == "cancelled"

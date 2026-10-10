"""Imported web pages ("My webpages"): storage, API and sync between two devices."""

from __future__ import annotations

import pytest

from app import db, ids, pages
from app.sync import engine

from test_sync import FakeDrive, world  # noqa: F401  (pytest fixture)

BLOCKS = [
    {"kind": "h2", "text": "القهوة العربية"},
    {"kind": "p", "text": "القهوة   مشروب  يُحضر من بذور البن."},
    {"kind": "li", "text": "حبوب البن"},
    {"kind": "weird", "text": "Unknown kinds become paragraphs"},
    {"kind": "p", "text": "   "},
]


def test_save_page_stores_blocks_as_clickable_text(world):
    _, a, _ = world
    with a:
        ep = pages.save_page("example.com/coffee", "  القهوة  ", BLOCKS, image="https://example.com/i.jpg")
        assert ep["audio_url"] == "https://example.com/coffee" and ep["audio_type"] == "text/html"
        assert ep["status"] == "done" and ep["title"] == "القهوة" and ep["words"] == 14
        with db.session() as conn:
            feed = conn.execute("SELECT url, uid FROM feeds WHERE id = ?", (ep["feed_id"],)).fetchone()
            segs = conn.execute("SELECT kind, text FROM segments WHERE episode_id = ? ORDER BY idx", (ep["id"],)).fetchall()
            words = [w[0] for w in conn.execute("SELECT text FROM words WHERE episode_id = ? ORDER BY idx", (ep["id"],))]
            hits = conn.execute("SELECT COUNT(*) FROM segments_fts WHERE episode_id = ?", (ep["id"],)).fetchone()[0]
        assert feed["url"] == pages.LOCAL_FEED_URL
        assert ep["uid"] == ids.episode_uid(feed["uid"], "https://example.com/coffee")
        assert [s["kind"] for s in segs] == ["h2", "p", "li", "p"]
        assert segs[1]["text"] == "القهوة مشروب يُحضر من بذور البن.", "whitespace is tidied"
        assert words[:2] == ["القهوة", "العربية"] and len(words) == 14
        assert hits == 4, "imported pages are searchable"


def test_reimporting_replaces_instead_of_duplicating(world):
    _, a, _ = world
    with a:
        first = pages.save_page("https://example.com/a", "One", BLOCKS)
        again = pages.save_page("https://example.com/a", "Two", [{"kind": "p", "text": "جديد تماما"}])
        assert again["id"] == first["id"] and again["title"] == "Two" and again["words"] == 2
        assert again["transcribed_at"] >= first["transcribed_at"]
        with db.session() as conn:
            assert conn.execute("SELECT COUNT(*) FROM words WHERE episode_id = ?", (first["id"],)).fetchone()[0] == 2


def test_rejects_bad_addresses_and_empty_pages(world):
    _, a, _ = world
    with a:
        for bad in ("", "ftp://x.com/file", "javascript:alert(1)"):
            with pytest.raises(pages.PageError):
                pages.save_page(bad, "t", BLOCKS)
        with pytest.raises(pages.PageError):
            pages.save_page("https://example.com", "t", [{"kind": "p", "text": "  "}])


def test_browser_start_address():
    assert pages.browser_start("") == pages.BROWSER_HOME
    assert pages.browser_start("aljazeera.net") == "https://aljazeera.net"
    assert pages.browser_start("https://bbc.com/arabic") == "https://bbc.com/arabic"
    assert pages.browser_start("arabic news").startswith("https://www.google.com/search?q=arabic%20news")


def test_extractor_source_is_plain_script():
    src = pages.extractor_source()
    assert "function extractArticle(doc, url)" in src and "export" not in src.split("function extractArticle")[1]


def test_page_syncs_to_another_device_with_headings(world):
    drive, a, b = world
    with a:
        ep = pages.save_page("https://example.com/coffee", "القهوة", BLOCKS)
    r = a.sync(drive)
    assert r.uploaded_transcripts >= 1 and r.uploaded_audio == 0
    payload = engine._ungz(drive.by_name(engine.transcript_name(ep["uid"]))["data"])
    assert payload["kinds"] == ["h2", "p", "li", "p"] and payload["model"] == "webpage"
    rb = b.sync(drive)
    with b:
        with db.session() as conn:
            row = conn.execute("SELECT * FROM episodes WHERE uid = ?", (ep["uid"],)).fetchone()
            assert row["feed_id"] not in rb.new_feeds, "My webpages has no RSS to fetch"
            kinds = [s[0] for s in conn.execute("SELECT kind FROM segments WHERE episode_id = ? ORDER BY idx", (row["id"],))]
        assert row["status"] == "done" and row["audio_type"] == "text/html"
        assert kinds == ["h2", "p", "li", "p"]


def test_podcast_transcripts_keep_their_old_format(world):
    drive, a, _ = world
    a.sync(drive)
    uid = ids.episode_uid(ids.feed_uid("https://example.com/rss"), "g1")
    payload = engine._ungz(drive.by_name(engine.transcript_name(uid))["data"])
    assert "kinds" not in payload


# ----- API -----

@pytest.fixture()
def client(fresh_db):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(start_worker=False)) as c:
        yield c


def test_page_api_import_read_delete(client, monkeypatch):
    r = client.post("/api/pages", json={"url": "https://example.com/coffee", "title": "القهوة", "blocks": BLOCKS})
    assert r.status_code == 200, r.text
    ep = r.json()
    t = client.get(f"/api/episodes/{ep['id']}/transcript").json()
    assert [s["kind"] for s in t["segments"]] == ["h2", "p", "li", "p"]
    assert t["episode"]["audio_type"] == "text/html" and len(t["words"]["text"]) == 14
    feeds = client.get("/api/feeds").json()
    mine = next(f for f in feeds if f["url"] == pages.LOCAL_FEED_URL)
    assert mine["episode_count"] == 1 and mine["done_count"] == 1
    assert client.get("/api/search?q=القهوة").json()["total"] >= 1
    assert client.post("/api/pages", json={"url": "https://x.com", "title": "", "blocks": []}).status_code == 400
    assert client.delete(f"/api/feeds/{mine['id']}").status_code == 400
    assert client.delete(f"/api/episodes/{ep['id']}").json() == {"ok": True}
    assert client.get(f"/api/episodes?feed_id={mine['id']}").json()["total"] == 0

    monkeypatch.setattr(pages, "fetch_html", lambda url: {"url": url, "html": "<p>hi</p>"})
    assert client.get("/api/web/fetch?url=https://example.com").json()["html"] == "<p>hi</p>"

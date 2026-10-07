"""RSS parsing: normal feeds, odd/missing fields, and persistence."""

import pytest

from app import feeds
from tests.conftest import FIXTURES


def load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_parses_normal_itunes_feed():
    feed = feeds.parse_feed(load("feed_normal.xml"))
    assert feed.title == "بودكاست تجريبي"
    assert feed.image == "https://example.com/cover.jpg"
    assert len(feed.episodes) == 3
    first = feed.episodes[0]
    assert first.guid == "ep-3"
    assert first.title == "الحلقة الثالثة"
    assert first.audio_url == "https://cdn.example.com/ep3.mp3"
    assert first.audio_type == "audio/mpeg"
    assert first.duration == 3723  # 1:02:03
    assert first.published is not None
    assert first.image == "https://example.com/ep3.jpg"
    # Episode without its own artwork falls back to the show's.
    assert feed.episodes[1].image == "https://example.com/cover.jpg"
    assert feed.episodes[1].duration == 754  # "12:34"
    assert feed.episodes[2].duration == 95  # "95"


def test_tolerates_missing_and_odd_fields():
    feed = feeds.parse_feed(load("feed_messy.xml"))
    assert feed.title  # falls back rather than crashing
    titles = [e.title for e in feed.episodes]
    # Entry without any enclosure is skipped; entry without title gets a placeholder.
    assert "No audio here" not in titles
    assert "Untitled episode" in titles
    guids = [e.guid for e in feed.episodes]
    assert len(guids) == len(set(guids)), "duplicate GUIDs must be disambiguated"
    by_url = {e.audio_url: e for e in feed.episodes}
    # Missing guid -> audio URL used as the id.
    assert "https://cdn.example.com/no-guid.m4a" in by_url
    assert by_url["https://cdn.example.com/no-guid.m4a"].guid == "https://cdn.example.com/no-guid.m4a"
    # Garbage duration and missing date don't crash.
    junk = by_url["https://cdn.example.com/junk.mp3"]
    assert junk.duration is None
    assert junk.published is None
    # Enclosure with no type but an audio extension is accepted.
    assert "https://cdn.example.com/untyped.ogg?x=1" in by_url


def test_rejects_non_feed():
    with pytest.raises(feeds.FeedError):
        feeds.parse_feed(b"<html><body>Not a feed</body></html>")


@pytest.mark.parametrize(
    "value,expected",
    [("3723", 3723), ("1:02:03", 3723), ("62:03", 3723), ("00:45.5", 45.5), ("", None), (None, None),
     ("abc", None), ("1:2:3:4", None), (" 90 ", 90)],
)
def test_parse_duration(value, expected):
    assert feeds.parse_duration(value) == expected


@pytest.mark.parametrize(
    "url,expected",
    [("feed://example.com/rss", "https://example.com/rss"),
     ("example.com/rss", "https://example.com/rss"),
     ("  https://example.com/rss  ", "https://example.com/rss"),
     ("itpc://example.com/rss", "https://example.com/rss")],
)
def test_normalize_url(url, expected):
    assert feeds.normalize_url(url) == expected


def test_add_and_refresh_upserts_without_duplicates(fresh_db, monkeypatch):
    from app import db, jobs

    content = load("feed_normal.xml")
    monkeypatch.setattr(feeds, "fetch", lambda url, etag=None, modified=None: (content, url, None, None))
    queued = []
    monkeypatch.setattr(jobs, "enqueue", lambda ids: queued.extend(ids) or list(ids))

    feed = feeds.add_feed("https://example.com/rss")
    with db.session() as conn:
        assert conn.execute("SELECT COUNT(*) FROM episodes").fetchone()[0] == 3

    # Same content again: nothing new, nothing queued even with auto-transcribe on.
    with db.session() as conn:
        conn.execute("UPDATE feeds SET auto_transcribe = 1 WHERE id = ?", (feed["id"],))
    assert feeds.refresh_feed(feed["id"]) == []
    assert queued == []

    # A new episode appears: it's inserted and auto-queued.
    newer = content.replace(b"<item>", b"""<item><title>new</title><guid>ep-4</guid>
        <enclosure url="https://cdn.example.com/ep4.mp3" type="audio/mpeg" length="1"/></item><item>""", 1)
    monkeypatch.setattr(feeds, "fetch", lambda url, etag=None, modified=None: (newer, url, None, None))
    new_ids = feeds.refresh_feed(feed["id"])
    assert len(new_ids) == 1
    assert queued == new_ids

    with pytest.raises(feeds.FeedError):
        feeds.add_feed("https://example.com/rss")  # already subscribed


def test_refresh_failure_is_recorded_not_raised(fresh_db, monkeypatch):
    from app import db

    content = load("feed_normal.xml")
    monkeypatch.setattr(feeds, "fetch", lambda url, etag=None, modified=None: (content, url, None, None))
    feed = feeds.add_feed("https://example.com/rss")

    def boom(*a, **k):
        raise feeds.FeedError("Couldn't reach the feed")

    monkeypatch.setattr(feeds, "fetch", boom)
    assert feeds.refresh_feed(feed["id"]) == []
    with db.session() as conn:
        assert "Couldn't reach" in conn.execute("SELECT last_error FROM feeds").fetchone()[0]

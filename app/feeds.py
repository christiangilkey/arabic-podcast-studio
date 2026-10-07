"""RSS subscriptions: fetch, parse defensively, and upsert episodes."""

from __future__ import annotations

import calendar
import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import feedparser
import httpx

from . import db, events
from .version import APP_NAME, __version__

log = logging.getLogger(__name__)

USER_AGENT = f"{APP_NAME.replace(' ', '')}/{__version__} (+podcast reader)"
AUDIO_EXTENSIONS = (".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac", ".mp4", ".oga", ".webm")


class FeedError(RuntimeError):
    pass


@dataclass
class ParsedEpisode:
    guid: str
    title: str
    audio_url: str
    audio_type: str | None = None
    description: str = ""
    published: float | None = None
    duration: float | None = None
    image: str | None = None


@dataclass
class ParsedFeed:
    title: str
    description: str = ""
    link: str | None = None
    image: str | None = None
    episodes: list[ParsedEpisode] = field(default_factory=list)


# --- parsing (pure; covered by tests) ----------------------------------------------------

def parse_duration(value: Any) -> float | None:
    """Parse itunes:duration: '3723', '1:02:03', '62:03', '00:45.5', or junk."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    parts = text.split(":")
    if 2 <= len(parts) <= 3 and all(re.fullmatch(r"\d+(\.\d+)?", p.strip()) for p in parts):
        total = 0.0
        for p in parts:
            total = total * 60 + float(p)
        return total
    return None


def _struct_to_ts(st: Any) -> float | None:
    try:
        return float(calendar.timegm(st)) if st else None
    except (TypeError, ValueError, OverflowError):
        return None


def _get(obj: Any, key: str, default: Any = None) -> Any:
    try:
        value = obj.get(key, default)
    except AttributeError:
        return default
    return default if value is None else value


def _clean_text(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_audio(url: str, mime: str | None) -> bool:
    if mime and (mime.startswith("audio/") or mime in ("video/mp4", "application/ogg", "video/x-m4v")):
        return True
    path = url.split("?", 1)[0].lower()
    return path.endswith(AUDIO_EXTENSIONS)


def _find_audio(entry: Any) -> tuple[str, str | None] | None:
    candidates: list[tuple[str, str | None]] = []
    for enc in _get(entry, "enclosures", []) or []:
        href = _get(enc, "href") or _get(enc, "url")
        if href:
            candidates.append((str(href), _get(enc, "type")))
    for media in _get(entry, "media_content", []) or []:
        href = _get(media, "url")
        if href:
            candidates.append((str(href), _get(media, "type")))
    for link in _get(entry, "links", []) or []:
        if _get(link, "rel") == "enclosure" and _get(link, "href"):
            candidates.append((str(link["href"]), _get(link, "type")))
    for url, mime in candidates:
        if _is_audio(url, mime):
            return url.strip(), mime
    # An enclosure with an unknown type is still most likely the episode audio.
    if candidates:
        return candidates[0][0].strip(), candidates[0][1]
    return None


def _image_of(obj: Any) -> str | None:
    image = _get(obj, "image")
    if image:
        href = _get(image, "href") or _get(image, "url")
        if href:
            return str(href)
    for thumb in _get(obj, "media_thumbnail", []) or []:
        if _get(thumb, "url"):
            return str(thumb["url"])
    itunes = _get(obj, "itunes_image")
    if isinstance(itunes, str) and itunes:
        return itunes
    return None


def parse_feed(content: bytes | str) -> ParsedFeed:
    parsed = feedparser.parse(content)
    feed = parsed.get("feed", {}) or {}
    entries = parsed.get("entries", []) or []
    if not entries and not feed.get("title"):
        reason = parsed.get("bozo_exception")
        raise FeedError(
            "This doesn't look like a podcast RSS feed"
            + (f" ({reason})." if reason else ".")
        )

    feed_image = _image_of(feed)
    out = ParsedFeed(
        title=_clean_text(feed.get("title")) or "Untitled podcast",
        description=_clean_text(feed.get("subtitle") or feed.get("description") or ""),
        link=feed.get("link"),
        image=feed_image,
    )
    seen: set[str] = set()
    for entry in entries:
        audio = _find_audio(entry)
        if not audio:
            continue
        audio_url, mime = audio
        title = _clean_text(_get(entry, "title")) or "Untitled episode"
        guid = str(_get(entry, "id") or audio_url or _get(entry, "link") or "").strip()
        if not guid:
            guid = hashlib.sha1(title.encode("utf-8")).hexdigest()
        if guid in seen:
            # Duplicate GUIDs happen in sloppy feeds; disambiguate by audio URL.
            guid = f"{guid}#{hashlib.sha1(audio_url.encode('utf-8')).hexdigest()[:10]}"
            if guid in seen:
                continue
        seen.add(guid)
        out.episodes.append(
            ParsedEpisode(
                guid=guid,
                title=title,
                audio_url=audio_url,
                audio_type=mime,
                description=_clean_text(_get(entry, "summary") or _get(entry, "subtitle"))[:4000],
                published=_struct_to_ts(_get(entry, "published_parsed") or _get(entry, "updated_parsed")),
                duration=parse_duration(_get(entry, "itunes_duration")),
                image=_image_of(entry) or feed_image,
            )
        )
    return out


# --- network -------------------------------------------------------------------------------

def fetch(url: str, etag: str | None = None, modified: str | None = None) -> tuple[bytes | None, str, str | None, str | None]:
    """GET a feed following redirects. Returns (content or None if not modified, final_url, etag, modified)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"}
    if etag:
        headers["If-None-Match"] = etag
    if modified:
        headers["If-Modified-Since"] = modified
    try:
        with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, connect=15), headers=headers) as client:
            resp = client.get(url)
    except httpx.HTTPError as exc:
        raise FeedError(f"Couldn't reach the feed: {exc.__class__.__name__}: {exc}") from exc
    if resp.status_code == 304:
        return None, str(resp.url), etag, modified
    if resp.status_code >= 400:
        raise FeedError(f"The feed server returned HTTP {resp.status_code}.")
    return resp.content, str(resp.url), resp.headers.get("etag"), resp.headers.get("last-modified")


def normalize_url(url: str) -> str:
    url = url.strip()
    if url.startswith("feed://"):
        url = "https://" + url[len("feed://"):]
    elif url.startswith("itpc://") or url.startswith("pcast://"):
        url = "https://" + url.split("://", 1)[1]
    elif not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url


# --- persistence -----------------------------------------------------------------------------

def _upsert_episodes(conn: Any, feed_id: int, parsed: ParsedFeed) -> list[int]:
    """Insert new episodes and refresh metadata of existing ones. Returns ids of new episodes."""
    new_ids: list[int] = []
    now = time.time()
    for ep in parsed.episodes:
        row = conn.execute("SELECT id FROM episodes WHERE feed_id = ? AND guid = ?", (feed_id, ep.guid)).fetchone()
        if row:
            conn.execute(
                "UPDATE episodes SET title=?, description=?, published=COALESCE(?, published), "
                "duration=COALESCE(duration, ?), image=?, audio_url=?, audio_type=? WHERE id=?",
                (ep.title, ep.description, ep.published, ep.duration, ep.image, ep.audio_url, ep.audio_type, row["id"]),
            )
        else:
            cur = conn.execute(
                "INSERT INTO episodes(feed_id, guid, title, description, published, duration, image, "
                "audio_url, audio_type, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (feed_id, ep.guid, ep.title, ep.description, ep.published, ep.duration, ep.image,
                 ep.audio_url, ep.audio_type, now),
            )
            new_ids.append(int(cur.lastrowid))
    return new_ids


def add_feed(url: str) -> dict[str, Any]:
    url = normalize_url(url)
    with db.session() as conn:
        existing = conn.execute("SELECT * FROM feeds WHERE url = ?", (url,)).fetchone()
    if existing:
        raise FeedError("You're already subscribed to this feed.")
    content, final_url, etag, modified = fetch(url)
    assert content is not None
    parsed = parse_feed(content)
    with db.session() as conn:
        if final_url != url and conn.execute("SELECT 1 FROM feeds WHERE url = ?", (final_url,)).fetchone():
            raise FeedError("You're already subscribed to this feed.")
        cur = conn.execute(
            "INSERT INTO feeds(url, title, description, image, link, last_checked, etag, modified, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (final_url, parsed.title, parsed.description, parsed.image, parsed.link, time.time(), etag, modified, time.time()),
        )
        feed_id = int(cur.lastrowid)
        _upsert_episodes(conn, feed_id, parsed)
        feed = db.row_to_dict(conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone())
    assert feed is not None
    return feed


def refresh_feed(feed_id: int) -> list[int]:
    """Re-check one feed. Returns new episode ids (and queues them if auto-transcribe is on)."""
    from . import jobs  # local import: jobs imports feeds-independent modules only

    with db.session() as conn:
        feed = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
    if feed is None:
        return []
    try:
        content, final_url, etag, modified = fetch(feed["url"], feed["etag"], feed["modified"])
        new_ids: list[int] = []
        with db.session() as conn:
            if content is not None:
                parsed = parse_feed(content)
                new_ids = _upsert_episodes(conn, feed_id, parsed)
                conn.execute(
                    "UPDATE feeds SET title=?, description=?, image=COALESCE(?, image), link=?, etag=?, modified=? WHERE id=?",
                    (parsed.title, parsed.description, parsed.image, parsed.link, etag, modified, feed_id),
                )
            conn.execute("UPDATE feeds SET last_checked=?, last_error=NULL WHERE id=?", (time.time(), feed_id))
    except Exception as exc:
        log.warning("Refreshing feed %s failed: %s", feed_id, exc)
        with db.session() as conn:
            conn.execute("UPDATE feeds SET last_checked=?, last_error=? WHERE id=?", (time.time(), str(exc), feed_id))
        return []
    if new_ids and feed["auto_transcribe"]:
        jobs.enqueue(new_ids)
    return new_ids


def refresh_all() -> int:
    with db.session() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM feeds").fetchall()]
    total = 0
    for feed_id in ids:
        total += len(refresh_feed(feed_id))
    events.publish("feeds", {"refreshed": True, "new_episodes": total})
    return total

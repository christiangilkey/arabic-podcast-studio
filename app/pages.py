"""Imported web pages: kept in a built-in "My webpages" feed and read with clickable words.

A page is an ordinary episode whose "transcript" is the page's text, so the word popup, vocab,
search and Drive sync all work unchanged. What marks it out:
    audio_url    the page's address
    audio_type   "text/html"
    status       "done" from the start (there is nothing to transcribe)
Each block of the page (heading, paragraph, list item, quote) is one segment; `segments.kind`
holds the block type. Words have no real timings: their "time" is simply their position.
"""

from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import arabic, db, ids

LOCAL_FEED_URL = "local:pages"
LOCAL_FEED_TITLE = "My webpages"
PAGE_TYPE = "text/html"
KINDS = {"h1", "h2", "h3", "p", "li", "q"}
MAX_WORDS = 30000
MAX_HTML_BYTES = 6 * 1024 * 1024
BROWSER_HOME = "https://www.google.com/"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0 Safari/537.36")


class PageError(RuntimeError):
    pass


def clean_url(url: str) -> str:
    url = (url or "").strip()
    if re.match(r"(?i)^(javascript|data|file|vbscript|about|blob|chrome|edge):", url):
        raise PageError("Paste a web address, like https://example.com/article")
    if url and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = "https://" + url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PageError("Paste a web address, like https://example.com/article")
    return url


def browser_start(text: str) -> str:
    """Where the in-app browser should open: the typed address, a web search for the typed
    words, or a search page when nothing was typed."""
    from urllib.parse import quote

    text = (text or "").strip()
    if not text:
        return BROWSER_HOME
    if " " not in text and ("." in text or "://" in text):
        try:
            return clean_url(text)
        except PageError:
            pass
    return "https://www.google.com/search?q=" + quote(text)


def extractor_source() -> str:
    """web/js/extract.js as plain script text (its final `export` line removed), for running
    inside a page shown in the in-app browser."""
    from . import paths

    source = (paths.web_dir() / "js" / "extract.js").read_text(encoding="utf-8")
    return re.sub(r"(?m)^export \{[^}]*\};?\s*$", "", source)


def fetch_html(url: str) -> dict[str, str]:
    """Download a page the way a browser would. Returns {"url": final address, "html": ...}."""
    url = clean_url(url)
    try:
        with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, connect=15),
                          headers={"User-Agent": BROWSER_UA, "Accept-Language": "ar,en;q=0.8"}) as client:
            with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    raise PageError(f"The site answered with an error ({resp.status_code}). "
                                    "Try “Open Web Browser” and use Import Page there.")
                kind = resp.headers.get("content-type", "")
                if kind and "html" not in kind and "text/plain" not in kind:
                    raise PageError("That address isn't a web page (it looks like a file).")
                data = b""
                for chunk in resp.iter_bytes(1 << 16):
                    data += chunk
                    if len(data) > MAX_HTML_BYTES:
                        break
                encoding = resp.charset_encoding
                final = str(resp.url)
    except httpx.HTTPError as exc:
        raise PageError(f"Couldn't reach that site ({exc.__class__.__name__}).") from exc
    if not encoding:
        m = re.search(rb"<meta[^>]+charset=[\"']?\s*([\w-]+)", data[:4096], re.I)
        encoding = m.group(1).decode("ascii", "replace") if m else "utf-8"
    try:
        html = data.decode(encoding, "replace")
    except LookupError:
        html = data.decode("utf-8", "replace")
    return {"url": final, "html": html}


def ensure_feed(conn: Any) -> int:
    row = conn.execute("SELECT id, deleted FROM feeds WHERE url = ?", (LOCAL_FEED_URL,)).fetchone()
    if row is not None:
        if row["deleted"]:
            conn.execute("UPDATE feeds SET deleted = 0 WHERE id = ?", (row["id"],))
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO feeds(uid, url, title, description, created_at) VALUES(?,?,?,?,?)",
        (ids.feed_uid(LOCAL_FEED_URL), LOCAL_FEED_URL, LOCAL_FEED_TITLE,
         "Web pages you imported to read with clickable words.", time.time()))
    return int(cur.lastrowid)


def clean_blocks(blocks: list[dict[str, Any]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    words = 0
    for b in blocks or []:
        text = " ".join(str(b.get("text") or "").split())
        if not text:
            continue
        kind = b.get("kind") if b.get("kind") in KINDS else "p"
        tokens = text.split(" ")
        if words + len(tokens) > MAX_WORDS:
            tokens = tokens[:MAX_WORDS - words]
            text = " ".join(tokens)
        if not tokens:
            break
        words += len(tokens)
        out.append((kind, text))
    return out


def save_page(url: str, title: str, blocks: list[dict[str, Any]], image: str | None = None,
              site: str | None = None) -> dict[str, Any]:
    """Create (or refresh) the page's episode and store its text. Returns the episode row."""
    url = clean_url(url)
    items = clean_blocks(blocks)
    if not items:
        raise PageError("No readable text was found on that page.")
    title = " ".join((title or "").split())[:300] or urlsplit(url).hostname or "Web page"
    image = image if image and image.startswith("https://") else None
    host = site or (urlsplit(url).hostname or "").removeprefix("www.")
    now = time.time()
    with db.session() as conn:
        feed_id = ensure_feed(conn)
        feed_uid = conn.execute("SELECT uid FROM feeds WHERE id = ?", (feed_id,)).fetchone()["uid"]
        uid = ids.episode_uid(feed_uid, url)
        row = conn.execute("SELECT id FROM episodes WHERE uid = ?", (uid,)).fetchone()
        if row is None:
            cur = conn.execute(
                "INSERT INTO episodes(feed_id, uid, guid, title, description, published, image, audio_url, audio_type, "
                "created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (feed_id, uid, url, title, host[:200], now, image, url, PAGE_TYPE, now))
            ep_id = int(cur.lastrowid)
        else:
            ep_id = int(row["id"])
            conn.execute("UPDATE episodes SET title = ?, description = ?, image = ?, deleted = 0 WHERE id = ?",
                         (title, host[:200], image, ep_id))
            for table in ("words", "segments", "segments_fts"):
                conn.execute(f"DELETE FROM {table} WHERE episode_id = ?", (ep_id,))
        widx = 0
        for sidx, (kind, text) in enumerate(items):
            tokens = text.split(" ")
            norm = arabic.normalize(text)
            conn.execute(
                "INSERT INTO segments(episode_id, idx, start, end, text, norm, kind) VALUES(?,?,?,?,?,?,?)",
                (ep_id, sidx, float(widx), float(widx + len(tokens)), text, norm, kind))
            conn.execute("INSERT INTO segments_fts(norm, episode_id, seg_idx) VALUES(?,?,?)", (norm, ep_id, sidx))
            conn.executemany(
                "INSERT INTO words(episode_id, idx, seg_idx, start, end, text) VALUES(?,?,?,?,?,?)",
                [(ep_id, widx + i, sidx, float(widx + i), float(widx + i + 1), t) for i, t in enumerate(tokens)])
            widx += len(tokens)
        # A fresh transcribed_at makes sync publish the text to the user's other devices.
        conn.execute(
            "UPDATE episodes SET status = 'done', progress = 100, error = NULL, model = 'webpage', "
            "transcribed_at = ?, duration = NULL WHERE id = ?", (now, ep_id))
        out = dict(conn.execute("SELECT * FROM episodes WHERE id = ?", (ep_id,)).fetchone())
    out["words"] = widx
    return out

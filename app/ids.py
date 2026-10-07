"""Global identifiers shared across devices.

Feeds and episodes get deterministic ids (two devices subscribing to the same feed agree
without talking to each other); vocab items get random ids.
"""

from __future__ import annotations

import hashlib
import uuid


def _h(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:20]


def feed_uid(url: str) -> str:
    return "f" + _h(url.strip().lower())


def episode_uid(feed_uid_: str, guid: str) -> str:
    return "e" + _h(f"{feed_uid_}\0{guid}")


def new_uid() -> str:
    return "v" + uuid.uuid4().hex[:20]

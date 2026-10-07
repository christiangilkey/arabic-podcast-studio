"""In-process event bus feeding Server-Sent Events.

Background threads call :func:`publish`; each connected browser has an asyncio queue
on the server's event loop.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

_loop: asyncio.AbstractEventLoop | None = None
_clients: set[asyncio.Queue[str]] = set()
_lock = threading.Lock()
_last_client_seen = time.monotonic()


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def client_count() -> int:
    return len(_clients)


def seconds_since_last_client() -> float:
    if _clients:
        return 0.0
    return time.monotonic() - _last_client_seen


def publish(event: str, data: dict[str, Any]) -> None:
    """Thread-safe: broadcast an event to every connected client."""
    loop = _loop
    if loop is None or loop.is_closed():
        return
    payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    def _deliver() -> None:
        for q in list(_clients):
            if q.qsize() < 1000:
                q.put_nowait(payload)

    try:
        loop.call_soon_threadsafe(_deliver)
    except RuntimeError:
        pass  # loop shutting down


async def stream() -> AsyncIterator[str]:
    global _last_client_seen
    q: asyncio.Queue[str] = asyncio.Queue()
    with _lock:
        _clients.add(q)
    try:
        yield "retry: 2000\n\n"
        while True:
            try:
                yield await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
    finally:
        with _lock:
            _clients.discard(q)
            _last_client_seen = time.monotonic()

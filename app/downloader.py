"""Streaming HTTP downloads with resume, progress callbacks and optional checksum checks."""

from __future__ import annotations

import hashlib
import mimetypes
import os
import threading
from collections.abc import Callable
from pathlib import Path

import httpx

from .feeds import USER_AGENT

ProgressFn = Callable[[int, int | None], None]  # (bytes_done, bytes_total or None)

CHUNK = 1 << 16


class DownloadError(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


def guess_extension(url: str, content_type: str | None) -> str:
    path_ext = os.path.splitext(url.split("?", 1)[0])[1].lower()
    if path_ext and 2 <= len(path_ext) <= 6:
        return path_ext
    if content_type:
        ext = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if ext:
            return ".mp3" if ext == ".mpga" else ext
    return ".mp3"


def download(
    url: str,
    dest: Path,
    progress: ProgressFn | None = None,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
    cancel: threading.Event | None = None,
) -> Path:
    """Download ``url`` to ``dest``, resuming from ``dest.part`` if present.

    The file is only moved into place once complete (and its checksum, if given, matches).
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    if expected_size is not None and have > expected_size:
        part.unlink()
        have = 0

    headers = {"User-Agent": USER_AGENT}
    if have:
        headers["Range"] = f"bytes={have}-"
    timeout = httpx.Timeout(60, connect=20)
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout) as client:
            with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code == 416 and have:
                    # Range not satisfiable: the .part file is already complete.
                    total = have
                elif resp.status_code >= 400:
                    raise DownloadError(f"Download failed: HTTP {resp.status_code} from {resp.url.host}.")
                else:
                    if resp.status_code != 206:
                        have = 0  # server ignored Range; start over
                    length = resp.headers.get("content-length")
                    total = have + int(length) if length and length.isdigit() else (expected_size or None)
                    with open(part, "ab" if have else "wb") as fh:
                        done = have
                        for chunk in resp.iter_bytes(CHUNK):
                            if cancel is not None and cancel.is_set():
                                raise Cancelled("Download cancelled.")
                            fh.write(chunk)
                            done += len(chunk)
                            if progress:
                                progress(done, total)
    except httpx.HTTPError as exc:
        raise DownloadError(f"Network error while downloading: {exc.__class__.__name__}: {exc}") from exc

    size = part.stat().st_size
    if expected_size is not None and size != expected_size:
        raise DownloadError(f"Download incomplete ({size} of {expected_size} bytes). Try again to resume.")
    if expected_sha256:
        digest = sha256_file(part)
        if digest.lower() != expected_sha256.lower():
            part.unlink(missing_ok=True)
            raise DownloadError("Checksum mismatch: the downloaded file is corrupt. Please try again.")
    os.replace(part, dest)
    return dest


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def git_blob_sha1(path: Path) -> str:
    """Hash used by Hugging Face for small (non-LFS) files."""
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()

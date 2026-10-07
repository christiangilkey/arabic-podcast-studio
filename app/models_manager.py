"""Whisper model downloads: resumable, checksum-verified, one at a time."""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from . import downloader, events, hardware, paths

log = logging.getLogger(__name__)

HF = "https://huggingface.co"

# User-facing sizes. "tiny" exists for smoke tests only.
SIZES = ["small", "medium", "large-v3"]

REPOS: dict[str, dict[str, str]] = {
    "faster-whisper": {
        "tiny": "Systran/faster-whisper-tiny",
        "small": "Systran/faster-whisper-small",
        "medium": "Systran/faster-whisper-medium",
        "large-v3": "Systran/faster-whisper-large-v3",
    },
    "mlx": {
        "tiny": "mlx-community/whisper-tiny-mlx",
        "small": "mlx-community/whisper-small-mlx",
        "medium": "mlx-community/whisper-medium-mlx",
        "large-v3": "mlx-community/whisper-large-v3-mlx",
    },
}

APPROX_MB = {"tiny": 75, "small": 485, "medium": 1530, "large-v3": 3090}
SKIP_FILES = {".gitattributes", "README.md"}

_lock = threading.Lock()
_cancel = threading.Event()
_state: dict[str, Any] = {"state": "idle", "size": None, "done": 0, "total": 0, "error": None}


class ModelError(RuntimeError):
    pass


def current_engine() -> str:
    return hardware.detect().engine


def model_dir(size: str, engine: str | None = None) -> Path:
    return paths.models_dir() / (engine or current_engine()) / size


def is_installed(size: str, engine: str | None = None) -> bool:
    return (model_dir(size, engine) / "manifest.json").exists()


def list_models() -> list[dict[str, Any]]:
    engine = current_engine()
    out = []
    for size in SIZES:
        d = model_dir(size, engine)
        installed = is_installed(size, engine)
        disk = sum(f.stat().st_size for f in d.glob("*") if f.is_file()) if d.exists() else 0
        out.append({"size": size, "engine": engine, "installed": installed, "approx_mb": APPROX_MB[size],
                    "disk_mb": round(disk / 2**20), "partial": (not installed) and disk > 0})
    return out


def status() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def _set(**kw: Any) -> None:
    with _lock:
        _state.update(kw)
        snapshot = dict(_state)
    events.publish("model_download", snapshot)


def _file_list(repo: str) -> tuple[str, list[dict[str, Any]]]:
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        info = client.get(f"{HF}/api/models/{repo}")
        info.raise_for_status()
        sha = info.json()["sha"]
        tree = client.get(f"{HF}/api/models/{repo}/tree/{sha}")
        tree.raise_for_status()
    files = [f for f in tree.json() if f.get("type") == "file" and f["path"] not in SKIP_FILES]
    return sha, files


def _download(size: str, engine: str) -> None:
    repo = REPOS[engine][size]
    target = model_dir(size, engine)
    try:
        _set(state="preparing", size=size, done=0, total=0, error=None)
        sha, files = _file_list(repo)
        total = sum(int(f["size"]) for f in files)
        target.mkdir(parents=True, exist_ok=True)
        _set(state="downloading", total=total)
        base = 0
        last_emit = 0.0
        for f in files:
            name = f["path"]
            size_bytes = int(f["size"])
            dest = target / name
            lfs = f.get("lfs") or {}
            if dest.exists() and dest.stat().st_size == size_bytes:
                base += size_bytes
                continue

            def prog(done: int, _total: int | None, base: int = base) -> None:
                nonlocal last_emit
                now = time.monotonic()
                if now - last_emit > 0.25:
                    last_emit = now
                    _set(done=base + done)

            downloader.download(
                f"{HF}/{repo}/resolve/{sha}/{name}", dest, prog,
                expected_sha256=lfs.get("oid"), expected_size=size_bytes, cancel=_cancel,
            )
            if not lfs and f.get("oid") and downloader.git_blob_sha1(dest) != f["oid"]:
                dest.unlink(missing_ok=True)
                raise downloader.DownloadError(f"Checksum mismatch for {name}. Please try again.")
            base += size_bytes
            _set(done=base)
        (target / "manifest.json").write_text(json.dumps({"repo": repo, "revision": sha, "size": size,
                                                          "engine": engine, "installed_at": time.time()}))
        _set(state="done", done=total)
    except downloader.Cancelled:
        _set(state="idle", error=None)
    except Exception as exc:
        log.exception("Model download failed")
        _set(state="error", error=f"{exc}")


def start_download(size: str) -> dict[str, Any]:
    engine = current_engine()
    if size not in REPOS[engine]:
        raise ModelError(f"Unknown model size: {size}")
    with _lock:
        if _state["state"] in ("preparing", "downloading"):
            raise ModelError(f"Already downloading the {_state['size']} model.")
        _state.update(state="preparing", size=size, done=0, total=0, error=None)
    _cancel.clear()
    threading.Thread(target=_download, args=(size, engine), name=f"model-{size}", daemon=True).start()
    return status()


def download_blocking(size: str) -> None:
    """Used by the smoke test."""
    _cancel.clear()
    _download(size, current_engine())
    if _state["state"] == "error":
        raise ModelError(_state["error"])


def cancel_download() -> None:
    _cancel.set()


def delete(size: str) -> None:
    from . import transcriber

    transcriber.unload()
    shutil.rmtree(model_dir(size), ignore_errors=True)

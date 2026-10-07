"""Optional NVIDIA CUDA libraries (cuBLAS + cuDNN) for faster-whisper.

These add ~1.2 GB, so installers ship CPU-only and users with an NVIDIA GPU can download
the official NVIDIA redistributable wheels from PyPI in-app. Only the shared libraries
CTranslate2 needs are extracted into the app-data folder and loaded at startup.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import shutil
import sys
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx

from . import downloader, events, paths

log = logging.getLogger(__name__)

# Pinned for reproducibility. cuBLAS 12.9 / cuDNN 9 support Blackwell (RTX 50xx) and older GPUs.
PACKAGES: list[tuple[str, str]] = [
    ("nvidia-cublas-cu12", "12.9.2.10"),
    ("nvidia-cudnn-cu12", "9.27.0.42"),
]

if sys.platform == "win32":
    WANTED = ("cublas64_12.dll", "cublasLt64_12.dll", "cudnn")  # cudnn*.dll
    PLATFORM_TAG = "win_amd64"
else:
    WANTED = ("libcublas.so.12", "libcublasLt.so.12", "libcudnn")
    PLATFORM_TAG = "manylinux"

# Load order matters on Linux (dependencies first).
REQUIRED = (
    ["cublasLt64_12.dll", "cublas64_12.dll", "cudnn64_9.dll"] if sys.platform == "win32"
    else ["libcublasLt.so.12", "libcublas.so.12", "libcudnn.so.9"]
)

_state: dict[str, Any] = {"state": "idle", "done": 0, "total": 0, "error": None}
_lock = threading.Lock()
_loaded = False


def supported() -> bool:
    return sys.platform == "win32" or (sys.platform.startswith("linux") and os.uname().machine == "x86_64")


def libs_dir() -> Path:
    return paths.gpu_libs_dir()


def installed() -> bool:
    d = libs_dir()
    return supported() and not (d / ".remove").exists() and all((d / name).exists() for name in REQUIRED)


def status() -> dict[str, Any]:
    with _lock:
        s = dict(_state)
    s["installed"] = installed()
    s["supported"] = supported()
    return s


def load() -> bool:
    """Make the downloaded libraries visible to CTranslate2. Safe to call repeatedly."""
    global _loaded
    if _loaded:
        return True
    if not installed():
        return False
    d = libs_dir()
    try:
        if sys.platform == "win32":
            os.add_dll_directory(str(d))
            os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
            for name in REQUIRED:
                ctypes.WinDLL(str(d / name))
        else:
            # Preload by full path with RTLD_GLOBAL so CTranslate2's dlopen("libcublas.so.12") resolves.
            for f in sorted(d.iterdir(), key=lambda p: (not p.name.startswith("libcublasLt"), p.name)):
                if ".so" in f.name:
                    try:
                        ctypes.CDLL(str(f), mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        log.debug("Could not preload %s", f, exc_info=True)
        _loaded = True
    except OSError as exc:
        log.warning("Failed to load CUDA libraries: %s", exc)
        return False
    return True


def ready() -> bool:
    """True if CUDA libraries are available (downloaded or installed system-wide)."""
    if load():
        return True
    names = ["cublas64_12.dll", "cudnn_ops64_9.dll"] if sys.platform == "win32" else ["libcublas.so.12", "libcudnn_ops.so.9"]
    try:
        for name in names:
            ctypes.CDLL(name)
        return True
    except OSError:
        return False


def _set(**kw: Any) -> None:
    with _lock:
        _state.update(kw)
        snapshot = dict(_state)
    events.publish("gpu_pack", snapshot)


def _wheel_info(name: str, version: str) -> dict[str, Any]:
    resp = httpx.get(f"https://pypi.org/pypi/{name}/{version}/json", follow_redirects=True, timeout=30)
    resp.raise_for_status()
    for f in resp.json()["urls"]:
        fn = f["filename"]
        if fn.endswith(".whl") and PLATFORM_TAG in fn and ("x86_64" in fn or "amd64" in fn):
            return {"url": f["url"], "sha256": f["digests"]["sha256"], "size": f["size"], "filename": fn}
    raise RuntimeError(f"No {PLATFORM_TAG} build of {name} {version} on PyPI.")


def _install() -> None:
    try:
        _set(state="preparing", done=0, total=0, error=None)
        wheels = [_wheel_info(n, v) for n, v in PACKAGES]
        total = sum(w["size"] for w in wheels)
        _set(state="downloading", total=total)
        cache = paths.tmp_dir() / "gpu"
        cache.mkdir(parents=True, exist_ok=True)
        base = 0
        out = libs_dir()
        for w in wheels:
            dest = cache / w["filename"]
            if not (dest.exists() and dest.stat().st_size == w["size"]):
                last = [0.0]

                def prog(done: int, _t: int | None, base: int = base) -> None:
                    now = time.monotonic()
                    if now - last[0] > 0.25:
                        last[0] = now
                        _set(done=base + done)
                downloader.download(w["url"], dest, prog, expected_sha256=w["sha256"], expected_size=w["size"])
            base += w["size"]
            _set(state="extracting", done=base)
            with zipfile.ZipFile(dest) as zf:
                for member in zf.namelist():
                    fname = member.rsplit("/", 1)[-1]
                    if fname.startswith(WANTED) and (fname.endswith(".dll") or ".so" in fname):
                        with zf.open(member) as src, open(out / fname, "wb") as dst:
                            shutil.copyfileobj(src, dst, 1 << 20)
            dest.unlink(missing_ok=True)
        (out / "manifest.json").write_text(json.dumps(dict(PACKAGES)))
        if not installed():
            raise RuntimeError("The download finished but some CUDA libraries are missing.")
        load()
        _set(state="done", done=total)
    except Exception as exc:
        log.exception("GPU pack install failed")
        _set(state="error", error=str(exc))


def start_install() -> dict[str, Any]:
    if not supported():
        raise RuntimeError("GPU acceleration downloads are only available on Windows and Linux (x86-64).")
    with _lock:
        if _state["state"] in ("preparing", "downloading", "extracting"):
            return dict(_state)
    threading.Thread(target=_install, name="gpu-pack", daemon=True).start()
    return status()


def uninstall() -> bool:
    """Remove the libraries. Returns True if removal was deferred until the next launch."""
    if _loaded:
        (libs_dir() / ".remove").write_text("1")
        return True
    shutil.rmtree(libs_dir(), ignore_errors=True)
    libs_dir()
    return False


def apply_pending_removal() -> None:
    if (libs_dir() / ".remove").exists():
        shutil.rmtree(libs_dir(), ignore_errors=True)
        libs_dir()

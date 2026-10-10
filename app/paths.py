"""Filesystem locations.

All user data lives in the OS app-data folder (never next to the executable), so
installing a new version never touches the library. Set ``APS_DATA_DIR`` to override
(used by tests and smoke tests).
"""

from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

from platformdirs import user_data_dir

from .version import APP_ID


@lru_cache(maxsize=1)
def data_dir() -> Path:
    override = os.environ.get("APS_DATA_DIR")
    path = Path(override) if override else Path(user_data_dir(APP_ID, appauthor=False, roaming=True))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sub(name: str) -> Path:
    path = data_dir() / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    return data_dir() / "library.db"


def audio_dir() -> Path:
    return _sub("audio")


def clips_dir() -> Path:
    """Short audio clips that came with vocab words shared by friends."""
    return _sub("clips")


def models_dir() -> Path:
    return _sub("models")


def gpu_libs_dir() -> Path:
    return _sub("gpu-libs")


def logs_dir() -> Path:
    return _sub("logs")


def tmp_dir() -> Path:
    return _sub("tmp")


def resource_dir() -> Path:
    """Read-only bundled resources (web UI, licenses). Works from source and from PyInstaller."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def web_dir() -> Path:
    return resource_dir() / "web"


def licenses_dir() -> Path:
    return resource_dir() / "licenses"

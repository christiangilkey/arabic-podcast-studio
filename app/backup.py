"""Export / import the user's library as a single .zip."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

from . import db, jobs, paths
from .version import __version__

MANIFEST = "aps-backup.json"


def export(include_audio: bool) -> Path:
    out = paths.tmp_dir() / f"tamkeen-backup-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    snapshot = paths.tmp_dir() / "library-snapshot.db"
    snapshot.unlink(missing_ok=True)
    src = db.connect()
    dst = sqlite3.connect(snapshot)
    try:
        src.backup(dst)  # consistent copy even while the worker is writing
        # Never put API keys into a file the user may share or upload. VACUUM rewrites the
        # file so the deleted values don't linger in free pages.
        dst.execute(f"DELETE FROM settings WHERE key IN ({','.join('?' * len(db.SECRET_SETTINGS))})",
                    db.SECRET_SETTINGS)
        dst.commit()
        dst.execute("VACUUM")
    finally:
        dst.close()
        src.close()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST, json.dumps({"app_version": __version__, "created": time.time(),
                                          "include_audio": include_audio}))
        zf.write(snapshot, "library.db")
        if include_audio:
            for f in paths.audio_dir().iterdir():
                if f.is_file() and ".tmp" not in f.name and not f.name.endswith(".part"):
                    zf.write(f, f"audio/{f.name}", compress_type=zipfile.ZIP_STORED)
    snapshot.unlink(missing_ok=True)
    return out


def import_(zip_path: Path) -> dict[str, Any]:
    """Replace the current library with the backup's contents."""
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        if MANIFEST not in names or "library.db" not in names:
            raise ValueError("This file isn't a Tamkeen backup.")
        with tempfile.TemporaryDirectory(dir=paths.tmp_dir()) as tmp:
            zf.extract("library.db", tmp)
            incoming = Path(tmp) / "library.db"
            check = sqlite3.connect(incoming)
            try:
                if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("The backup's database is damaged.")
            finally:
                check.close()
            keep = {k: v for k, v in db.get_settings().items() if k in db.SECRET_SETTINGS and v}
            src = sqlite3.connect(incoming)
            dst = db.connect()
            try:
                src.backup(dst)  # atomically replaces the live database's pages
            finally:
                src.close()
                dst.close()
            if keep:
                db.set_settings(keep)  # this device's API keys survive an import
        audio_dir = paths.audio_dir()
        restored = 0
        for name in names:
            if name.startswith("audio/") and not name.endswith("/"):
                target = audio_dir / os.path.basename(name)
                with zf.open(name) as s, open(target, "wb") as d:
                    shutil.copyfileobj(s, d, 1 << 20)
                restored += 1
    db.init_db()
    # Re-point audio paths at this machine's data folder; forget files that aren't here.
    with db.session() as conn:
        for row in conn.execute("SELECT id, audio_path FROM episodes WHERE audio_path IS NOT NULL").fetchall():
            local = audio_dir / Path(row["audio_path"]).name
            conn.execute("UPDATE episodes SET audio_path = ? WHERE id = ?",
                         (str(local) if local.exists() else None, row["id"]))
    jobs.recover()
    jobs.worker.wake()
    return {"audio_files": restored}

"""Settings, hardware/models, GPU pack, backups, updates, about, and the SSE stream."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from .. import audio, backup, db, events, gpu_libs, hardware, models_manager, paths, transcriber, updates
from ..version import APP_NAME, GITHUB_REPO, __version__

router = APIRouter(tags=["system"])

ALLOWED_SETTINGS = {"model_size", "delete_audio_after", "stream_from_source", "theme", "font_size",
                    "welcome_seen", "beam_size", *db.DEFAULT_SETTINGS.keys()}


@router.get("/events")
async def sse() -> StreamingResponse:
    return StreamingResponse(events.stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/status")
def status() -> dict[str, Any]:
    ok, ffmpeg_msg = audio.check_ffmpeg()
    settings = db.get_settings()
    hw = hardware.detect()
    size = settings.get("model_size")
    return {
        "version": __version__,
        "app_name": APP_NAME,
        "ffmpeg_ok": ok,
        "ffmpeg_message": ffmpeg_msg,
        "settings": settings,
        "hardware": hw.to_dict(),
        "model_ready": bool(size) and models_manager.is_installed(size),
        "data_dir": str(paths.data_dir()),
        "desktop": os.environ.get("APS_DESKTOP") == "1",
    }


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return db.get_settings()


@router.patch("/settings")
def patch_settings(values: dict[str, Any]) -> dict[str, Any]:
    clean = {k: v for k, v in values.items() if k in ALLOWED_SETTINGS}
    if clean.get("model_size") is not None and clean["model_size"] not in models_manager.SIZES:
        raise HTTPException(400, "Unknown model size.")
    result = db.set_settings(clean)
    if "model_size" in clean or "beam_size" in clean:
        transcriber.unload()
    return result


@router.get("/hardware")
def get_hardware() -> dict[str, Any]:
    return hardware.detect().to_dict()


@router.get("/models")
def list_models() -> dict[str, Any]:
    return {"models": models_manager.list_models(), "download": models_manager.status(),
            "selected": db.get_setting("model_size")}


@router.post("/models/{size}/download")
def download_model(size: str) -> dict[str, Any]:
    try:
        return models_manager.start_download(size)
    except models_manager.ModelError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/models/cancel")
def cancel_model_download() -> dict[str, bool]:
    models_manager.cancel_download()
    return {"ok": True}


@router.delete("/models/{size}")
def delete_model(size: str) -> dict[str, bool]:
    if size not in models_manager.SIZES:
        raise HTTPException(400, "Unknown model size.")
    models_manager.delete(size)
    return {"ok": True}


@router.get("/gpu")
def gpu_status() -> dict[str, Any]:
    return gpu_libs.status()


@router.post("/gpu/install")
def gpu_install() -> dict[str, Any]:
    try:
        return gpu_libs.start_install()
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/gpu")
def gpu_uninstall() -> dict[str, Any]:
    deferred = gpu_libs.uninstall()
    transcriber.unload()
    return {"ok": True, "restart_required": deferred}


def _open_path(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


@router.post("/system/open-data-folder")
def open_data_folder() -> dict[str, Any]:
    try:
        _open_path(paths.data_dir())
    except Exception as exc:
        raise HTTPException(500, f"Couldn't open the folder: {exc}") from exc
    return {"ok": True, "path": str(paths.data_dir())}


class ExportIn(BaseModel):
    include_audio: bool = False


@router.post("/backup/export")
def backup_export(body: ExportIn) -> dict[str, Any]:
    out = backup.export(body.include_audio)
    return {"ok": True, "name": out.name, "url": f"/api/backup/download/{out.name}",
            "size": out.stat().st_size}


@router.get("/backup/download/{name}")
def backup_download(name: str) -> FileResponse:
    path = (paths.tmp_dir() / name).resolve()
    if path.parent != paths.tmp_dir().resolve() or not path.exists() or not name.endswith(".zip"):
        raise HTTPException(404, "Backup not found.")
    return FileResponse(path, media_type="application/zip", filename=name)


@router.post("/backup/import")
async def backup_import(request: Request) -> dict[str, Any]:
    """Body is the raw .zip file (sent with fetch(..., {body: file}))."""
    tmp = paths.tmp_dir() / "import-upload.zip"
    with open(tmp, "wb") as fh:
        async for chunk in request.stream():
            fh.write(chunk)
    try:
        return {"ok": True, **backup.import_(tmp)}
    except (ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, f"Import failed: {exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)


@router.get("/updates/check")
def check_updates() -> dict[str, Any]:
    return updates.check()


LICENSES = [
    ("Tamkeen", "MIT", "app.txt"),
    ("OpenAI Whisper (model weights & architecture)", "MIT", "whisper.txt"),
    ("faster-whisper", "MIT", "faster-whisper.txt"),
    ("CTranslate2", "MIT", "ctranslate2.txt"),
    ("mlx-whisper / MLX (Apple Silicon builds)", "MIT", "mlx-whisper.txt"),
    ("FFmpeg (via PyAV)", "LGPL v2.1 or later", "ffmpeg.txt"),
    ("PyAV", "BSD 3-Clause", "pyav.txt"),
    ("Silero VAD", "MIT", "silero-vad.txt"),
    ("Noto Naskh Arabic font", "SIL Open Font License 1.1", "noto-naskh-arabic.txt"),
    ("pywebview", "BSD 3-Clause", "pywebview.txt"),
    ("FastAPI / Starlette / Uvicorn", "MIT / BSD 3-Clause", "fastapi.txt"),
    ("feedparser", "BSD 2-Clause", "feedparser.txt"),
    ("httpx", "BSD 3-Clause", "httpx.txt"),
    ("NVIDIA cuBLAS / cuDNN (optional download)", "NVIDIA Software License", "nvidia.txt"),
]


@router.get("/about")
def about() -> dict[str, Any]:
    return {
        "app_name": APP_NAME,
        "version": __version__,
        "repo": GITHUB_REPO,
        "python": sys.version.split()[0],
        "data_dir": str(paths.data_dir()),
        "licenses": [{"name": n, "license": lic, "file": f} for n, lic, f in LICENSES
                     if (paths.licenses_dir() / f).exists()],
    }


@router.get("/licenses/{name}")
def license_text(name: str) -> PlainTextResponse:
    path = (paths.licenses_dir() / name).resolve()
    if path.parent != paths.licenses_dir().resolve() or not path.exists():
        raise HTTPException(404, "License not found.")
    return PlainTextResponse(path.read_text(encoding="utf-8", errors="replace"))

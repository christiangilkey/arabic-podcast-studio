"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import logging.handlers
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import audio, db, events, gpu_libs, jobs, paths
from .api import router as api_router
from .api.feeds import refresh_in_background
from .version import APP_NAME, __version__

log = logging.getLogger(__name__)


def setup_logging() -> None:
    root = logging.getLogger()
    if any(getattr(h, "_aps", False) for h in root.handlers):
        return
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = logging.handlers.RotatingFileHandler(paths.logs_dir() / "app.log", maxBytes=2_000_000, backupCount=3,
                                              encoding="utf-8")
    fh.setFormatter(fmt)
    fh._aps = True  # type: ignore[attr-defined]
    root.addHandler(fh)
    if sys.stderr is not None:  # windowed PyInstaller builds have no stderr
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        sh._aps = True  # type: ignore[attr-defined]
        root.addHandler(sh)


def startup_checks() -> None:
    ok, message = audio.check_ffmpeg()
    if ok:
        log.info("Audio backend: %s", message)
    else:
        log.error("Audio backend unavailable:\n%s", message)
    gpu_libs.apply_pending_removal()
    if gpu_libs.installed():
        log.info("CUDA libraries loaded: %s", gpu_libs.load())


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    events.bind_loop(asyncio.get_running_loop())
    db.init_db()
    startup_checks()
    if app.state.start_worker:
        jobs.worker.start()
        refresh_in_background()
    log.info("%s %s started; data folder: %s", APP_NAME, __version__, paths.data_dir())
    yield
    jobs.worker.stop()


def create_app(start_worker: bool = True) -> FastAPI:
    setup_logging()
    app = FastAPI(title=APP_NAME, version=__version__, lifespan=lifespan, docs_url="/api/docs",
                  openapi_url="/api/openapi.json")
    app.state.start_worker = start_worker
    app.include_router(api_router)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error on %s", request.url.path)
        return JSONResponse({"detail": f"Unexpected error: {exc}"}, status_code=500)

    web = paths.web_dir()

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(web / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/", NoCacheStaticFiles(directory=web), name="web")
    return app


class NoCacheStaticFiles(StaticFiles):
    """Static files that the webview must revalidate, so an app update never runs stale JS."""

    def file_response(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response

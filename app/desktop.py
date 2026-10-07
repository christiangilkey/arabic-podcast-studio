"""Native window shell: runs the FastAPI server on a free local port inside a pywebview window.

If no native webview is available (e.g. Linux without WebKitGTK), the app opens in the
default browser instead and shuts down once the last browser tab has been closed for a while.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

import httpx
import uvicorn

from . import events, jobs, paths
from .main import create_app, setup_logging
from .version import APP_NAME

log = logging.getLogger(__name__)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Server:
    def __init__(self, port: int) -> None:
        self.port = port
        config = uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning",
                                log_config=None, timeout_graceful_shutdown=2)
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, name="uvicorn", daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def start(self, timeout: float = 30) -> None:
        self.thread.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.server.started:
                return
            if not self.thread.is_alive():
                raise RuntimeError("The local server failed to start. See the log in the data folder.")
            time.sleep(0.05)
        raise RuntimeError("Timed out starting the local server.")

    def stop(self) -> None:
        jobs.worker.stop()
        self.server.should_exit = True
        self.thread.join(timeout=5)


class JsApi:
    """Exposed to the page as window.pywebview.api (native save dialogs for exports).

    Attributes must stay private (underscore): pywebview walks every public attribute of
    this object to build the JS bridge, and walking the native window object recurses forever.
    """

    def __init__(self, server: Server) -> None:
        self._server = server
        self._window: Any = None

    def save_file(self, url: str, filename: str) -> dict[str, Any]:
        import webview

        result = self._window.create_file_dialog(webview.SAVE_DIALOG, save_filename=filename)
        if not result:
            return {"ok": False, "cancelled": True}
        target = Path(result if isinstance(result, str) else result[0])
        with httpx.stream("GET", self._server.url.rstrip("/") + url, timeout=None) as resp:
            if resp.status_code >= 400:
                return {"ok": False, "error": resp.read().decode("utf-8", "replace")}
            with open(target, "wb") as fh:
                for chunk in resp.iter_bytes(1 << 16):
                    fh.write(chunk)
        return {"ok": True, "path": str(target)}


def _browser_mode(server: Server) -> None:
    webbrowser.open(server.url)
    log.info("Running in browser mode at %s", server.url)
    # Quit once no browser tab has been connected for 60 s (after the first one connected).
    seen_client = False
    try:
        while True:
            time.sleep(2)
            if events.client_count() > 0:
                seen_client = True
            elif seen_client and events.seconds_since_last_client() > 60:
                break
    except KeyboardInterrupt:
        pass


def run(browser: bool = False, port: int | None = None, headless: bool = False) -> None:
    setup_logging()
    os.environ["APS_DESKTOP"] = "0" if browser or headless else "1"
    server = Server(port or free_port())
    server.start()
    log.info("Server listening on %s", server.url)
    try:
        if headless:
            print(f"Serving on {server.url} (Ctrl+C to stop)", flush=True)
            try:
                while server.thread.is_alive():
                    time.sleep(0.5)
            except KeyboardInterrupt:
                pass
            return
        if browser:
            _browser_mode(server)
            return
        try:
            import webview
        except Exception as exc:
            log.warning("pywebview unavailable (%s); falling back to the browser.", exc)
            os.environ["APS_DESKTOP"] = "0"
            _browser_mode(server)
            return
        api = JsApi(server)
        window = webview.create_window(APP_NAME, server.url, js_api=api, width=1280, height=860,
                                       min_size=(820, 560), text_select=True)
        api._window = window
        try:
            webview.start(private_mode=False, storage_path=str(paths.data_dir() / "webview"))
        except Exception as exc:
            log.warning("Native window failed (%s); falling back to the browser.", exc)
            os.environ["APS_DESKTOP"] = "0"
            _browser_mode(server)
    finally:
        server.stop()

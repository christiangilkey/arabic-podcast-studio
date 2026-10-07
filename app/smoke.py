"""Headless self-test for packaged builds (run by CI on a clean runner).

Exercises the bundled pieces end to end: FFmpeg/PyAV, the database, the HTTP server and
static UI, model download with checksum verification, and a real transcription with the
tiny model.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any


def run_smoke_test(audio_file: str | None) -> int:
    os.environ.setdefault("APS_DATA_DIR", tempfile.mkdtemp(prefix="aps-smoke-"))
    report: dict[str, Any] = {"python": sys.version.split()[0], "frozen": bool(getattr(sys, "frozen", False))}
    ok = True

    def step(name: str, fn: Any) -> Any:
        nonlocal ok
        t0 = time.monotonic()
        try:
            result = fn()
            report[name] = {"ok": True, "seconds": round(time.monotonic() - t0, 2), "result": result}
            return result
        except Exception as exc:
            ok = False
            report[name] = {"ok": False, "error": f"{exc.__class__.__name__}: {exc}",
                            "trace": traceback.format_exc()[-2000:]}
            return None

    from . import audio, db, hardware, models_manager, paths

    def ffmpeg() -> str:
        good, msg = audio.check_ffmpeg()
        if not good:
            raise RuntimeError(msg)
        return msg

    step("ffmpeg", ffmpeg)
    step("database", lambda: (db.init_db(), str(paths.db_path()))[1])
    step("hardware", lambda: hardware.detect().to_dict())

    def server() -> dict[str, Any]:
        import httpx

        from .desktop import Server, free_port

        srv = Server(free_port())
        srv.start()
        try:
            status = httpx.get(srv.url + "api/status", timeout=30).json()
            index = httpx.get(srv.url, timeout=30)
            js = httpx.get(srv.url + "js/app.js", timeout=30)
            assert index.status_code == 200 and "<html" in index.text.lower(), "index.html not served"
            assert js.status_code == 200, "static JS not served"
            return {"version": status["version"], "ffmpeg_ok": status["ffmpeg_ok"]}
        finally:
            srv.stop()

    step("server", server)

    def model() -> str:
        models_manager.download_blocking("tiny")
        return str(models_manager.model_dir("tiny"))

    step("model_download", model)

    def transcribe() -> dict[str, Any]:
        from . import transcriber

        path = Path(audio_file) if audio_file else _bundled_sample()
        duration = audio.probe_duration(path)
        samples = audio.decode(path)
        engine = transcriber.get("tiny")
        segments = list(engine.transcribe(samples))
        words = [w for s in segments for w in s.words]
        if not words:
            raise RuntimeError("Transcription produced no words.")
        if any(w.end < w.start for w in words):
            raise RuntimeError("Invalid word timestamps.")
        return {"engine": engine.engine, "device": engine.device, "duration": round(duration, 2),
                "segments": len(segments), "words": len(words), "text": " ".join(s.text for s in segments)[:200]}

    step("transcribe", transcribe)

    report["ok"] = ok
    text = json.dumps(report, ensure_ascii=False, indent=2)
    out = Path(os.environ["APS_DATA_DIR"]) / "smoke-report.json"
    out.write_text(text, encoding="utf-8")
    if sys.stdout is not None:
        try:
            sys.stdout.buffer.write((text + "\n").encode("utf-8"))
            sys.stdout.flush()
        except Exception:
            pass
    return 0 if ok else 1


def _bundled_sample() -> Path:
    from . import paths

    sample = paths.resource_dir() / "tests" / "fixtures" / "arabic-sample.wav"
    if not sample.exists():
        raise FileNotFoundError(f"Sample audio not found at {sample}")
    return sample

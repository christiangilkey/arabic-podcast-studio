"""Transcriber factory. The rest of the app only uses :func:`get` and the base types."""

from __future__ import annotations

import logging
import threading

from .. import db, gpu_libs, hardware, models_manager
from .base import Segment, Transcriber, TranscriptionCancelled, Word

log = logging.getLogger(__name__)

__all__ = ["Segment", "Word", "Transcriber", "TranscriptionCancelled", "get", "unload", "NoModelError"]

_lock = threading.Lock()
_current: Transcriber | None = None
_key: tuple[str, str, str] | None = None


class NoModelError(RuntimeError):
    pass


def get(model_size: str | None = None) -> Transcriber:
    """Return a loaded transcriber for the configured model, (re)loading if settings changed."""
    global _current, _key
    size = model_size or db.get_setting("model_size")
    if not size:
        raise NoModelError("No transcription model selected yet. Open Settings → Model to download one.")
    hw = hardware.detect()
    engine = hw.engine
    if not models_manager.is_installed(size, engine):
        raise NoModelError(f"The {size} model isn't downloaded yet. Open Settings → Model to download it.")
    device = hw.device
    key = (engine, size, device)
    with _lock:
        if _current is not None and _key == key:
            return _current
        _current = None
        path = models_manager.model_dir(size, engine)
        log.info("Loading %s model %s on %s", engine, size, device)
        if engine == "mlx":
            from .mlx import MlxTranscriber

            _current = MlxTranscriber(path, size)
        else:
            if device == "cuda":
                gpu_libs.load()
            from .faster import FasterWhisperTranscriber

            _current = FasterWhisperTranscriber(path, size, device, beam_size=int(db.get_setting("beam_size") or 5))
        _key = key
        return _current


def unload() -> None:
    global _current, _key
    with _lock:
        _current = None
        _key = None

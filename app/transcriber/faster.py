"""faster-whisper (CTranslate2) engine for CPU and NVIDIA CUDA."""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from .base import Segment, TranscriptionCancelled, Word

log = logging.getLogger(__name__)


class FasterWhisperTranscriber:
    engine = "faster-whisper"

    def __init__(self, model_path: Path, model_size: str, device: str, beam_size: int = 5) -> None:
        from faster_whisper import WhisperModel

        self.model_size = model_size
        self.beam_size = beam_size
        if device == "cuda":
            try:
                self.model = WhisperModel(str(model_path), device="cuda", compute_type="float16")
                self.device = "cuda"
                return
            except Exception as exc:  # missing/broken CUDA libs, unsupported GPU, out of VRAM
                log.warning("CUDA unavailable (%s); falling back to CPU.", exc)
        threads = max(1, (os.cpu_count() or 4) - 1)
        self.model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=threads)
        self.device = "cpu"

    def transcribe(self, audio: np.ndarray, cancel: threading.Event | None = None) -> Iterator[Segment]:
        segments, _info = self.model.transcribe(
            audio,
            language="ar",
            task="transcribe",
            beam_size=self.beam_size,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # Prevents the repetition loops Whisper can fall into after music or long pauses.
            # (hallucination_silence_threshold was tried too: it nearly doubles runtime and VAD
            # already removes the silence it targets.)
            condition_on_previous_text=False,
        )
        for seg in segments:  # lazy generator: decoding happens as we iterate
            if cancel is not None and cancel.is_set():
                raise TranscriptionCancelled()
            words = [Word(float(w.start), float(w.end), w.word.strip(), float(w.probability))
                     for w in (seg.words or []) if w.word.strip()]
            yield Segment(float(seg.start), float(seg.end), seg.text.strip(), words)

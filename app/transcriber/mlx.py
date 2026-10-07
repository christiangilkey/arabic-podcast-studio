"""mlx-whisper engine for Apple Silicon (runs on the Mac GPU via Metal).

mlx-whisper has no VAD and no streaming API, so we:
  * run faster-whisper's Silero VAD first and transcribe only the speech chunks, then map
    timestamps back to the original timeline (same approach faster-whisper uses internally);
  * process speech in ~5-minute blocks so segments (and progress) arrive incrementally.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from .base import Segment, TranscriptionCancelled, Word

log = logging.getLogger(__name__)

SR = 16000
BLOCK_SECONDS = 300


class MlxTranscriber:
    engine = "mlx"
    device = "metal"

    def __init__(self, model_path: Path, model_size: str, beam_size: int = 5) -> None:
        import mlx_whisper  # noqa: F401  (fail early if missing)

        self.model_path = str(model_path)
        self.model_size = model_size

    def _speech_chunks(self, audio: np.ndarray) -> list[dict[str, int]]:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        return get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=500))

    def transcribe(self, audio: np.ndarray, cancel: threading.Event | None = None) -> Iterator[Segment]:
        import mlx_whisper

        chunks = self._speech_chunks(audio)
        if not chunks:
            return
        # Group consecutive speech chunks into blocks of roughly BLOCK_SECONDS of speech.
        blocks: list[list[dict[str, int]]] = [[]]
        acc = 0
        for c in chunks:
            if acc >= BLOCK_SECONDS * SR and blocks[-1]:
                blocks.append([])
                acc = 0
            blocks[-1].append(c)
            acc += c["end"] - c["start"]

        for block in blocks:
            if cancel is not None and cancel.is_set():
                raise TranscriptionCancelled()
            pieces = [audio[c["start"]:c["end"]] for c in block]
            speech = np.concatenate(pieces).astype(np.float32)
            # Offsets to map positions in `speech` back to the original audio.
            bounds: list[tuple[float, float, float]] = []  # (speech_start, speech_end, original_start)
            pos = 0
            for c in block:
                n = c["end"] - c["start"]
                bounds.append((pos / SR, (pos + n) / SR, c["start"] / SR))
                pos += n

            def remap(t: float) -> float:
                for s0, s1, o0 in bounds:
                    if t <= s1:
                        return o0 + max(0.0, t - s0)
                s0, s1, o0 = bounds[-1]
                return o0 + (t - s0)

            result = mlx_whisper.transcribe(
                speech,
                path_or_hf_repo=self.model_path,
                language="ar",
                task="transcribe",
                word_timestamps=True,
                condition_on_previous_text=False,
                verbose=None,
            )
            for seg in result.get("segments", []):
                words = [Word(remap(float(w["start"])), remap(float(w["end"])), str(w["word"]).strip(),
                              float(w.get("probability", 0) or 0))
                         for w in seg.get("words", []) if str(w["word"]).strip()]
                yield Segment(remap(float(seg["start"])), remap(float(seg["end"])), str(seg["text"]).strip(), words)

"""Engine-independent transcription interface."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np


@dataclass
class Word:
    start: float
    end: float
    text: str
    prob: float | None = None


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


class TranscriptionCancelled(RuntimeError):
    pass


class Transcriber(Protocol):
    engine: str
    device: str
    model_size: str

    def transcribe(self, audio: np.ndarray, cancel: threading.Event | None = None) -> Iterator[Segment]:
        """Yield segments in time order as they are produced (16 kHz mono float32 input).

        Callers derive progress from ``segment.end / duration``.
        """
        ...

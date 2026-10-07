"""Audio probing and decoding via PyAV (bundled LGPL FFmpeg libraries).

PyAV replaces the ffmpeg/ffprobe command-line tools: it ships with faster-whisper on
every platform, so there is no separate binary to bundle or find on PATH.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000


class AudioError(RuntimeError):
    pass


def probe_duration(path: Path) -> float:
    """Duration in seconds, like ``ffprobe -show_entries format=duration``."""
    import av

    try:
        with av.open(str(path)) as container:
            if container.duration:
                return container.duration / av.time_base
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise AudioError("The file contains no audio stream.")
            if stream.duration and stream.time_base:
                return float(stream.duration * stream.time_base)
            # No header duration (some VBR MP3s): scan packets.
            last = 0.0
            for packet in container.demux(stream):
                if packet.pts is not None and packet.time_base is not None:
                    last = max(last, float((packet.pts + (packet.duration or 0)) * packet.time_base))
            return last
    except AudioError:
        raise
    except Exception as exc:  # av raises many error subclasses
        raise AudioError(f"Could not read audio file: {exc}") from exc


def decode(path: Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decode to mono float32 PCM at ``sample_rate`` (what Whisper expects).

    Corrupt packets (common in podcast MP3s) are skipped rather than aborting the decode.
    """
    import av

    chunks: list[np.ndarray] = []
    bad_packets = 0
    try:
        with av.open(str(path)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise AudioError("The file contains no audio stream.")
            stream.thread_type = "AUTO"
            resampler = av.AudioResampler(format="s16", layout="mono", rate=sample_rate)
            for packet in container.demux(stream):
                try:
                    frames = packet.decode()
                except av.error.InvalidDataError:
                    bad_packets += 1
                    continue
                for frame in frames:
                    for out in resampler.resample(frame):
                        chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
    except AudioError:
        raise
    except Exception as exc:
        raise AudioError(f"Could not decode audio: {exc}") from exc
    if bad_packets:
        log.info("Skipped %d corrupt audio packets in %s", bad_packets, path.name)
    if not chunks:
        raise AudioError("The audio file is empty or couldn't be decoded.")
    pcm = np.concatenate(chunks)
    del chunks
    return pcm.astype(np.float32) / 32768.0


def check_ffmpeg() -> tuple[bool, str]:
    """Startup check that the bundled FFmpeg libraries load and can encode/decode."""
    try:
        import av

        versions = av.library_versions
        return True, f"PyAV {av.__version__}, libavcodec {'.'.join(map(str, versions.get('libavcodec', ())))}"
    except Exception as exc:
        return False, (
            f"The audio libraries (FFmpeg via PyAV) failed to load: {exc}\n"
            "Reinstall the app. If you are running from source, run: pip install av"
        )

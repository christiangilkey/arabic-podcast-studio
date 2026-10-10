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


def encode_speech_copy(src: Path, dst: Path, bitrate: int = 32_000) -> Path:
    """Compressed copy for syncing to other devices: mono Opus in Ogg (~15 MB per hour).

    Decoding starts at the same first sample as :func:`decode`, so transcript timestamps
    line up exactly with the copy.
    """
    import os

    import av

    tmp = dst.with_name(dst.name + ".part")
    try:
        with av.open(str(src)) as inp, av.open(str(tmp), "w", format="ogg") as out:
            ins = next((s for s in inp.streams if s.type == "audio"), None)
            if ins is None:
                raise AudioError("The file contains no audio stream.")
            ost = out.add_stream("libopus", rate=48000, layout="mono")
            ost.bit_rate = bitrate
            resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)

            def emit(frames: list) -> None:
                for f in frames:
                    f.pts = None
                    for pkt in ost.encode(f):
                        out.mux(pkt)

            for packet in inp.demux(ins):
                try:
                    decoded = packet.decode()
                except av.error.InvalidDataError:
                    continue
                for frame in decoded:
                    emit(resampler.resample(frame))
            emit(resampler.resample(None))
            for pkt in ost.encode(None):
                out.mux(pkt)
    except AudioError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise AudioError(f"Could not create the compressed audio copy: {exc}") from exc
    os.replace(tmp, dst)
    return dst


def cut_clip(src: Path, start: float, end: float, dst: Path, bitrate: int = 24_000) -> float:
    """Save the part of `src` between `start` and `end` (seconds) as a small mono Opus file.

    Used for the audio that travels with a shared vocab word. Returns the time in `src` where
    the clip really begins (cuts land on audio-frame boundaries, a few hundredths of a second),
    so word positions inside the clip can be worked out exactly.
    """
    import os

    import av

    start = max(0.0, float(start))
    end = max(start + 0.2, float(end))
    tmp = dst.with_name(dst.name + ".part")
    first: float | None = None
    try:
        with av.open(str(src)) as inp, av.open(str(tmp), "w", format="ogg") as out:
            ins = next((s for s in inp.streams if s.type == "audio"), None)
            if ins is None:
                raise AudioError("The file contains no audio stream.")
            ost = out.add_stream("libopus", rate=48000, layout="mono")
            ost.bit_rate = bitrate
            resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)
            # Jump to just before the clip, then decode forward to the exact spot.
            inp.seek(int(max(0.0, start - 1.0) * av.time_base), any_frame=False, backward=True)

            def emit(frames: list) -> None:
                for f in frames:
                    f.pts = None
                    for pkt in ost.encode(f):
                        out.mux(pkt)

            done = False
            for packet in inp.demux(ins):
                try:
                    decoded = packet.decode()
                except av.error.InvalidDataError:
                    continue
                for frame in decoded:
                    t = frame.time
                    if t is None:
                        continue
                    length = frame.samples / frame.sample_rate if frame.sample_rate else 0.0
                    if t + length <= start:
                        continue
                    if t >= end:
                        done = True
                        break
                    if first is None:
                        first = float(t)
                    emit(resampler.resample(frame))
                if done:
                    break
            if first is None:
                raise AudioError("That part of the audio couldn't be read.")
            emit(resampler.resample(None))
            for pkt in ost.encode(None):
                out.mux(pkt)
    except AudioError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise AudioError(f"Could not cut the audio clip: {exc}") from exc
    os.replace(tmp, dst)
    return first


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

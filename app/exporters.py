"""Transcript (TXT/SRT/VTT) and vocab (CSV/Anki) exporters. Pure functions."""

from __future__ import annotations

import csv
import html
import io
from collections.abc import Sequence
from typing import Any

RLM = "‏"  # right-to-left mark helps some subtitle players render Arabic punctuation


def _ts(seconds: float, sep: str) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms_total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def srt_timestamp(seconds: float) -> str:
    return _ts(seconds, ",")


def vtt_timestamp(seconds: float) -> str:
    return _ts(seconds, ".")


def to_txt(segments: Sequence[dict[str, Any]], title: str = "") -> str:
    lines = [title, ""] if title else []
    lines += [s["text"] for s in segments]
    return "\n".join(lines) + "\n"


def to_srt(segments: Sequence[dict[str, Any]]) -> str:
    out = []
    for i, s in enumerate(segments, 1):
        out.append(f"{i}\n{srt_timestamp(s['start'])} --> {srt_timestamp(s['end'])}\n{RLM}{s['text']}\n")
    return "\n".join(out)


def to_vtt(segments: Sequence[dict[str, Any]]) -> str:
    out = ["WEBVTT", ""]
    for s in segments:
        out.append(f"{vtt_timestamp(s['start'])} --> {vtt_timestamp(s['end'])}\n{RLM}{s['text']}\n")
    return "\n".join(out)


VOCAB_COLUMNS = ["text", "meaning", "notes", "sentence", "episode_title", "start", "end", "created_at"]


def vocab_to_csv(items: Sequence[dict[str, Any]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Word/Phrase", "Meaning", "Notes", "Sentence", "Episode", "Start (s)", "End (s)"])
    for v in items:
        writer.writerow([v["text"], v["meaning"], v["notes"], v["sentence"], v["episode_title"],
                         f"{v['start']:.2f}" if v["start"] is not None else "",
                         f"{v['end']:.2f}" if v["end"] is not None else ""])
    # BOM so Excel opens UTF-8 Arabic correctly.
    return "﻿" + buf.getvalue()


def _anki_field(text: str) -> str:
    return text.replace("\t", " ").replace("\r", "").replace("\n", "<br>")


def vocab_to_anki(items: Sequence[dict[str, Any]]) -> str:
    """Anki 'Notes in Plain Text' import format (File → Import), with header directives."""
    lines = [
        "#separator:tab",
        "#html:true",
        "#columns:Front\tBack\tSentence\tSource\tTags",
        "#tags column:5",
    ]
    for v in items:
        word = html.escape(v["text"])
        sentence = html.escape(v["sentence"] or "")
        if word and word in sentence:
            sentence = sentence.replace(word, f"<b>{word}</b>", 1)
        back = html.escape(v["meaning"] or "")
        if v["notes"]:
            back += ("<br><br>" if back else "") + f"<i>{html.escape(v['notes'])}</i>"
        front = f'<div dir="rtl" style="font-size:2em">{word}</div>'
        sentence_html = f'<div dir="rtl">{sentence}</div>' if sentence else ""
        source = html.escape(v["episode_title"] or "")
        if v["start"] is not None:
            source += f" @ {srt_timestamp(v['start'])[:8]}"
        lines.append("\t".join(_anki_field(x) for x in (front, back, sentence_html, source, "arabic-podcast")))
    return "\n".join(lines) + "\n"

"""Vocabulary list endpoints."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .. import arabic, db, exporters, ids, sync

router = APIRouter(prefix="/vocab", tags=["vocab"])


class VocabIn(BaseModel):
    text: str
    sentence: str = ""
    episode_id: int | None = None
    start: float | None = None
    end: float | None = None
    sent_start: float | None = None
    sent_end: float | None = None
    meaning: str = ""
    notes: str = ""


class VocabPatch(BaseModel):
    meaning: str | None = None
    notes: str | None = None
    text: str | None = None


def _items(q: str | None = None) -> list[dict[str, Any]]:
    with db.session() as conn:
        rows = conn.execute("SELECT * FROM vocab WHERE deleted = 0 ORDER BY created_at DESC").fetchall()
    items = db.rows_to_dicts(rows)
    if q:
        nq = arabic.normalize(q)
        lq = q.lower()
        items = [v for v in items if nq in v["norm"] or nq in arabic.normalize(v["sentence"])
                 or lq in v["meaning"].lower() or lq in v["notes"].lower()]
    return items


@router.get("")
def list_vocab(q: str | None = None) -> list[dict[str, Any]]:
    return _items(q)


@router.post("")
def add_vocab(body: VocabIn) -> dict[str, Any]:
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Nothing to save.")
    title = ""
    episode_uid = None
    with db.session() as conn:
        if body.episode_id is not None:
            ep = conn.execute("SELECT title, uid FROM episodes WHERE id = ?", (body.episode_id,)).fetchone()
            if ep:
                title, episode_uid = ep["title"], ep["uid"]
        cur = conn.execute(
            "INSERT INTO vocab(uid, episode_id, episode_uid, text, norm, sentence, start, end, sent_start, sent_end, "
            "meaning, notes, episode_title, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ids.new_uid(), body.episode_id, episode_uid, text, arabic.normalize(text), body.sentence.strip(),
             body.start, body.end, body.sent_start, body.sent_end, body.meaning, body.notes, title, time.time()),
        )
        row = conn.execute("SELECT * FROM vocab WHERE id = ?", (cur.lastrowid,)).fetchone()
    sync.request()
    return dict(row)


@router.patch("/{vocab_id}")
def update_vocab(vocab_id: int, body: VocabPatch) -> dict[str, Any]:
    with db.session() as conn:
        if body.meaning is not None:
            conn.execute("UPDATE vocab SET meaning = ? WHERE id = ?", (body.meaning, vocab_id))
        if body.notes is not None:
            conn.execute("UPDATE vocab SET notes = ? WHERE id = ?", (body.notes, vocab_id))
        if body.text is not None and body.text.strip():
            conn.execute("UPDATE vocab SET text = ?, norm = ? WHERE id = ?",
                         (body.text.strip(), arabic.normalize(body.text), vocab_id))
        row = conn.execute("SELECT * FROM vocab WHERE id = ?", (vocab_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Not found.")
    sync.request(delay=10)  # typing in notes: wait for a pause
    return dict(row)


@router.delete("/{vocab_id}")
def delete_vocab(vocab_id: int) -> dict[str, bool]:
    with db.session() as conn:
        # Soft delete: the tombstone syncs the deletion to other devices.
        conn.execute("UPDATE vocab SET deleted = 1 WHERE id = ?", (vocab_id,))
    sync.request()
    return {"ok": True}


@router.get("/export/{fmt}")
def export_vocab(fmt: str) -> Response:
    items = _items()
    if fmt == "csv":
        return Response(exporters.vocab_to_csv(items), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="arabic-vocab.csv"'})
    if fmt == "anki":
        return Response(exporters.vocab_to_anki(items), media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="arabic-vocab-anki.txt"'})
    raise HTTPException(400, "Format must be csv or anki.")

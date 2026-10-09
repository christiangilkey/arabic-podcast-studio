"""Vocabulary list endpoints."""

from __future__ import annotations

import json
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
    folders: list[str] | None = None


class FolderIn(BaseModel):
    name: str


class BulkFolders(BaseModel):
    ids: list[int]
    add: list[str] = []
    remove: list[str] = []


def _out(row: Any) -> dict[str, Any]:
    item = dict(row)
    try:
        item["folders"] = json.loads(item.get("folders") or "[]")
    except json.JSONDecodeError:
        item["folders"] = []
    return item


def _items(q: str | None = None, folder: str | None = None) -> list[dict[str, Any]]:
    with db.session() as conn:
        rows = conn.execute("SELECT * FROM vocab WHERE deleted = 0 ORDER BY created_at DESC").fetchall()
    items = [_out(r) for r in rows]
    if folder == "none":
        items = [v for v in items if not v["folders"]]
    elif folder:
        items = [v for v in items if folder in v["folders"]]
    if q:
        nq = arabic.normalize(q)
        lq = q.lower()
        items = [v for v in items if nq in v["norm"] or nq in arabic.normalize(v["sentence"])
                 or lq in v["meaning"].lower() or lq in v["notes"].lower()]
    return items


@router.get("")
def list_vocab(q: str | None = None, folder: str | None = None) -> list[dict[str, Any]]:
    return _items(q, folder)


# ----- folders -----

@router.get("/folders")
def list_folders() -> list[dict[str, Any]]:
    with db.session() as conn:
        rows = conn.execute("SELECT uid, name, created_at, updated_at FROM vocab_folders WHERE deleted = 0 "
                            "ORDER BY name COLLATE NOCASE").fetchall()
    return db.rows_to_dicts(rows)


@router.post("/folders")
def add_folder(body: FolderIn) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give the folder a name.")
    uid = "d" + ids.new_uid()[1:]
    with db.session() as conn:
        conn.execute("INSERT INTO vocab_folders(uid, name, created_at) VALUES(?,?,?)", (uid, name[:80], time.time()))
        row = conn.execute("SELECT uid, name, created_at, updated_at FROM vocab_folders WHERE uid = ?", (uid,)).fetchone()
    sync.request()
    return dict(row)


@router.patch("/folders/{uid}")
def rename_folder(uid: str, body: FolderIn) -> dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give the folder a name.")
    with db.session() as conn:
        conn.execute("UPDATE vocab_folders SET name = ? WHERE uid = ?", (name[:80], uid))
        row = conn.execute("SELECT uid, name, created_at, updated_at FROM vocab_folders WHERE uid = ?", (uid,)).fetchone()
    if row is None:
        raise HTTPException(404, "Folder not found.")
    sync.request()
    return dict(row)


@router.delete("/folders/{uid}")
def delete_folder(uid: str) -> dict[str, bool]:
    """Deletes the folder only; its words stay in the list (and in any other folders)."""
    with db.session() as conn:
        conn.execute("UPDATE vocab_folders SET deleted = 1 WHERE uid = ?", (uid,))
        rows = conn.execute("SELECT id, folders FROM vocab WHERE deleted = 0 AND folders LIKE ?",
                            (f'%"{uid}"%',)).fetchall()
        for r in rows:
            kept = [f for f in _out(r)["folders"] if f != uid]
            conn.execute("UPDATE vocab SET folders = ? WHERE id = ?", (json.dumps(sorted(kept)), r["id"]))
    sync.request()
    return {"ok": True}


@router.post("/bulk-folders")
def bulk_folders(body: BulkFolders) -> dict[str, int]:
    changed = 0
    with db.session() as conn:
        for vid in body.ids:
            row = conn.execute("SELECT folders FROM vocab WHERE id = ?", (vid,)).fetchone()
            if row is None:
                continue
            before = set(_out(row)["folders"])
            after = (before | set(body.add)) - set(body.remove)
            if after != before:
                conn.execute("UPDATE vocab SET folders = ? WHERE id = ?", (json.dumps(sorted(after)), vid))
                changed += 1
    if changed:
        sync.request()
    return {"changed": changed}


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
    return _out(row)


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
        if body.folders is not None:
            conn.execute("UPDATE vocab SET folders = ? WHERE id = ?", (json.dumps(sorted(set(body.folders))), vocab_id))
        row = conn.execute("SELECT * FROM vocab WHERE id = ?", (vocab_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Not found.")
    sync.request(delay=10)  # typing in notes: wait for a pause
    return _out(row)


@router.delete("/{vocab_id}")
def delete_vocab(vocab_id: int) -> dict[str, bool]:
    with db.session() as conn:
        # Soft delete: the tombstone syncs the deletion to other devices.
        conn.execute("UPDATE vocab SET deleted = 1 WHERE id = ?", (vocab_id,))
    sync.request()
    return {"ok": True}


@router.get("/export/{fmt}")
def export_vocab(fmt: str, folder: str | None = None, ids: str | None = None) -> Response:
    """Export everything, one folder, or exactly the words shown on screen (``ids``)."""
    items = _items(None, folder)
    if ids:
        order = {int(x): n for n, x in enumerate(ids.split(",")) if x.strip().isdigit()}
        items = sorted((v for v in items if v["id"] in order), key=lambda v: order[v["id"]])
    if fmt == "csv":
        return Response(exporters.vocab_to_csv(items), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="arabic-vocab.csv"'})
    if fmt == "anki":
        return Response(exporters.vocab_to_anki(items), media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="arabic-vocab-anki.txt"'})
    raise HTTPException(400, "Format must be csv or anki.")

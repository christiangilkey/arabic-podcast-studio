"""Vocabulary list endpoints."""

from __future__ import annotations

import base64
import json
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import arabic, audio, db, exporters, ids, paths, sync
from ..sync import engine

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


# ----- audio clips for shared words -----
# A word sent to a friend carries a short clip of its sentence, so their "Word" and "Sentence"
# buttons work without having the episode. A received word keeps that clip as clips/<uid>.ogg
# and its start/end/sent_start/sent_end are then times inside the clip.

CLIP_LEAD, CLIP_TAIL, MAX_CLIP_BYTES = 0.3, 0.45, 2 * 1024 * 1024


def _vocab_row(vocab_id: int) -> Any:
    with db.session() as conn:
        row = conn.execute("SELECT * FROM vocab WHERE id = ? AND deleted = 0", (vocab_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Not found.")
    return row


def _own_clip(row: Any) -> Path | None:
    """The clip stored with a word that was shared with this user (fetched from Drive if needed)."""
    if not row["clip"]:
        return None
    path = engine.clip_path(row["uid"])
    if not path.exists():
        path = sync.vocab_clip(row["uid"]) or path
    return path if path.exists() else None


def _episode_audio(episode_id: int | None) -> Path | None:
    if episode_id is None:
        return None
    with db.session() as conn:
        ep = conn.execute("SELECT audio_path, sync_audio_path, remote_audio, audio_type FROM episodes WHERE id = ?",
                          (episode_id,)).fetchone()
    if ep is None or (ep["audio_type"] or "") == "text/html":
        return None
    for stored in (ep["audio_path"], ep["sync_audio_path"]):
        if stored and Path(stored).exists():
            return Path(stored)
    if ep["remote_audio"]:
        return sync.audio_copy(episode_id)
    return None


@router.get("/{vocab_id}/share-clip")
def share_clip(vocab_id: int) -> dict[str, Any]:
    """The audio to send along with a word: {"audio": base64 Ogg/Opus, "times": {...}} with the
    word's and sentence's positions inside it. 404 when the word has no audio to send."""
    row = _vocab_row(vocab_id)
    own = _own_clip(row)
    if own is not None:  # passing on a word a friend shared: reuse its clip as is
        times = {k: row[k] for k in ("start", "end", "sent_start", "sent_end")}
        return {"audio": base64.b64encode(own.read_bytes()).decode("ascii"), "times": times}
    if row["start"] is None or row["sent_start"] is None or row["sent_end"] is None:
        raise HTTPException(404, "This word has no audio.")
    src = _episode_audio(row["episode_id"])
    if src is None:
        raise HTTPException(404, "The audio for this word isn't on this computer.")
    tmp = paths.tmp_dir() / f"clip-{uuid.uuid4().hex}.ogg"
    try:
        began = audio.cut_clip(src, row["sent_start"] - CLIP_LEAD, row["sent_end"] + CLIP_TAIL, tmp)
        data = tmp.read_bytes()
    except audio.AudioError as exc:
        raise HTTPException(404, str(exc)) from exc
    finally:
        tmp.unlink(missing_ok=True)
    word_end = row["end"] if row["end"] is not None else row["start"] + 1
    times = {"start": round(max(0.0, row["start"] - began), 3), "end": round(max(0.0, word_end - began), 3),
             "sent_start": round(max(0.0, row["sent_start"] - began), 3), "sent_end": round(max(0.0, row["sent_end"] - began), 3)}
    return {"audio": base64.b64encode(data).decode("ascii"), "times": times}


@router.put("/{vocab_id}/clip")
async def save_clip(vocab_id: int, request: Request, start: float = 0, end: float = 0,
                    sent_start: float = 0, sent_end: float = 0) -> dict[str, Any]:
    """Store the clip that came with a shared word (raw request body = the audio file)."""
    row = _vocab_row(vocab_id)
    data = await request.body()
    if not data or len(data) > MAX_CLIP_BYTES:
        raise HTTPException(400, "That audio clip is empty or too large.")
    dest = engine.clip_path(row["uid"])
    dest.write_bytes(data)
    with db.session() as conn:
        conn.execute("UPDATE vocab SET clip = 1, start = ?, end = ?, sent_start = ?, sent_end = ? WHERE id = ?",
                     (start, end, sent_start, sent_end, vocab_id))
        out = conn.execute("SELECT * FROM vocab WHERE id = ?", (vocab_id,)).fetchone()
    sync.request()
    return _out(out)


@router.get("/{vocab_id}/clip")
def get_clip(vocab_id: int) -> Response:
    path = _own_clip(_vocab_row(vocab_id))
    if path is None:
        raise HTTPException(404, "This word's audio isn't available.")
    return FileResponse(path, media_type="audio/ogg")


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

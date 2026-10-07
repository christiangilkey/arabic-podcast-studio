"""Full-text search across all transcripts (diacritic- and spelling-variant-insensitive)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import arabic, db

router = APIRouter(tags=["search"])


@router.get("/search")
def search(q: str, limit: int = 200) -> dict[str, Any]:
    norm = arabic.normalize(q)
    if not norm:
        return {"query": q, "results": [], "total": 0}
    limit = max(1, min(limit, 500))
    with db.session() as conn:
        if len(norm) >= 3:
            # Trigram index: substring match, so "كتاب" also finds "والكتاب".
            phrase = '"' + norm.replace('"', '""') + '"'
            hits = conn.execute(
                "SELECT episode_id, seg_idx FROM segments_fts WHERE segments_fts MATCH ? LIMIT ?",
                (phrase, limit * 2),
            ).fetchall()
            keys = [(h["episode_id"], h["seg_idx"]) for h in hits]
        else:
            rows = conn.execute("SELECT episode_id, idx FROM segments WHERE norm LIKE ? LIMIT ?",
                                (f"%{norm}%", limit * 2)).fetchall()
            keys = [(r[0], r[1]) for r in rows]
        results = []
        for ep_id, seg_idx in keys:
            row = conn.execute(
                "SELECT s.episode_id, s.idx, s.start, s.end, s.text, e.title AS episode_title, "
                "e.published, f.title AS feed_title FROM segments s "
                "JOIN episodes e ON e.id = s.episode_id JOIN feeds f ON f.id = e.feed_id "
                "WHERE s.episode_id = ? AND s.idx = ?", (ep_id, seg_idx)).fetchone()
            if row is None:
                continue
            item = dict(row)
            item["spans"] = arabic.find_spans(item["text"], q)
            results.append(item)
    results.sort(key=lambda r: (-(r["published"] or 0), r["episode_id"], r["idx"]))
    return {"query": q, "results": results[:limit], "total": len(results)}

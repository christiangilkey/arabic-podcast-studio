// The phone's stand-in for the desktop's local server: answers the same /api requests the
// shared screens make (library, player, vocab, search) from on-phone storage.
// Ids are the global uids, so links work the same everywhere.

import { lib, now, saveLibrary, transcripts } from "./store.js";
import { fetchTranscript, requestSync, syncNow, syncState } from "./sync.js";
import { feedUid, findSpans, newUid, normalize, normalizeUrl } from "./shared-logic.js";
import { settings } from "./store.js";

export class ApiError extends Error {}

const changed = () => { saveLibrary(); requestSync(); };
const feedOf = (uid) => lib.feeds.find((f) => f.uid === uid);
const episodeOf = (uid) => lib.episodes.find((e) => e.uid === uid);

export function episodeStatus(e) {
  if (e.transcript_rev) return "done";
  if (e.transcribe_requested_at) return "queued";
  return "new";
}

function feedOut(f) {
  const eps = lib.episodes.filter((e) => e.feed_uid === f.uid);
  return { ...f, id: f.uid, episode_count: eps.length, done_count: eps.filter((e) => e.transcript_rev).length,
           latest: Math.max(0, ...eps.map((e) => e.published || 0)) || null, last_checked: null, last_error: null };
}

function episodeOut(e) {
  const f = feedOf(e.feed_uid) || {};
  return { ...e, id: e.uid, feed_id: e.feed_uid, status: episodeStatus(e), progress: e.transcript_rev ? 100 : 0,
           error: null, feed_title: f.title || "", feed_image: f.image || null, has_audio: !!e.remote_audio };
}

function vocabOut(v) {
  return { ...v, id: v.uid, episode_id: v.episode_uid };
}

async function loadTranscript(uid) {
  let t = await transcripts.get(uid);
  const ep = episodeOf(uid);
  if ((!t || (ep && ep.transcript_rev && t.rev < ep.transcript_rev - 1e-3)) && settings.signed_in) {
    try { t = (await fetchTranscript(uid)) || t; } catch (e) { if (!t) throw new ApiError(`Couldn't download the transcript: ${e.message}`); }
  }
  return t;
}

const routes = [
  // ----- feeds -----
  ["GET", /^\/feeds$/, () => lib.feeds.filter((f) => !f.deleted).map(feedOut)
    .sort((a, b) => a.title.localeCompare(b.title))],
  ["POST", /^\/feeds$/, async (m, q, body) => {
    const url = normalizeUrl(body.url || "");
    if (!body.url || !body.url.trim()) throw new ApiError("Paste an RSS feed URL.");
    const uid = await feedUid(url);
    const existing = feedOf(uid);
    if (existing && !existing.deleted) throw new ApiError("You're already subscribed to this feed.");
    const t = now();
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const feed = existing
      ? Object.assign(existing, { deleted: 0, updated_at: t })
      : { uid, url, title: host, description: "Episodes appear after your computer syncs this feed.", image: null,
          link: null, auto_transcribe: 0, deleted: 0, created_at: t, updated_at: t };
    if (!existing) lib.feeds.push(feed);
    changed();
    return feedOut(feed);
  }],
  ["PATCH", /^\/feeds\/([\w]+)$/, (m, q, body) => {
    const f = feedOf(m[1]);
    if (!f) throw new ApiError("Feed not found.");
    if (body.auto_transcribe !== undefined) { f.auto_transcribe = body.auto_transcribe ? 1 : 0; f.updated_at = now(); changed(); }
    return feedOut(f);
  }],
  ["DELETE", /^\/feeds\/([\w]+)$/, async (m) => {
    const f = feedOf(m[1]);
    if (f) {
      f.deleted = 1;
      f.updated_at = now();
      for (const e of lib.episodes.filter((x) => x.feed_uid === f.uid)) await transcripts.delete(e.uid).catch(() => {});
      lib.episodes = lib.episodes.filter((e) => e.feed_uid !== f.uid);
      changed();
    }
    return { ok: true };
  }],
  ["POST", /^\/feeds\/refresh$/, async () => {
    if (!settings.signed_in) throw new ApiError("Sign in with Google (Settings) to get your library from your computer.");
    const before = lib.episodes.length;
    await syncNow();
    if (syncState.state === "error") throw new ApiError(syncState.error);
    return { ok: true, new_episodes: Math.max(0, lib.episodes.length - before) };
  }],

  // ----- episodes -----
  ["GET", /^\/episodes$/, (m, q) => {
    let eps = lib.episodes.filter((e) => feedOf(e.feed_uid) && !feedOf(e.feed_uid).deleted);
    if (q.get("feed_id")) eps = eps.filter((e) => e.feed_uid === q.get("feed_id"));
    const counts = {};
    for (const e of eps) counts[episodeStatus(e)] = (counts[episodeStatus(e)] || 0) + 1;
    const status = q.get("status");
    if (status === "active" || status === "failed") eps = [];
    else if (status) eps = eps.filter((e) => episodeStatus(e) === status);
    const title = (q.get("q") || "").toLowerCase();
    if (title) eps = eps.filter((e) => (e.title || "").toLowerCase().includes(title));
    eps.sort((a, b) => (b.published || b.created_at || 0) - (a.published || a.created_at || 0));
    const offset = Number(q.get("offset") || 0);
    const limit = Number(q.get("limit") || 100);
    return { total: eps.length, items: eps.slice(offset, offset + limit).map(episodeOut), counts, current: null };
  }],
  ["POST", /^\/episodes\/transcribe$/, (m, q, body) => {
    const queued = [];
    for (const id of body.ids || []) {
      const e = episodeOf(id);
      if (!e || e.transcript_rev) continue;
      e.transcribe_requested_at = now();
      e.updated_at = now();
      queued.push(id);
    }
    if (queued.length) changed();
    return { queued, note: "Your computer will transcribe these the next time it syncs." };
  }],
  ["POST", /^\/episodes\/([\w]+)\/cancel$/, (m) => {
    const e = episodeOf(m[1]);
    if (e && e.transcribe_requested_at) { e.transcribe_requested_at = null; e.updated_at = now(); changed(); }
    return { ok: true };
  }],
  ["GET", /^\/episodes\/([\w]+)\/transcript$/, async (m) => {
    const e = episodeOf(m[1]);
    if (!e) throw new ApiError("Episode not found.");
    const t = e.transcript_rev ? await loadTranscript(e.uid) : null;
    const segments = t ? t.segments.map(([start, end, text], idx) => ({ idx, start, end, text })) : [];
    const words = t ? t.words : { start: [], end: [], text: [], seg: [] };
    const ep = episodeOut(e);
    if (e.transcript_rev && !t) ep.status = "new";
    return { episode: ep, segments, words };
  }],
  ["GET", /^\/episodes\/([\w]+)$/, (m) => {
    const e = episodeOf(m[1]);
    if (!e) throw new ApiError("Episode not found.");
    return episodeOut(e);
  }],

  // ----- search (transcripts stored on this phone) -----
  ["GET", /^\/search$/, async (m, q) => {
    const query = q.get("q") || "";
    const norm = normalize(query);
    const results = [];
    if (!norm) return { query, results, total: 0 };
    for (const e of lib.episodes) {
      if (!e.transcript_rev) continue;
      const t = await transcripts.get(e.uid);
      if (!t) continue;
      const f = feedOf(e.feed_uid) || {};
      t.segments.forEach(([start, end, text], idx) => {
        if (normalize(text).includes(norm)) {
          results.push({ episode_id: e.uid, idx, start, end, text, episode_title: e.title, published: e.published,
                         feed_title: f.title || "", spans: findSpans(text, query) });
        }
      });
    }
    results.sort((a, b) => (b.published || 0) - (a.published || 0) || a.idx - b.idx);
    return { query, results: results.slice(0, 200), total: results.length };
  }],

  // ----- vocab -----
  ["GET", /^\/vocab$/, (m, q) => {
    let items = lib.vocab.filter((v) => !v.deleted).sort((a, b) => b.created_at - a.created_at);
    const query = q.get("q");
    if (query) {
      const nq = normalize(query);
      const lq = query.toLowerCase();
      items = items.filter((v) => normalize(v.text).includes(nq) || normalize(v.sentence).includes(nq)
        || (v.meaning || "").toLowerCase().includes(lq) || (v.notes || "").toLowerCase().includes(lq));
    }
    return items.map(vocabOut);
  }],
  ["POST", /^\/vocab$/, (m, q, body) => {
    const text = (body.text || "").trim();
    if (!text) throw new ApiError("Nothing to save.");
    const e = body.episode_id ? episodeOf(body.episode_id) : null;
    const t = now();
    const v = { uid: newUid(), episode_uid: e ? e.uid : null, text, sentence: (body.sentence || "").trim(),
                start: body.start ?? null, end: body.end ?? null, sent_start: body.sent_start ?? null,
                sent_end: body.sent_end ?? null, meaning: body.meaning || "", notes: body.notes || "",
                episode_title: e ? e.title : "", deleted: 0, created_at: t, updated_at: t };
    lib.vocab.push(v);
    changed();
    return vocabOut(v);
  }],
  ["PATCH", /^\/vocab\/([\w]+)$/, (m, q, body) => {
    const v = lib.vocab.find((x) => x.uid === m[1]);
    if (!v) throw new ApiError("Not found.");
    for (const k of ["meaning", "notes", "text"]) if (body[k] !== undefined && body[k] !== null) v[k] = body[k];
    v.updated_at = now();
    changed();
    return vocabOut(v);
  }],
  ["DELETE", /^\/vocab\/([\w]+)$/, (m) => {
    const v = lib.vocab.find((x) => x.uid === m[1]);
    if (v) { v.deleted = 1; v.updated_at = now(); changed(); }
    return { ok: true };
  }],

  // ----- definitions cache (synced) -----
  ["GET", /^\/definitions\/([\w]+)$/, (m) => {
    const d = lib.definitions.find((x) => x.key === m[1]);
    return d ? d.data : null;
  }],
  ["PUT", /^\/definitions\/([\w]+)$/, (m, q, body) => {
    if (!lib.definitions.find((x) => x.key === m[1])) {
      lib.definitions.push({ key: m[1], word: body.word, sentence: body.sentence, data: body.data,
                             provider: body.provider || "", model: body.model || "", created_at: now() });
      saveLibrary();
      requestSync(30000);
    }
    return { ok: true };
  }],
];

export async function handle(path, method, body) {
  const [p, qs] = path.split("?");
  const q = new URLSearchParams(qs || "");
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const match = p.match(re);
    if (match) return fn(match, q, body || {});
  }
  throw new ApiError(`Not available on the phone: ${method} ${p}`);
}

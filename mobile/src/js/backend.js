// The phone's stand-in for the desktop's local server: answers the same /api requests the
// shared screens make (library, player, vocab, search) from on-phone storage.
// Ids are the global uids, so links work the same everywhere.

import { audio, kv, lib, now, saveLibrary, transcripts } from "./store.js";
import { fetchTranscript, requestSync, syncNow, syncState } from "./sync.js";
import { episodeUid, feedUid, findSpans, newUid, normalize, normalizeUrl } from "./shared-logic.js";
import { settings } from "./store.js";

export class ApiError extends Error {}

const changed = () => { saveLibrary(); requestSync(); };
const feedOf = (uid) => lib.feeds.find((f) => f.uid === uid);
const episodeOf = (uid) => lib.episodes.find((e) => e.uid === uid && !e.deleted);
const liveEpisodes = () => lib.episodes.filter((e) => !e.deleted);

export const LOCAL_FEED_URL = "local:videos";
const PAGES_FEED_URL = "local:pages";
const PAGE_KINDS = ["h1", "h2", "h3", "p", "li", "q"];
const MAX_PAGE_WORDS = 30000;

function cleanPageUrl(text) {
  let url = String(text || "").trim();
  if (/^(javascript|data|file|vbscript|about|blob|chrome|edge):/i.test(url)) url = "";
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  let u;
  try { u = new URL(url); } catch { u = null; }
  if (!u || !["http:", "https:"].includes(u.protocol) || !u.hostname) {
    throw new ApiError("Paste a web address, like https://example.com/article");
  }
  return url;
}

/** Store an imported web page (same layout as the desktop's app/pages.py): the page's text is
 * its "transcript", one segment per block, word "times" are just positions. */
async function savePage(body) {
  const url = cleanPageUrl(body.url);
  const segments = [];
  const kinds = [];
  const words = { start: [], end: [], text: [], seg: [] };
  for (const b of body.blocks || []) {
    let tokens = String(b.text || "").split(/\s+/).filter(Boolean);
    if (words.text.length + tokens.length > MAX_PAGE_WORDS) tokens = tokens.slice(0, MAX_PAGE_WORDS - words.text.length);
    if (!tokens.length) continue;
    const first = words.text.length;
    tokens.forEach((t, i) => { words.start.push(first + i); words.end.push(first + i + 1); words.text.push(t); words.seg.push(segments.length); });
    segments.push([first, first + tokens.length, tokens.join(" ")]);
    kinds.push(PAGE_KINDS.includes(b.kind) ? b.kind : "p");
  }
  if (!segments.length) throw new ApiError("No readable text was found on that page.");
  const t = now();
  const fuid = await feedUid(PAGES_FEED_URL);
  let feed = feedOf(fuid);
  if (!feed) {
    feed = { uid: fuid, url: PAGES_FEED_URL, title: "My webpages", description: "Web pages you imported to read with clickable words.",
             image: null, link: null, auto_transcribe: 0, deleted: 0, created_at: t, updated_at: t };
    lib.feeds.push(feed);
  } else if (feed.deleted) {
    Object.assign(feed, { deleted: 0, updated_at: t });
  }
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const uid = await episodeUid(fuid, url);
  const title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 300) || host || "Web page";
  const image = typeof body.image === "string" && body.image.startsWith("https://") ? body.image : null;
  const fields = { title, description: String(body.site || host).slice(0, 200), image, audio_url: url, audio_type: "text/html",
                   transcript_rev: t, model: "webpage", deleted: 0, updated_at: t };
  let ep = lib.episodes.find((e) => e.uid === uid);
  if (ep) Object.assign(ep, fields);
  else {
    ep = { uid, feed_uid: fuid, guid: url, published: t, duration: null, transcribe_requested_at: null, remote_audio: 0,
           created_at: t, ...fields };
    lib.episodes.push(ep);
  }
  await transcripts.put(uid, { format: 1, rev: t, model: "webpage", kinds, segments, words });
  // The text has to reach Drive too, so the computer and other devices get the page.
  const pending = new Set((await kv.get("pending_transcripts")) || []);
  pending.add(uid);
  await kv.set("pending_transcripts", [...pending]);
  changed();
  return { ...episodeOut(ep), words: words.text.length };
}

/** Record a video this phone just uploaded to Drive; the computer transcribes it on its next sync. */
export async function addUploadedVideo({ uid, title, driveName, mime, duration }) {
  const fuid = await feedUid(LOCAL_FEED_URL);
  const t = now();
  let feed = feedOf(fuid);
  if (!feed) {
    feed = { uid: fuid, url: LOCAL_FEED_URL, title: "My videos", description: "Video files you added yourself. They're stored in your Google Drive.",
             image: null, link: null, auto_transcribe: 0, deleted: 0, created_at: t, updated_at: t };
    lib.feeds.push(feed);
  } else if (feed.deleted) {
    Object.assign(feed, { deleted: 0, updated_at: t });
  }
  const ep = { uid, feed_uid: fuid, guid: uid, title, description: "", published: t, duration: duration || null, image: null,
               audio_url: `drive:${driveName}`, audio_type: mime, transcript_rev: null, model: null,
               transcribe_requested_at: t, remote_audio: 1, deleted: 0, created_at: t, updated_at: t };
  lib.episodes.push(ep);
  changed();
  return episodeOut(ep);
}

export function episodeStatus(e) {
  if (e.transcript_rev) return "done";
  if (e.transcribe_requested_at) return "queued";
  return "new";
}

function feedOut(f) {
  const eps = liveEpisodes().filter((e) => e.feed_uid === f.uid);
  return { ...f, id: f.uid, episode_count: eps.length, done_count: eps.filter((e) => e.transcript_rev).length,
           latest: Math.max(0, ...eps.map((e) => e.published || 0)) || null, last_checked: null, last_error: null };
}

function episodeOut(e) {
  const f = feedOf(e.feed_uid) || {};
  return { ...e, id: e.uid, feed_id: e.feed_uid, status: episodeStatus(e), progress: e.transcript_rev ? 100 : 0,
           error: null, feed_title: f.title || "", feed_image: f.image || null, feed_url: f.url || "",
           has_audio: !!e.remote_audio };
}

function vocabOut(v) {
  return { ...v, id: v.uid, episode_id: v.episode_uid, folders: v.folders || [] };
}
const folderOut = (f) => ({ uid: f.uid, name: f.name, created_at: f.created_at, updated_at: f.updated_at });
const liveFolders = () => (lib.folders || []).filter((f) => !f.deleted).sort((a, b) => a.name.localeCompare(b.name));

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
    if (f && f.url.startsWith("local:")) throw new ApiError("Delete its items one by one; this built-in list can't be removed.");
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
    return { ok: true, new_episodes: Math.max(0, lib.episodes.length - before), synced: true };
  }],

  // ----- episodes -----
  ["GET", /^\/episodes$/, (m, q) => {
    let eps = liveEpisodes().filter((e) => feedOf(e.feed_uid) && !feedOf(e.feed_uid).deleted);
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
    const kinds = (t && t.kinds) || [];
    const segments = t ? t.segments.map(([start, end, text], idx) => ({ idx, start, end, text, kind: kinds[idx] || null })) : [];
    const words = t ? t.words : { start: [], end: [], text: [], seg: [] };
    const ep = episodeOut(e);
    if (e.transcript_rev && !t) ep.status = "new";
    return { episode: ep, segments, words };
  }],
  ["POST", /^\/pages$/, (m, q, body) => savePage(body)],
  ["DELETE", /^\/episodes\/([\w]+)$/, async (m) => {
    const e = episodeOf(m[1]);
    if (!e) return { ok: true };
    const f = feedOf(e.feed_uid);
    if (!f || !f.url.startsWith("local:")) throw new ApiError("Podcast episodes can't be deleted; remove the podcast instead.");
    // A tombstone: every device removes it, and the computer frees the Drive space.
    Object.assign(e, { deleted: 1, transcribe_requested_at: null, updated_at: now() });
    await transcripts.delete(e.uid).catch(() => {});
    await audio.delete(e.uid).catch(() => {});
    changed();
    return { ok: true };
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
    for (const e of liveEpisodes()) {
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
    const folder = q.get("folder");
    if (folder === "none") items = items.filter((v) => !(v.folders || []).length);
    else if (folder) items = items.filter((v) => (v.folders || []).includes(folder));
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
                episode_title: e ? e.title : "", folders: [], deleted: 0, created_at: t, updated_at: t };
    lib.vocab.push(v);
    changed();
    return vocabOut(v);
  }],
  // ----- vocab folders (a word can be in several) -----
  ["GET", /^\/vocab\/folders$/, () => liveFolders().map(folderOut)],
  ["POST", /^\/vocab\/folders$/, (m, q, body) => {
    const name = (body.name || "").trim().slice(0, 80);
    if (!name) throw new ApiError("Give the folder a name.");
    const t = now();
    const f = { uid: `d${newUid().slice(1)}`, name, deleted: 0, created_at: t, updated_at: t };
    (lib.folders = lib.folders || []).push(f);
    changed();
    return folderOut(f);
  }],
  ["PATCH", /^\/vocab\/folders\/([\w]+)$/, (m, q, body) => {
    const f = (lib.folders || []).find((x) => x.uid === m[1]);
    const name = (body.name || "").trim().slice(0, 80);
    if (!f) throw new ApiError("Folder not found.");
    if (!name) throw new ApiError("Give the folder a name.");
    Object.assign(f, { name, updated_at: now() });
    changed();
    return folderOut(f);
  }],
  ["DELETE", /^\/vocab\/folders\/([\w]+)$/, (m) => {
    const f = (lib.folders || []).find((x) => x.uid === m[1]);
    if (f) {
      Object.assign(f, { deleted: 1, updated_at: now() });
      for (const v of lib.vocab) {
        if ((v.folders || []).includes(f.uid)) { v.folders = v.folders.filter((x) => x !== f.uid); v.updated_at = now(); }
      }
      changed();
    }
    return { ok: true };
  }],
  ["POST", /^\/vocab\/bulk-folders$/, (m, q, body) => {
    let n = 0;
    for (const id of body.ids || []) {
      const v = lib.vocab.find((x) => x.uid === id);
      if (!v) continue;
      const before = v.folders || [];
      const after = [...new Set([...before, ...(body.add || [])])].filter((x) => !(body.remove || []).includes(x)).sort();
      if (after.join() !== [...before].sort().join()) { v.folders = after; v.updated_at = now(); n++; }
    }
    if (n) changed();
    return { changed: n };
  }],
  ["PATCH", /^\/vocab\/([\w]+)$/, (m, q, body) => {
    const v = lib.vocab.find((x) => x.uid === m[1]);
    if (!v) throw new ApiError("Not found.");
    if (Array.isArray(body.folders)) v.folders = [...new Set(body.folders)].sort();
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

// Phone side of Google Drive sync: same files and merge rules as app/sync/engine.py.
//   library.json.gz       merged record by record (newest updated_at wins; tombstones kept)
//   t_<episode>.json.gz   transcripts, downloaded for offline reading and search
//   a_<episode>.ogg       audio copies, fetched when an episode is first played
//   v_<episode>.<ext>     the user's own videos, streamed from Drive (DriveMediaWebViewClient.java)
// The phone never transcribes; it can ask the desktop to (episode.transcribe_requested_at).

import { drive, gunzipJson, gzipJson } from "./drive.js";
import { audio, kv, lib, saveLibrary, settings, transcripts } from "./store.js";

const LIBRARY = "library.json.gz";
const listeners = new Set();
export const syncState = { state: "idle", last_sync: null, error: null, downloaded: 0 };

export function onSync(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function publish(patch) {
  Object.assign(syncState, patch);
  for (const fn of listeners) { try { fn({ ...syncState }); } catch (e) { console.error(e); } }
}

// ---------- merge ----------
const newer = (r, l) => (r.updated_at || 0) > (l.updated_at || 0);

export function merge(remote) {
  let changed = 0;
  const feeds = new Map(lib.feeds.map((f) => [f.uid, f]));
  for (const r of remote.feeds || []) {
    const l = feeds.get(r.uid);
    if (!l || newer(r, l)) { feeds.set(r.uid, r); changed++; }
  }
  lib.feeds = [...feeds.values()];
  const deadFeeds = new Set(lib.feeds.filter((f) => f.deleted).map((f) => f.uid));

  const eps = new Map(lib.episodes.map((e) => [e.uid, e]));
  for (const r of remote.episodes || []) {
    const l = eps.get(r.uid);
    if (!l) { eps.set(r.uid, r); changed++; continue; }
    if (newer(r, l)) {
      // A pending request from this phone survives a newer remote record (desktop does the same).
      const req = Math.max(l.transcribe_requested_at || 0, r.transcribe_requested_at || 0) || null;
      eps.set(r.uid, { ...r, transcribe_requested_at: req });
      changed++;
    }
  }
  lib.episodes = [...eps.values()].filter((e) => !deadFeeds.has(e.feed_uid));

  const vocab = new Map(lib.vocab.map((v) => [v.uid, v]));
  for (const r of remote.vocab || []) {
    const l = vocab.get(r.uid);
    if (!l || newer(r, l)) { vocab.set(r.uid, r); changed++; }
  }
  lib.vocab = [...vocab.values()];

  const folders = new Map((lib.folders || []).map((f) => [f.uid, f]));
  for (const r of remote.folders || []) {
    const l = folders.get(r.uid);
    if (!l || newer(r, l)) { folders.set(r.uid, r); changed++; }
  }
  lib.folders = [...folders.values()];

  const defs = new Map(lib.definitions.map((d) => [d.key, d]));
  for (const r of remote.definitions || []) if (!defs.has(r.key)) { defs.set(r.key, r); changed++; }
  lib.definitions = [...defs.values()];
  return changed;
}

export function snapshot() {
  const live = new Set(lib.feeds.filter((f) => !f.deleted).map((f) => f.uid));
  const byUid = (a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  return {
    format: 1,
    device: "android",
    feeds: [...lib.feeds].sort(byUid),
    episodes: lib.episodes.filter((e) => live.has(e.feed_uid)).sort(byUid),
    vocab: [...lib.vocab].sort(byUid),
    folders: [...(lib.folders || [])].sort(byUid),
    definitions: [...lib.definitions].sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
const content = (l) => canonical({ feeds: l.feeds, episodes: l.episodes, vocab: l.vocab, folders: l.folders || [],
                                   definitions: l.definitions });

// ---------- run ----------
let running = null;
let timer = 0;

/** Schedule a sync shortly (debounced), e.g. after a local edit. */
export function requestSync(delayMs = 3000) {
  if (!settings.signed_in) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), delayMs);
}

export function syncNow() {
  if (!settings.signed_in) return Promise.resolve(syncState);
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  publish({ state: "syncing", error: null });
  try {
    let files = Object.fromEntries((await drive.list()).map((f) => [f.name, f]));
    await uploadPendingTranscripts(files);
    await uploadPendingClips(files);
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = files[LIBRARY];
      const remote = meta ? await gunzipJson(await drive.download(meta.id)) : null;
      if (remote) merge(remote);
      const local = snapshot();
      if (remote && content(remote) === content(local)) break;
      if (meta) {
        const current = await drive.get(meta.id);
        if (current.modifiedTime !== meta.modifiedTime) { files[LIBRARY] = current; continue; }
      }
      files[LIBRARY] = await drive.upload(LIBRARY, await gzipJson(local), "application/gzip", meta ? meta.id : null);
      break;
    }
    saveLibrary();
    await kv.set("drive_files", files);
    await forgetDeleted();
    const downloaded = await prefetchTranscripts(files);
    publish({ state: "idle", last_sync: Date.now() / 1000, downloaded });
  } catch (e) {
    publish({ state: "error", error: e.message || String(e) });
  }
  return syncState;
}

/** Upload the text of web pages imported on this phone (before the library mentions them). */
async function uploadPendingTranscripts(files) {
  const pending = (await kv.get("pending_transcripts")) || [];
  if (!pending.length) return;
  const left = [];
  for (const uid of pending) {
    const payload = await transcripts.get(uid);
    const ep = lib.episodes.find((e) => e.uid === uid);
    if (!payload || !ep || ep.deleted) continue;
    const name = `t_${uid}.json.gz`;
    try {
      files[name] = await drive.upload(name, await gzipJson(payload), "application/gzip", files[name] ? files[name].id : null);
    } catch (e) {
      console.warn("Page upload failed", uid, e);
      left.push(uid);
    }
  }
  await kv.set("pending_transcripts", left);
}

/** Upload audio clips of words friends shared with this phone, so the computer gets them too. */
async function uploadPendingClips(files) {
  const pending = (await kv.get("pending_clips")) || [];
  if (!pending.length) return;
  const left = [];
  for (const uid of pending) {
    const blob = await audio.get(`clip:${uid}`);
    const word = lib.vocab.find((v) => v.uid === uid);
    if (!blob || !word || word.deleted) continue;
    const name = `c_${uid}.ogg`;
    try {
      if (!files[name]) files[name] = await drive.upload(name, blob, "audio/ogg");
    } catch (e) {
      console.warn("Clip upload failed", uid, e);
      left.push(uid);
    }
  }
  await kv.set("pending_clips", left);
}

/** Free phone storage held by videos deleted on any device. */
async function forgetDeleted() {
  for (const ep of lib.episodes) {
    if (!ep.deleted) continue;
    await transcripts.delete(ep.uid).catch(() => {});
    await audio.delete(ep.uid).catch(() => {});
  }
}

async function prefetchTranscripts(files) {
  let n = 0;
  for (const ep of lib.episodes) {
    if (ep.deleted) continue;
    const rev = ep.transcript_rev;
    const meta = files[`t_${ep.uid}.json.gz`];
    if (!rev || !meta) continue;
    const have = await transcripts.get(ep.uid);
    if (have && have.rev >= rev - 1e-3) continue;
    try {
      await transcripts.put(ep.uid, await gunzipJson(await drive.download(meta.id)));
      n++;
    } catch (e) {
      console.warn("Transcript download failed", ep.uid, e);
    }
  }
  return n;
}

/** Download a transcript now (e.g. when opening an episode before a sync finished). */
export async function fetchTranscript(uid) {
  const files = (await kv.get("drive_files")) || {};
  let meta = files[`t_${uid}.json.gz`];
  if (!meta) meta = (await drive.list()).find((f) => f.name === `t_${uid}.json.gz`);
  if (!meta) return null;
  const payload = await gunzipJson(await drive.download(meta.id));
  await transcripts.put(uid, payload);
  return payload;
}

/** Drive file id for a file in the app folder (cached; refreshed if missing). */
export async function driveFileId(name) {
  let files = (await kv.get("drive_files")) || {};
  if (!files[name]) {
    files = Object.fromEntries((await drive.list()).map((f) => [f.name, f]));
    await kv.set("drive_files", files);
  }
  return files[name] ? files[name].id : null;
}

/** Local audio copy for an episode, downloading it from Drive the first time. */
export async function audioCopy(uid) {
  const cached = await audio.get(uid);
  if (cached) return cached;
  const name = `a_${uid}.ogg`;
  let files = (await kv.get("drive_files")) || {};
  if (!files[name]) {
    files = Object.fromEntries((await drive.list()).map((f) => [f.name, f]));
    await kv.set("drive_files", files);
  }
  if (!files[name]) return null;
  const blob = await drive.downloadBlob(files[name].id);
  await audio.put(uid, blob);
  return blob;
}

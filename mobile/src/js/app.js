// Phone app shell. Same exports as the desktop's web/js/app.js, so the shared screens
// (library, player, vocab, search) import from "../app.js" and work unchanged.

import * as home from "./pages/home.js";
import * as library from "./pages/library.js";
import * as player from "./pages/player.js";
import * as vocab from "./pages/vocab.js";
import * as search from "./pages/search.js";
import * as settingsPage from "./pages/settings.js";
import * as welcome from "./pages/welcome.js";
import * as friends from "./pages/friends.js";
import * as chat from "./pages/chat.js";
import { startBadge } from "./social.js";
import { addUploadedVideo, handle } from "./backend.js";
import { accessToken, drive } from "./drive.js";
import { App, Filesystem, GoogleDriveAuth, NativeHttp, Share, isNative } from "./native.js";
import { kv, lib, loadLibrary, loadSettings, saveSettingsPatch, settings } from "./store.js";
import { audioCopy, driveFileId, onSync, syncNow } from "./sync.js";
import { newUid, toSrt, toTxt, toVtt, vocabAnki, vocabCsv } from "./shared-logic.js";

export const platform = "android";

// ---------- API (answered on the phone) ----------
export async function api(path, { method = "GET", body } = {}) {
  return handle(path, method, body);
}

// ---------- helpers (identical to desktop) ----------
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export function fmtDate(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}
export function fmtDuration(sec) {
  if (!sec) return "";
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
export function fmtBytes(n) {
  if (!n) return "0 MB";
  return n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : `${Math.round(n / 2 ** 20)} MB`;
}

// ---------- events ----------
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) {
  for (const fn of listeners.get(event) || []) { try { fn(data); } catch (e) { console.error(e); } }
}

// ---------- toasts ----------
export function toast(message, { error = false, action, timeout = 4000 } = {}) {
  const el = h(`<div class="toast${error ? " error" : ""}"><span></span></div>`);
  el.firstChild.textContent = message;
  if (action) {
    const b = h(`<button type="button"></button>`);
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.append(b);
  }
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), error ? timeout * 2 : timeout);
}
export function requestNotifications() { /* toasts are used on the phone */ }

// ---------- audio ----------
const objectUrls = new Map();
/** Synced audio copy (exactly what was transcribed), downloaded on first play; else the original. */
export async function audioUrl(uid) {
  const ep = lib.episodes.find((e) => e.uid === uid);
  if (ep && (ep.audio_url || "").startsWith("drive:")) return videoUrl(ep);
  if (ep && ep.remote_audio && settings.signed_in) {
    if (objectUrls.has(uid)) return objectUrls.get(uid);
    try {
      toast("Loading audio…");
      const blob = await audioCopy(uid);
      if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.set(uid, url);
        return url;
      }
    } catch (e) {
      toast(`Couldn't load the synced audio, streaming the original instead. (${e.message})`, { error: true });
    }
  }
  return ep ? ep.audio_url : "";
}

// ---------- online features (friends, sharing) ----------
// The "Web" Google client that Supabase trusts; Android issues the ID token for it.
const WEB_CLIENT_ID = "419555269865-0954ljffgrnbveq04lvh3ii6c032rhv3.apps.googleusercontent.com";

/** Google ID token for the online features. Google gets a hash of a one-time code (nonce) and
 * Supabase the code itself, so a token can't be replayed by anyone else. */
export async function googleIdToken() {
  if (!isNative) throw new Error("Connecting works in the installed Android app.");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  const hashed = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const r = await GoogleDriveAuth.getIdToken({ serverClientId: WEB_CLIENT_ID, nonce: hashed });
  return { token: r.idToken, nonce };
}

// ---------- feedback ----------
/** A short vibration for an action: "tick" for small things, "success" for a saved word.
 * Can be switched off in Settings (many people prefer none). */
export function buzz(kind = "tick") {
  if (settings.haptics === false || !navigator.vibrate) return;
  try { navigator.vibrate(kind === "success" ? [14, 50, 22] : 8); } catch { /* not supported */ }
}

// ---------- web pages ----------
/** Download a web page for "Add a webpage": {url, html}. */
export async function fetchPage(url) {
  let address = String(url || "").trim();
  if (address && !/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) address = `https://${address}`;
  if (!/^https?:\/\/[^\s/]+/i.test(address)) throw new Error("Paste a web address, like https://example.com/article");
  if (!isNative) throw new Error("Importing pages works in the installed Android app.");
  let res;
  try {
    res = await NativeHttp.get({ url: address, responseType: "text", connectTimeout: 15000, readTimeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
                 "Accept-Language": "ar,en;q=0.8" } });
  } catch (e) {
    throw new Error("Couldn't reach that site. Check the address and your connection.");
  }
  if (res.status >= 400) throw new Error(`The site answered with an error (${res.status}). Try “Open Web Browser” and use Import Page there.`);
  return { url: res.url || address, html: typeof res.data === "string" ? res.data : String(res.data || "") };
}

let browserListening = false;
/** Open the in-app web browser (native screen with an "Import Page" button). */
export async function openBrowser(url = "") {
  if (!isNative) {
    window.open(/^https?:/i.test(url) ? url : "https://www.google.com", "_blank", "noopener");
    toast("Copy the address of the page you want and paste it under “Add a webpage”.");
    return;
  }
  const { extractorSource, saveArticle } = await import("./pageimport.js");
  if (!browserListening) {
    browserListening = true;
    GoogleDriveAuth.addListener("pageImport", async ({ result }) => {
      let message;
      try {
        // The native side hands over the page's own answer, which is JSON inside a JSON string.
        let article = JSON.parse(result || "null");
        if (typeof article === "string") article = JSON.parse(article);
        const ep = await saveArticle(article);
        message = `Imported “${ep.title}” (${ep.words} words). It's in My webpages.`;
        emit("feeds", { refreshed: true });
      } catch (e) {
        message = e.message || "Couldn't import this page.";
      }
      GoogleDriveAuth.browserToast({ text: message }).catch(() => {});
    });
  }
  await GoogleDriveAuth.openBrowser({ url, extractor: await extractorSource() });
}

// ---------- own videos ----------
// Videos stream from the user's Drive through DriveMediaWebViewClient.java, which adds the
// sign-in token that a <video> element can't send itself.
async function refreshMediaToken() {
  if (!isNative || !settings.signed_in) return;
  try { await GoogleDriveAuth.setMediaToken({ token: await accessToken() }); } catch (e) { console.warn(e); }
}

async function videoUrl(ep) {
  if (!settings.signed_in) throw new Error("Sign in with Google (Settings) to watch videos stored in your Drive.");
  if (!ep.remote_audio) throw new Error("This video is still uploading from your computer.");
  if (!isNative) throw new Error("Videos play in the installed Android app.");
  await refreshMediaToken();
  const id = await driveFileId(ep.audio_url.slice("drive:".length));
  if (!id) throw new Error("The video isn't in your Google Drive any more.");
  return `${location.origin}/_drive/${id}`;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i;

function videoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : null); };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

/** Upload a video to Drive; the computer transcribes it on its next sync. */
export async function uploadVideo(file, onProgress) {
  if (!settings.signed_in) throw new Error("Sign in with Google (Settings) first: videos are stored in your Drive.");
  const ext = (file.name.match(VIDEO_EXT) || [])[1];
  if (!ext && !(file.type || "").startsWith("video/")) throw new Error("Choose a video file (MP4, MOV, WebM, MKV, AVI or 3GP).");
  const suffix = `.${(ext || "mp4").toLowerCase()}`;
  const mime = file.type || "video/mp4";
  const uid = `e${newUid().slice(1)}`;
  const driveName = `v_${uid}${suffix}`;
  const duration = await videoDuration(file);
  const meta = await drive.uploadLarge(driveName, file, mime, onProgress);
  const files = (await kv.get("drive_files")) || {};
  files[driveName] = meta;
  await kv.set("drive_files", files);
  const title = file.name.replace(/\.[^.]+$/, "") || "Video";
  const ep = await addUploadedVideo({ uid, title, driveName, mime, duration });
  return { ...ep, note: "Your computer transcribes it the next time it syncs." };
}

// ---------- exports (share sheet) ----------
async function exportText(url) {
  let m;
  if ((m = url.match(/\/api\/episodes\/(\w+)\/export\/(txt|srt|vtt)$/))) {
    const t = await api(`/episodes/${m[1]}/transcript`);
    const segs = t.segments;
    return m[2] === "txt" ? toTxt(segs, t.episode.title) : m[2] === "srt" ? toSrt(segs) : toVtt(segs);
  }
  if ((m = url.match(/\/api\/vocab\/export\/(csv|anki)(?:\?ids=([^&]*))?$/))) {
    let items = lib.vocab.filter((v) => !v.deleted).sort((a, b) => b.created_at - a.created_at);
    if (m[2] !== undefined) {
      // Exactly the words shown on the vocab screen, in that order.
      const order = decodeURIComponent(m[2]).split(",");
      items = order.map((uid) => items.find((v) => v.uid === uid)).filter(Boolean);
    }
    return m[1] === "csv" ? vocabCsv(items) : vocabAnki(items);
  }
  throw new Error("Unknown export.");
}

export async function download(url, filename) {
  try {
    const text = await exportText(url);
    if (isNative) {
      const res = await Filesystem.writeFile({ path: filename, data: text, directory: "CACHE", encoding: "utf8" });
      await Share.share({ title: filename, files: [res.uri] });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      a.download = filename;
      a.click();
    }
  } catch (e) {
    if (!/cancel/i.test(e.message || "")) toast(e.message, { error: true });
  }
}

// ---------- settings & theme ----------
export const state = { status: { settings } };

export function applySettings(s) {
  const root = document.documentElement;
  if (s.theme === "light" || s.theme === "dark") root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  root.style.setProperty("--ar-size", `${s.font_size || 26}px`);
}
export async function saveSettings(values) {
  const s = await saveSettingsPatch(values);
  applySettings(s);
  return s;
}
export async function loadStatus() {
  return state.status;
}

// ---------- context menu (shared player uses it) ----------
export function showMenu(x, y, label, items) {
  const menu = document.getElementById("ctxmenu");
  menu.innerHTML = "";
  if (label) {
    const l = h(`<div class="label ar"></div>`);
    l.textContent = label;
    menu.append(l);
  }
  for (const item of items) {
    const b = h(`<button type="button" role="menuitem"></button>`);
    b.textContent = item.label;
    b.onclick = () => { hideMenu(); item.run(); };
    menu.append(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}
export function hideMenu() { document.getElementById("ctxmenu").hidden = true; }
document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctxmenu")) hideMenu(); }, true);

// ---------- router ----------
const routes = [
  [/^$/, home, () => ({})],
  [/^library$/, library, () => ({})],
  [/^feed\/(\w+)$/, library, (m) => ({ feedId: m[1] })],
  [/^episode\/(\w+)$/, player, (m) => ({ id: m[1] })],
  [/^vocab$/, vocab, () => ({})],
  [/^search$/, search, () => ({})],
  [/^settings$/, settingsPage, () => ({})],
  [/^welcome$/, welcome, () => ({})],
  [/^friends$/, friends, () => ({})],
  [/^chat\/([\w-]+)$/, chat, (m) => ({ friendId: m[1] })],
];
let cleanup = null;

async function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  hideMenu();
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.scrollTop = 0;
  const hit = routes.find(([re]) => re.test(path));
  if (!hit) { location.hash = "#/"; return; }
  const [re, mod, params] = hit;
  const key = mod === home ? "home" : mod === library ? "library" : mod === vocab ? "vocab" : mod === search ? "search"
    : mod === settingsPage ? "settings" : mod === friends || mod === chat ? "friends" : "";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
  document.body.classList.toggle("in-player", mod === player || mod === chat);
  try {
    cleanup = (await mod.render(view, { ...params(path.match(re)), query: new URLSearchParams(qs || "") })) || null;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="page"><div class="card"><h2>Something went wrong</h2><p class="muted"></p></div></div>`;
    view.querySelector("p").textContent = e.message;
  }
}

// ---------- boot ----------
async function boot() {
  await loadSettings();
  await loadLibrary();
  applySettings(settings);
  if (!settings.welcome_seen) location.hash = "#/welcome";
  window.addEventListener("hashchange", route);
  route();
  startBadge();

  // Sync on start, when returning to the app, and every 5 minutes while open.
  let lastDone = new Set(lib.episodes.filter((e) => e.transcript_rev).map((e) => e.uid));
  onSync((s) => {
    emit("sync", s);
    if (s.state !== "idle") return;
    emit("feeds", { synced: true });
    const done = lib.episodes.filter((e) => e.transcript_rev);
    const fresh = done.filter((e) => !lastDone.has(e.uid));
    if (fresh.length) toast(fresh.length === 1 ? `New transcript: ${fresh[0].title}` : `${fresh.length} new transcripts`);
    lastDone = new Set(done.map((e) => e.uid));
  });
  syncNow();
  setInterval(() => syncNow(), 5 * 60 * 1000);
  // Sign-in tokens last an hour: keep the video streamer's copy fresh during long videos.
  setInterval(refreshMediaToken, 40 * 60 * 1000);
  if (App) {
    App.addListener("resume", () => syncNow());
    App.addListener("backButton", () => {
      if (location.hash && location.hash !== "#/") history.back();
      else App.exitApp();
    });
  }
  // Development preview in a normal browser: load a library snapshot exported from the desktop.
  if (!isNative && new URLSearchParams(location.search).has("seed") && !(await kv.get("library"))) {
    const { seedFrom } = await import("./dev-seed.js");
    await seedFrom("dev-seed.json");
    route();
  }
}

boot();

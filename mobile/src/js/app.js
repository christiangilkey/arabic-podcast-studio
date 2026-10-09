// Phone app shell. Same exports as the desktop's web/js/app.js, so the shared screens
// (library, player, vocab, search) import from "../app.js" and work unchanged.

import * as library from "./pages/library.js";
import * as player from "./pages/player.js";
import * as vocab from "./pages/vocab.js";
import * as search from "./pages/search.js";
import * as settingsPage from "./pages/settings.js";
import * as welcome from "./pages/welcome.js";
import { handle } from "./backend.js";
import { App, Filesystem, Share, isNative } from "./native.js";
import { kv, lib, loadLibrary, loadSettings, saveSettingsPatch, settings } from "./store.js";
import { audioCopy, onSync, syncNow } from "./sync.js";
import { toSrt, toTxt, toVtt, vocabAnki, vocabCsv } from "./shared-logic.js";

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

// ---------- exports (share sheet) ----------
async function exportText(url) {
  let m;
  if ((m = url.match(/\/api\/episodes\/(\w+)\/export\/(txt|srt|vtt)$/))) {
    const t = await api(`/episodes/${m[1]}/transcript`);
    const segs = t.segments;
    return m[2] === "txt" ? toTxt(segs, t.episode.title) : m[2] === "srt" ? toSrt(segs) : toVtt(segs);
  }
  if ((m = url.match(/\/api\/vocab\/export\/(csv|anki)$/))) {
    const items = lib.vocab.filter((v) => !v.deleted).sort((a, b) => b.created_at - a.created_at);
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
  [/^$/, library, () => ({})],
  [/^feed\/(\w+)$/, library, (m) => ({ feedId: m[1] })],
  [/^episode\/(\w+)$/, player, (m) => ({ id: m[1] })],
  [/^vocab$/, vocab, () => ({})],
  [/^search$/, search, () => ({})],
  [/^settings$/, settingsPage, () => ({})],
  [/^welcome$/, welcome, () => ({})],
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
  const key = mod === library ? "library" : mod === vocab ? "vocab" : mod === search ? "search" : mod === settingsPage ? "settings" : "";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
  document.body.classList.toggle("in-player", mod === player);
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

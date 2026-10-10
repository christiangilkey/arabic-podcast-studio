// App shell: API client, live events (SSE), router, toasts, theme, downloads.

import * as library from "./pages/library.js";
import * as player from "./pages/player.js";
import * as vocab from "./pages/vocab.js";
import * as search from "./pages/search.js";
import * as settings from "./pages/settings.js";
import * as about from "./pages/about.js";
import * as welcome from "./pages/welcome.js";
import * as friends from "./pages/friends.js";
import * as chat from "./pages/chat.js";
import { startBadge } from "./social.js";

// ---------- API ----------
export async function api(path, { method = "GET", body, raw } = {}) {
  const opts = { method, headers: {} };
  if (raw !== undefined) {
    opts.body = raw;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (e) {
    throw new Error("Lost connection to the app's local server.");
  }
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    let detail = data && data.detail ? data.detail : data;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg).join("; ");
    throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status})`);
  }
  return data;
}

// ---------- helpers ----------
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

// ---------- events (SSE) ----------
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
function emit(event, data) {
  for (const fn of listeners.get(event) || []) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}
function connectEvents() {
  const es = new EventSource("/api/events");
  for (const name of ["episode", "feeds", "model_download", "gpu_pack", "sync"]) {
    es.addEventListener(name, (e) => emit(name, JSON.parse(e.data)));
  }
  es.onopen = () => emit("reconnected", {});
}

// ---------- toasts & notifications ----------
export function toast(message, { error = false, action, timeout = 5000 } = {}) {
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

export function requestNotifications() {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch { /* unsupported */ }
}

function notify(title, body, url) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, icon: "/icons/icon-256.png" });
      n.onclick = () => { window.focus(); location.hash = url; };
    }
  } catch { /* unsupported in this webview */ }
}

on("episode", (e) => {
  if (e.status === "done" && e.title) {
    toast(`Transcription finished: ${e.title}`, { action: { label: "Open", run: () => (location.hash = `#/episode/${e.id}`) } });
    notify("Transcription finished", e.title, `#/episode/${e.id}`);
  } else if (e.status === "failed" && e.title) {
    toast(`Transcription failed: ${e.title}. ${e.error || ""}`, { error: true });
    notify("Transcription failed", e.title, `#/`);
  }
});

// ---------- platform hooks (the Android app's shell provides its own versions) ----------
export const platform = "desktop";

/** URL the <audio> (or <video>) element should play for an episode. */
export async function audioUrl(episodeId) {
  return `/api/episodes/${episodeId}/audio`;
}

/** Google ID token for the online features (the desktop gets it from its Drive sign-in). */
export async function googleIdToken() {
  const r = await api("/sync/id-token", { method: "POST" });
  return { token: r.token };
}

/** Download a web page for "Add a webpage": {url, html}. The desktop's server fetches it. */
export async function fetchPage(url) {
  return api(`/web/fetch?url=${encodeURIComponent(url)}`);
}

/** Open the in-app web browser (a second window with an "Import Page" button). */
export async function openBrowser(url = "") {
  const bridge = window.pywebview && window.pywebview.api;
  if (bridge && bridge.open_browser) {
    const r = await bridge.open_browser(url);
    if (r && r.error) throw new Error(r.error);
    return;
  }
  // Running in an ordinary browser (development mode): there is no second window to control.
  window.open(url && /^https?:/i.test(url) ? url : "https://www.google.com", "_blank", "noopener");
  toast("Copy the address of the page you want and paste it under “Add a webpage”.");
}

/** Add one of the user's own video files. Resolves to the new episode. */
export function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/videos?filename=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status < 300) resolve(data);
      else reject(new Error((data && data.detail) || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: the app's server didn't respond."));
    xhr.send(file);
  });
}

// ---------- downloads ----------
export async function download(url, filename) {
  const bridge = window.pywebview && window.pywebview.api;
  if (bridge && bridge.save_file) {
    const r = await bridge.save_file(url, filename);
    if (r && r.ok) toast(`Saved to ${r.path}`);
    else if (r && r.error) toast(r.error, { error: true });
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- status, theme, settings ----------
export const state = { status: null };

export async function loadStatus() {
  state.status = await api("/status");
  applySettings(state.status.settings);
  const banner = document.getElementById("banner");
  banner.hidden = state.status.ffmpeg_ok;
  if (!state.status.ffmpeg_ok) banner.textContent = state.status.ffmpeg_message;
  return state.status;
}

export function applySettings(s) {
  const root = document.documentElement;
  if (s.theme === "light" || s.theme === "dark") root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  root.style.setProperty("--ar-size", `${s.font_size || 26}px`);
  if (state.status) state.status.settings = s;
}

export async function saveSettings(values) {
  const s = await api("/settings", { method: "PATCH", body: values });
  applySettings(s);
  return s;
}

// ---------- router ----------
const routes = [
  [/^$/, library, () => ({})],
  [/^feed\/(\d+)$/, library, (m) => ({ feedId: Number(m[1]) })],
  [/^episode\/(\d+)$/, player, (m) => ({ id: Number(m[1]) })],
  [/^vocab$/, vocab, () => ({})],
  [/^search$/, search, () => ({})],
  [/^settings$/, settings, () => ({})],
  [/^about$/, about, () => ({})],
  [/^friends$/, friends, () => ({})],
  [/^chat\/([\w-]+)$/, chat, (m) => ({ friendId: m[1] })],
  [/^welcome$/, welcome, () => ({ step: "welcome" })],
  [/^setup$/, welcome, () => ({ step: "setup" })],
];

let cleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  return { path, query: new URLSearchParams(qs || "") };
}

async function route() {
  const { path, query } = parseHash();
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  hideMenu();
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.scrollTop = 0;
  let match = null;
  for (const [re, mod, params] of routes) {
    const m = path.match(re);
    if (m) { match = [mod, { ...params(m), query }]; break; }
  }
  if (!match) { location.hash = "#/"; return; }
  const [mod, params] = match;
  const navKey = mod === library ? "library" : mod === vocab ? "vocab" : mod === settings ? "settings"
    : mod === about ? "about" : mod === friends || mod === chat ? "friends" : "";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
  try {
    cleanup = (await mod.render(view, params)) || null;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="page"><div class="card"><h2>Something went wrong</h2><p class="muted"></p></div></div>`;
    view.querySelector("p").textContent = e.message;
  }
}

// ---------- context menu ----------
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
  menu.querySelector("button")?.focus({ preventScroll: true });
}
export function hideMenu() {
  document.getElementById("ctxmenu").hidden = true;
}
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#ctxmenu")) hideMenu();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });
window.addEventListener("blur", hideMenu);

// ---------- boot ----------
document.getElementById("global-search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get("q").trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

async function boot() {
  connectEvents();
  try {
    const s = await loadStatus();
    if (!s.settings.welcome_seen) {
      if (!location.hash.startsWith("#/welcome") && !location.hash.startsWith("#/setup")) location.hash = "#/welcome";
    } else if (!s.model_ready && !location.hash.startsWith("#/settings") && !location.hash.startsWith("#/about")) {
      location.hash = "#/setup";
    }
  } catch (e) {
    toast(e.message, { error: true });
  }
  window.addEventListener("hashchange", route);
  route();
  startBadge();
}

boot();

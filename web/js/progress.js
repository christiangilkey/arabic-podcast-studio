// Remembers how far you got in each podcast, video and web page on this device, so the Home
// screen can offer "Continue".
//
// The rules for what counts as unfinished:
//   - a podcast or video you've started with MORE than 3 minutes left;
//   - a web page you've opened and scrolled LESS than 70% of the way through.

const KEY = "progress";
const MAX_ITEMS = 40;
export const MIN_LEFT_SECONDS = 180;
export const PAGE_DONE_FRACTION = 0.7;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function store(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/**
 * Record progress. `entry`: {id, kind: "audio" | "video" | "page", title, sub, image,
 * pos, dur} for audio/video (seconds) or {frac} for pages (0..1, furthest point seen).
 */
export function saveProgress(entry) {
  if (entry == null || entry.id == null) return;
  const all = load();
  const key = String(entry.id);
  const prev = all[key] || {};
  const next = { ...prev, ...entry, id: entry.id, ts: Date.now() };
  // A page's progress is the furthest you've read, even if you scroll back up.
  if (entry.kind === "page") next.frac = Math.max(prev.frac || 0, entry.frac || 0);
  all[key] = next;
  const keys = Object.keys(all);
  if (keys.length > MAX_ITEMS) {
    keys.sort((a, b) => all[a].ts - all[b].ts).slice(0, keys.length - MAX_ITEMS).forEach((k) => delete all[k]);
  }
  store(all);
}

export function forgetProgress(id) {
  const all = load();
  delete all[String(id)];
  store(all);
}

/** True when an item is unfinished by the rules above. */
export function isUnfinished(item) {
  if (!item) return false;
  if (item.kind === "page") return (item.frac || 0) < PAGE_DONE_FRACTION;
  const dur = item.dur || 0;
  const pos = item.pos || 0;
  return dur > 0 && pos > 2 && dur - pos > MIN_LEFT_SECONDS;
}

/** Unfinished items, most recently used first. */
export function continueItems() {
  return Object.values(load()).filter(isUnfinished).sort((a, b) => b.ts - a.ts);
}

/** Short description of what's left, e.g. "24 min left" or "35% read". */
export function leftLabel(item) {
  if (item.kind === "page") return `${Math.round((item.frac || 0) * 100)}% read`;
  const left = Math.max(0, (item.dur || 0) - (item.pos || 0));
  const min = Math.round(left / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min left` : `${min} min left`;
}

/** How far through, 0..1, for a progress bar. */
export function fraction(item) {
  if (item.kind === "page") return Math.min(1, item.frac || 0);
  return item.dur ? Math.min(1, (item.pos || 0) / item.dur) : 0;
}

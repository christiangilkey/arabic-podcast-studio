// JavaScript ports of desktop logic that must give identical results on both platforms:
// global ids (app/ids.py), Arabic search normalization (app/arabic.py), feed URL cleanup
// (app/feeds.py) and transcript/vocab exports (app/exporters.py).

// ---------- ids ----------
async function sha1Hex(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function feedUid(url) {
  return "f" + (await sha1Hex(url.trim().toLowerCase())).slice(0, 20);
}
export function newUid() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "v" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeUrl(url) {
  url = url.trim();
  if (url.startsWith("feed://")) return "https://" + url.slice(7);
  if (/^(itpc|pcast):\/\//i.test(url)) return "https://" + url.split("://")[1];
  if (!/^https?:\/\//i.test(url)) return "https://" + url;
  return url;
}

// ---------- Arabic normalization ----------
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ࣓-ࣿ]/g;
const MAP = {
  "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا", "ٲ": "ا", "ٳ": "ا",
  "ة": "ه", "ى": "ي", "ؤ": "و", "ئ": "ي", "ـ": "",
};
const mapChars = (s) => s.replace(/[آأإٱٲٳةىؤئـ]/g, (c) => MAP[c]);

export function normalize(text) {
  return mapChars(String(text || "").replace(DIACRITICS, "")).replace(/\s+/g, " ").trim().toLowerCase();
}

/** [start, end] offsets of `query` in the original (diacritized) text, using normalized matching. */
export function findSpans(original, query) {
  const q = normalize(query);
  if (!q) return [];
  const chars = [];
  const index = [];
  let prevSpace = true;
  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) { chars.push(" "); index.push(i); }
      prevSpace = true;
      continue;
    }
    const mapped = mapChars(ch.replace(DIACRITICS, "")).toLowerCase();
    for (const m of mapped) { chars.push(m); index.push(i); }
    if (mapped) prevSpace = false;
  }
  const norm = chars.join("");
  const spans = [];
  let pos = norm.indexOf(q);
  while (pos !== -1) {
    const start = index[pos];
    let end = index[pos + q.length - 1] + 1;
    while (end < original.length && !original[end].replace(DIACRITICS, "") && !/\s/.test(original[end])) end++;
    spans.push([start, end]);
    pos = norm.indexOf(q, pos + q.length);
  }
  return spans;
}

// ---------- exports ----------
const RLM = "‏";
function ts(sec, sep) {
  let ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000); ms -= m * 60_000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}
export const toTxt = (segs, title) => [...(title ? [title, ""] : []), ...segs.map((s) => s.text)].join("\n") + "\n";
export const toSrt = (segs) =>
  segs.map((s, i) => `${i + 1}\n${ts(s.start, ",")} --> ${ts(s.end, ",")}\n${RLM}${s.text}\n`).join("\n");
export const toVtt = (segs) =>
  ["WEBVTT", "", ...segs.map((s) => `${ts(s.start, ".")} --> ${ts(s.end, ".")}\n${RLM}${s.text}\n`)].join("\n");

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function vocabCsv(items) {
  const rows = [["Word/Phrase", "Meaning", "Notes", "Sentence", "Episode", "Start (s)", "End (s)"]];
  for (const v of items) {
    rows.push([v.text, v.meaning, v.notes, v.sentence, v.episode_title,
      v.start != null ? v.start.toFixed(2) : "", v.end != null ? v.end.toFixed(2) : ""]);
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c]));
export function vocabAnki(items) {
  const lines = ["#separator:tab", "#html:true", "#columns:Front\tBack\tSentence\tSource\tTags", "#tags column:5"];
  const field = (t) => t.replace(/\t/g, " ").replace(/\r/g, "").replace(/\n/g, "<br>");
  for (const v of items) {
    const word = escHtml(v.text);
    let sentence = escHtml(v.sentence || "");
    if (word && sentence.includes(word)) sentence = sentence.replace(word, `<b>${word}</b>`);
    let back = escHtml(v.meaning || "");
    if (v.notes) back += (back ? "<br><br>" : "") + `<i>${escHtml(v.notes)}</i>`;
    let source = escHtml(v.episode_title || "");
    if (v.start != null) source += ` @ ${ts(v.start, ",").slice(0, 8)}`;
    lines.push([`<div dir="rtl" style="font-size:2em">${word}</div>`, back,
      sentence ? `<div dir="rtl">${sentence}</div>` : "", source, "arabic-podcast"].map(field).join("\t"));
  }
  return lines.join("\n") + "\n";
}

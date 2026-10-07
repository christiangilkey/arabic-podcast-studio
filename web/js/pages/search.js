// Full-text search across all transcripts.

import { api, esc, h } from "../app.js";
import { formatTime } from "../wordlookup.js";

function withSpans(text, spans) {
  let out = "";
  let pos = 0;
  for (const [a, b] of spans) {
    out += esc(text.slice(pos, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(text.slice(pos));
}

export async function render(view, { query }) {
  const q = query.get("q") || "";
  const input = document.querySelector("#global-search input");
  if (input) input.value = q;
  view.append(h(`<div class="page">
    <h1>Search</h1>
    <p class="muted small">Matches ignore diacritics (tashkeel) and spelling variants of alef (أ إ آ ا), taa marbuta/haa (ة ه) and alef maqsura/yaa (ى ي). Transcripts are always shown exactly as transcribed.</p>
    <div id="results" class="results"></div>
  </div>`));
  const box = view.querySelector("#results");
  if (!q) { box.append(h(`<div class="empty">Type in the search box above.</div>`)); return; }
  const data = await api(`/search?q=${encodeURIComponent(q)}`);
  if (!data.results.length) {
    box.append(h(`<div class="empty">No matches for “${esc(q)}”.</div>`));
    return;
  }
  box.append(h(`<p class="muted">${data.total} match${data.total === 1 ? "" : "es"}${data.total > data.results.length ? ` (showing ${data.results.length})` : ""}</p>`));
  const groups = new Map();
  for (const r of data.results) {
    if (!groups.has(r.episode_id)) groups.set(r.episode_id, []);
    groups.get(r.episode_id).push(r);
  }
  for (const [epId, hits] of groups) {
    const g = h(`<div class="ep-group card">
      <div style="margin-bottom:6px"><strong dir="auto">${esc(hits[0].episode_title)}</strong>
      <span class="small muted"> · ${esc(hits[0].feed_title)}</span></div></div>`);
    for (const r of hits) {
      g.append(h(`<a class="hit" href="#/episode/${epId}?t=${r.start}">
        <span class="t">${formatTime(r.start)}</span>
        <span class="ar" dir="rtl" lang="ar">${withSpans(r.text, r.spans)}</span></a>`));
    }
    box.append(g);
  }
}

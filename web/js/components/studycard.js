// "What I'm studying" cards on the Friends tab: a podcast episode, a YouTube video or a Spotify
// song, plus a short personal note. `studyCard` shows one; `studyEditor` edits your own.
// Everything a friend typed is inserted as plain text, and only https links are ever used.

import { api, esc, h, toast } from "../app.js";
import * as social from "../social.js";

const KINDS = { podcast: "🎧 Podcast", youtube: "▶ YouTube", spotify: "♫ Spotify" };

function feedUrl(text) {
  try {
    const u = new URL(String(text || ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

/** Element showing a status {studying, message}, or null when there's nothing to show. */
export function studyCard(status, { own = false } = {}) {
  const s = status && status.studying && KINDS[status.studying.kind] ? status.studying : null;
  const note = status && status.message ? String(status.message) : "";
  if (!s && !note) return null;
  const wrap = h(`<div class="study"></div>`);
  if (s) {
    const image = social.safeUrl(s.image);
    const card = h(`<div class="study-card">
      ${image ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
      <div class="study-text"><div class="study-kind small muted"></div><div class="study-title" dir="auto"></div>
        <div class="study-sub small muted" dir="auto"></div></div>
      <div class="study-actions"></div>
    </div>`);
    card.querySelector(".study-kind").textContent = `${own ? "You're" : "Is"} studying · ${KINDS[s.kind]}`;
    card.querySelector(".study-title").textContent = s.title || "";
    card.querySelector(".study-sub").textContent = s.subtitle || "";
    const actions = card.querySelector(".study-actions");
    const link = social.safeUrl(s.url);
    wrap.append(card);
    if (s.kind === "spotify" && social.spotifyEmbedUrl(link)) {
      const play = h(`<button type="button">▶ Play</button>`);
      let frame = null;
      play.onclick = () => {
        if (frame) { frame.remove(); frame = null; play.textContent = "▶ Play"; return; }
        frame = h(`<iframe class="spotify-frame" loading="lazy" allow="encrypted-media; clipboard-write" title="Spotify player"></iframe>`);
        frame.src = social.spotifyEmbedUrl(link);
        card.after(frame);
        play.textContent = "✕ Close";
      };
      actions.append(play);
    } else if (s.kind === "youtube" && link) {
      const open = h(`<a class="btn" target="_blank" rel="noopener">Watch ↗</a>`);
      open.href = link;
      actions.append(open);
    } else if (s.kind === "podcast" && !own && feedUrl(s.feed_url)) {
      const sub = h(`<button type="button" title="Add this podcast to your library">＋ Subscribe</button>`);
      sub.onclick = async () => {
        sub.disabled = true;
        try {
          const feed = await api("/feeds", { method: "POST", body: { url: feedUrl(s.feed_url) } });
          toast(`Subscribed to ${feed.title}.`, { action: { label: "Open", run: () => (location.hash = `#/feed/${feed.id}`) } });
        } catch (e) {
          toast(e.message, { error: true });
          sub.disabled = false;
        }
      };
      actions.append(sub);
    }
  }
  if (note) {
    const n = h(`<div class="study-note" dir="auto"></div>`);
    n.textContent = note;
    wrap.append(n);
  }
  return wrap;
}

/** Editor for your own card. Calls onSaved() after saving. */
export function studyEditor(current, onSaved) {
  let studying = current && current.studying && KINDS[current.studying.kind] ? current.studying : null;
  const el = h(`<div class="study-editor stack">
    <div id="se-preview"></div>
    <div class="row se-tabs">
      <span class="small muted">Show:</span>
      <button type="button" data-tab="podcast">🎧 Podcast episode</button>
      <button type="button" data-tab="link">▶ YouTube or ♫ Spotify link</button>
      <button type="button" class="ghost" data-tab="none">Nothing</button>
    </div>
    <div id="se-podcast" hidden class="stack">
      <input type="search" id="se-search" placeholder="Search your episodes by title…" autocomplete="off">
      <div id="se-results" class="se-results"></div>
    </div>
    <form id="se-link" hidden class="row">
      <input type="url" id="se-url" placeholder="Paste a YouTube or Spotify link" style="flex:1;min-width:200px" autocomplete="off">
      <button type="submit">Preview</button>
    </form>
    <label class="stack-label small muted">Your note (optional)
      <input type="text" id="se-note" maxlength="300" placeholder="e.g. Working on Levantine listening this month" dir="auto"></label>
    <div class="row"><button type="button" class="primary" id="se-save">Save</button>
      <span class="small muted">Only your friends see this, on their Friends tab.</span></div>
  </div>`);
  const $ = (q) => el.querySelector(q);
  $("#se-note").value = (current && current.message) || "";

  const paintPreview = () => {
    const box = $("#se-preview");
    box.innerHTML = "";
    const card = studyCard({ studying, message: "" }, { own: true });
    if (card) box.append(card);
  };
  const show = (tab) => {
    $("#se-podcast").hidden = tab !== "podcast";
    $("#se-link").hidden = tab !== "link";
    el.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "none") { studying = null; paintPreview(); }
    if (tab === "podcast") { $("#se-search").focus(); search(""); }
    if (tab === "link") $("#se-url").focus();
  };
  el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => show(b.dataset.tab)));

  async function search(q) {
    const box = $("#se-results");
    try {
      const data = await api(`/episodes?limit=8${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      box.innerHTML = "";
      const eps = data.items.filter((ep) => !(ep.feed_url || "").startsWith("local:"));
      if (!eps.length) box.append(h(`<div class="small muted">No episodes found.</div>`));
      for (const ep of eps) {
        const row = h(`<button type="button" class="se-result"><span class="t" dir="auto"></span><span class="small muted" dir="auto"></span></button>`);
        row.querySelector(".t").textContent = ep.title;
        row.querySelector(".muted").textContent = ep.feed_title || "";
        row.onclick = () => {
          studying = { kind: "podcast", title: String(ep.title || "").slice(0, 200), subtitle: String(ep.feed_title || "").slice(0, 120),
                       image: social.safeUrl(ep.image || ep.feed_image || ""), feed_url: feedUrl(ep.feed_url) };
          paintPreview();
          $("#se-podcast").hidden = true;
        };
        box.append(row);
      }
    } catch (e) {
      box.textContent = e.message;
    }
  }
  let timer;
  $("#se-search").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => search(e.target.value.trim()), 250); };

  $("#se-link").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      studying = await social.previewLink($("#se-url").value);
      paintPreview();
      $("#se-link").hidden = true;
      $("#se-url").value = "";
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
    }
  };

  $("#se-save").onclick = async (e) => {
    e.target.disabled = true;
    try {
      await social.setStatus({ studying, message: $("#se-note").value });
      toast("Saved. Your friends will see it on their Friends tab.");
      if (onSaved) onSaved();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      e.target.disabled = false;
    }
  };

  paintPreview();
  return el;
}

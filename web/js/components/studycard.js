// "What I'm studying" cards on the Friends tab: up to three things (a podcast episode, a
// YouTube video, a Spotify or Apple Music song, an IMDb film or series) plus a short personal
// note. `studyCard` shows a card; `studyEditor` edits your own.
// Everything a friend typed is inserted as plain text, and only https links are ever used.

import { api, esc, h, toast } from "../app.js";
import * as social from "../social.js";

const KINDS = { podcast: "🎧 Podcast", youtube: "▶ YouTube", spotify: "♫ Spotify", apple: "♪ Apple Music", imdb: "🎬 IMDb" };

function feedUrl(text) {
  try {
    const u = new URL(String(text || ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

/** One item's card (picture, title, and the action that fits its kind). */
function itemCard(s, { own = false } = {}) {
  const image = social.safeUrl(s.image);
  const wrap = h(`<div class="study-item"></div>`);
  const card = h(`<div class="study-card${s.kind === "imdb" ? " poster" : ""}">
    ${image ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
    <div class="study-text"><div class="study-kind small muted"></div><div class="study-title" dir="auto"></div>
      <div class="study-sub small muted" dir="auto"></div></div>
    <div class="study-actions"></div>
  </div>`);
  card.querySelector(".study-kind").textContent = KINDS[s.kind];
  card.querySelector(".study-title").textContent = s.title || "";
  card.querySelector(".study-sub").textContent = s.subtitle || "";
  const actions = card.querySelector(".study-actions");
  const link = social.safeUrl(s.url);
  wrap.append(card);
  const embed = s.kind === "spotify" ? social.spotifyEmbedUrl(link) : s.kind === "apple" ? social.appleEmbedUrl(link) : "";
  if (embed) {
    const play = h(`<button type="button">▶ Play</button>`);
    let frame = null;
    play.onclick = () => {
      if (frame) { frame.remove(); frame = null; play.textContent = "▶ Play"; return; }
      frame = h(`<iframe class="music-frame ${s.kind}" loading="lazy" allow="autoplay *; encrypted-media *; clipboard-write" title="Music player"></iframe>`);
      frame.src = embed;
      card.after(frame);
      play.textContent = "✕ Close";
    };
    actions.append(play);
  } else if ((s.kind === "youtube" || s.kind === "imdb" || s.kind === "apple" || s.kind === "spotify") && link) {
    const open = h(`<a class="btn" target="_blank" rel="noopener"></a>`);
    open.textContent = s.kind === "youtube" ? "Watch ↗" : "Open ↗";
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
  return wrap;
}

/** Element showing a status {studying, message}, or null when there's nothing to show. */
export function studyCard(status, { own = false } = {}) {
  const items = social.studyItems(status && status.studying).filter((s) => KINDS[s.kind]);
  const note = status && status.message ? String(status.message) : "";
  if (!items.length && !note) return null;
  const wrap = h(`<div class="study"></div>`);
  if (items.length) {
    const label = h(`<div class="study-label small muted"></div>`);
    label.textContent = own ? "You're studying" : "Is studying";
    wrap.append(label);
    for (const s of items) wrap.append(itemCard(s, { own }));
  }
  if (note) {
    const n = h(`<div class="study-note" dir="auto"></div>`);
    n.textContent = note;
    wrap.append(n);
  }
  return wrap;
}

/** Editor for your own card: three link bars, a note, and a guide to what can be pasted.
 * Calls onSaved() after saving. Empty bars are simply left out of the card. */
export function studyEditor(current, onSaved) {
  const items = social.studyItems(current && current.studying).filter((s) => KINDS[s.kind]);
  const slots = Array.from({ length: social.MAX_STUDY_ITEMS }, (_, i) => items[i] || null);

  const el = h(`<div class="study-editor stack">
    <div class="row">
      <span class="small muted">Add up to ${social.MAX_STUDY_ITEMS} things. Leave a bar empty and it isn't shown.</span>
      <span class="spacer"></span>
      <button type="button" class="ghost small-btn" id="se-help-btn" aria-expanded="false">ⓘ What can I paste?</button>
    </div>
    <div class="se-help card" id="se-help" hidden>
      <strong>Links that work here</strong>
      <ul>${social.LINK_TYPES.map(([name, what, example]) =>
        `<li><strong>${esc(name)}</strong>: ${esc(what)}${example ? `<br><span class="small muted">${esc(example)}</span>` : ""}</li>`).join("")}</ul>
      <p class="small muted">Paste a link into a bar and its title and picture appear. Nothing else is read from the link.</p>
    </div>
    <div id="se-slots" class="stack"></div>
    <label class="stack-label small muted">Your note (optional)
      <input type="text" id="se-note" maxlength="300" placeholder="e.g. Working on Levantine listening this month" dir="auto"></label>
    <div class="row" id="se-buttons"><button type="button" class="primary" id="se-save">Save</button>
      <span class="small muted">Only your friends see this, on their Friends tab.</span></div>
  </div>`);
  const $ = (q) => el.querySelector(q);
  $("#se-note").value = (current && current.message) || "";
  $("#se-help-btn").onclick = (e) => {
    const box = $("#se-help");
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!box.hidden));
  };

  function paintSlot(i) {
    const box = $("#se-slots").children[i];
    box.innerHTML = "";
    const item = slots[i];
    if (item) {
      const row = h(`<div class="se-filled"></div>`);
      row.append(itemCard(item, { own: true }));
      const clear = h(`<button type="button" class="ghost" title="Remove this one">✕</button>`);
      clear.onclick = () => { slots[i] = null; paintSlot(i); };
      row.append(clear);
      box.append(row);
      return;
    }
    const bar = h(`<form class="se-bar row">
      <span class="se-num small muted">${i + 1}</span>
      <input type="url" placeholder="Paste a YouTube, Spotify, Apple Music or IMDb link" autocomplete="off" style="flex:1;min-width:160px">
      <button type="submit">Add</button>
      <button type="button" class="ghost se-pod" title="Pick a podcast episode from your library">🎧</button>
    </form>
    `);
    const input = bar.querySelector("input");
    const add = async () => {
      const text = input.value.trim();
      if (!text) return;
      const btn = bar.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "…";
      try {
        slots[i] = await social.previewLink(text);
        paintSlot(i);
      } catch (err) {
        toast(err.message, { error: true });
        btn.disabled = false;
        btn.textContent = "Add";
      }
    };
    bar.onsubmit = (e) => { e.preventDefault(); add(); };
    input.addEventListener("paste", () => setTimeout(add, 0));
    box.append(bar);

    // Podcast picker (opens under the bar).
    const picker = h(`<div class="stack" hidden>
      <input type="search" placeholder="Search your episodes by title…" autocomplete="off">
      <div class="se-results"></div></div>`);
    const results = picker.querySelector(".se-results");
    async function search(q) {
      try {
        const data = await api(`/episodes?limit=8${q ? `&q=${encodeURIComponent(q)}` : ""}`);
        results.innerHTML = "";
        const eps = data.items.filter((ep) => !(ep.feed_url || "").startsWith("local:"));
        if (!eps.length) results.append(h(`<div class="small muted">No episodes found.</div>`));
        for (const ep of eps) {
          const row = h(`<button type="button" class="se-result"><span class="t" dir="auto"></span><span class="small muted" dir="auto"></span></button>`);
          row.querySelector(".t").textContent = ep.title;
          row.querySelector(".muted").textContent = ep.feed_title || "";
          row.onclick = () => {
            slots[i] = { kind: "podcast", title: String(ep.title || "").slice(0, 200), subtitle: String(ep.feed_title || "").slice(0, 120),
                         image: social.safeUrl(ep.image || ep.feed_image || ""), feed_url: feedUrl(ep.feed_url) };
            paintSlot(i);
          };
          results.append(row);
        }
      } catch (e) {
        results.textContent = e.message;
      }
    }
    let timer;
    picker.querySelector("input").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => search(e.target.value.trim()), 250); };
    bar.querySelector(".se-pod").onclick = () => {
      picker.hidden = !picker.hidden;
      if (!picker.hidden) { picker.querySelector("input").focus(); search(""); }
    };
    box.append(picker);
  }
  for (let i = 0; i < slots.length; i++) {
    $("#se-slots").append(h(`<div class="se-slot"></div>`));
    paintSlot(i);
  }

  $("#se-save").onclick = async (e) => {
    e.target.disabled = true;
    try {
      // A link typed but not yet added still counts.
      for (let i = 0; i < slots.length; i++) {
        const pending = $("#se-slots").children[i].querySelector(".se-bar input");
        if (!slots[i] && pending && pending.value.trim()) slots[i] = await social.previewLink(pending.value);
      }
      await social.setStatus({ studying: slots.filter(Boolean), message: $("#se-note").value });
      toast("Saved. Your friends will see it on their Friends tab.");
      if (onSaved) onSaved();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      e.target.disabled = false;
    }
  };

  return el;
}

// Definition bubble shown when a word is clicked/tapped. Platform-independent: the caller
// supplies the definition fetcher and the audio/vocab actions.

import { esc } from "../app.js";

/**
 * @param {HTMLElement} host positioned (relative) container the bubble lives in
 * @param {{
 *   fetch: (ctx: object, refresh?: boolean) => Promise<object>,
 *   onPlayWord: () => void, onPlaySentence: () => void, onPlayFrom: () => void,
 *   onSave: (def: object|null) => Promise<void>, onSettings: () => void,
 *   noAudio?: boolean,   // true for imported web pages: hides the play buttons
 * }} actions
 */
export function createWordBubble(host, actions) {
  const el = document.createElement("div");
  el.className = "word-bubble";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  host.append(el);

  let anchor = null;
  let ctx = null;
  let def = null;
  let token = 0;
  let saved = false;

  function position() {
    if (el.hidden || !anchor) return;
    if (window.matchMedia("(max-width: 640px)").matches) {
      el.classList.add("sheet");
      el.style.left = el.style.top = "";
      return;
    }
    el.classList.remove("sheet");
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    let left = ar.left + ar.width / 2 - hr.left - bw / 2;
    left = Math.max(8, Math.min(left, hr.width - bw - 8));
    const below = ar.bottom - hr.top + 8;
    const above = ar.top - hr.top - bh - 8;
    const top = below + bh <= hr.height - 8 || above < 8 ? below : above;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, top)}px`;
    // Hide while the anchor word is scrolled out of view.
    el.style.visibility = ar.bottom < hr.top || ar.top > hr.bottom ? "hidden" : "";
  }

  function chips(d) {
    const items = [];
    if (d.pos) items.push(esc(d.pos));
    if (d.root) items.push(`root <span class="ar" dir="rtl">${esc(d.root)}</span>`);
    if (d.dialect) items.push(esc(d.dialect));
    return items.map((c) => `<span class="wb-chip">${c}</span>`).join("");
  }

  let current = { state: "loading", message: "" };

  function render(state, message = "") {
    current = { state, message };
    const word = ctx.word;
    let body = "";
    if (state === "loading") {
      body = `<div class="wb-loading"><span class="spinner"></span> Looking up in context…</div>`;
    } else if (state === "nokey") {
      body = `<p class="wb-muted">See what this word means in this sentence: add an AI provider key in Settings.</p>
              <button type="button" class="primary" data-act="settings">Set up definitions</button>`;
    } else if (state === "error") {
      body = `<p class="wb-error">${esc(message)}</p>
              <div class="row"><button type="button" data-act="retry">Try again</button>
              <button type="button" class="ghost" data-act="settings">Settings</button></div>`;
    } else {
      const d = def;
      body = `
        <div class="wb-meaning">${esc(d.meaning)}</div>
        ${d.explanation ? `<p class="wb-expl">${esc(d.explanation)}</p>` : ""}
        <div class="wb-chips">${chips(d)}</div>
        ${d.lemma && d.lemma !== d.vocalized ? `<div class="wb-row"><span class="wb-label">Dictionary form</span> <span class="ar" dir="rtl">${esc(d.lemma)}</span></div>` : ""}
        ${d.morphology ? `<div class="wb-row"><span class="wb-label">Form</span> ${esc(d.morphology)}</div>` : ""}
        ${d.other_meanings.length ? `<div class="wb-row"><span class="wb-label">Also</span> ${d.other_meanings.map(esc).join("; ")}</div>` : ""}
        ${d.msa_equivalent ? `<div class="wb-row"><span class="wb-label">In MSA</span> <span class="ar" dir="rtl">${esc(d.msa_equivalent)}</span></div>` : ""}
        ${d.dialect_note ? `<div class="wb-row"><span class="wb-label">Dialect</span> ${esc(d.dialect_note)}</div>` : ""}
        ${d.sentence_translation ? `<details class="wb-trans"><summary>Sentence translation</summary>${esc(d.sentence_translation)}</details>` : ""}`;
    }
    const shown = def && state === "ready" && def.vocalized ? def.vocalized : word;
    el.innerHTML = `
      <div class="wb-head">
        <div class="wb-word ar" dir="rtl" lang="ar">${esc(shown)}</div>
        <button type="button" class="ghost icon wb-close" data-act="close" title="Close (Esc)">✕</button>
      </div>
      <div class="wb-body">${body}</div>
      <div class="wb-actions">
        ${actions.noAudio ? "" : `<button type="button" data-act="word" title="Play this word again">🔊 Word</button>
        <button type="button" data-act="sentence" title="Play the whole sentence">🔊 Sentence</button>
        <button type="button" data-act="from" title="Continue playing from here">▶ Continue</button>`}
        <button type="button" class="${saved ? "" : "primary"}" data-act="save" ${saved ? "disabled" : ""}>${saved ? "✓ Saved" : "★ Save"}</button>
        ${state === "ready" ? `<button type="button" class="ghost icon" data-act="refresh" title="Ask again">↻</button>` : ""}
      </div>`;
    requestAnimationFrame(position);
  }

  async function load(refresh = false) {
    const my = ++token;
    render("loading");
    try {
      const d = await actions.fetch(ctx, refresh);
      if (my !== token) return;
      def = d;
      render("ready");
    } catch (e) {
      if (my !== token) return;
      if (e && e.message === "NO_KEY") render("nokey");
      else render("error", e && e.message ? e.message : String(e));
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    switch (b.dataset.act) {
      case "close": hide(); break;
      case "word": actions.onPlayWord(); break;
      case "sentence": actions.onPlaySentence(); break;
      case "from": actions.onPlayFrom(); hide(); break;
      case "settings": actions.onSettings(); break;
      case "retry": load(); break;
      case "refresh": def = null; load(true); break;
      case "save":
        // Works with or without a definition (no key, or the lookup failed).
        b.disabled = true;
        try {
          await actions.onSave(def);
          saved = true;
          render(current.state, current.message);
        } catch {
          b.disabled = false;
        }
        break;
    }
  });
  // Don't let clicks inside the bubble reach the transcript (which would seek).
  el.addEventListener("pointerdown", (e) => e.stopPropagation());

  function show(anchorEl, context) {
    anchor = anchorEl;
    ctx = context;
    def = null;
    saved = false;
    el.hidden = false;
    load();
  }

  function hide() {
    token++;
    el.hidden = true;
    anchor = null;
  }

  return { show, hide, position, get open() { return !el.hidden; }, el };
}

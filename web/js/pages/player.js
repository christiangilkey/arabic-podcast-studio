// Episode player: audio controls + RTL transcript with word-level highlighting.
//
// Performance: words are rendered once as <span>s. Each animation frame we binary-search
// the sorted start times (O(log n)) and only touch the DOM when the active word changes.

import { api, esc, h, on, toast, showMenu, hideMenu, download, saveSettings, state, requestNotifications, audioUrl } from "../app.js";
import { activeWordIndex, sentenceBounds, formatTime } from "../wordlookup.js";
import { statusInfo } from "./library.js";
import { createWordBubble } from "../components/wordbubble.js";
import { getDefinition } from "../define-service.js";
import { markWord } from "../definer.js";

const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const LONG_PRESS_MS = 550;
const EDGE_PUNCT = /^[\s«"'“(\[]+|[\s.,!?؟،؛:"'”»)\]…]+$/gu;

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied");
}

function renderPending(view, ep) {
  const panel = h(`<div class="page"><div class="card status-panel stack">
      <h1 dir="auto"></h1>
      <p class="muted" id="st"></p>
      <div class="progress" id="bar" hidden><i></i></div>
      <p class="err" id="err" style="color:var(--danger)"></p>
      <div class="row" style="justify-content:center"><button class="primary" id="go" type="button"></button>
      <a class="btn" href="#/">Back to library</a></div>
    </div></div>`);
  panel.querySelector("h1").textContent = ep.title;
  view.append(panel);
  const paint = () => {
    const st = statusInfo(ep);
    panel.querySelector("#st").textContent = st.label;
    panel.querySelector("#bar").hidden = st.bar === undefined;
    panel.querySelector("#bar i").style.width = `${st.bar || 0}%`;
    panel.querySelector("#err").textContent = ep.status === "failed" ? ep.error || "" : "";
    const go = panel.querySelector("#go");
    const busy = ["queued", "downloading", "transcribing"].includes(ep.status);
    go.hidden = busy;
    go.textContent = ep.status === "failed" ? "Retry" : "Transcribe";
  };
  panel.querySelector("#go").onclick = async () => {
    requestNotifications();
    try { await api("/episodes/transcribe", { method: "POST", body: { ids: [ep.id] } }); }
    catch (e) { toast(e.message, { error: true }); }
  };
  paint();
  return on("episode", (e) => {
    if (e.id !== ep.id) return;
    Object.assign(ep, e);
    if (e.status === "done") window.dispatchEvent(new HashChangeEvent("hashchange"));
    else paint();
  });
}

export async function render(view, { id, query }) {
  const data = await api(`/episodes/${id}/transcript`);
  const ep = data.episode;
  if (ep.status !== "done" || !data.words.start.length) return renderPending(view, ep);

  const W = data.words;
  const n = W.start.length;
  const starts = Float64Array.from(W.start);
  const ends = Float64Array.from(W.end);
  const segOf = Int32Array.from(W.seg);
  const texts = W.text;

  // ---------- markup ----------
  const img = ep.image || ep.feed_image;
  view.append(h(`
    <div class="player">
      <div class="player-head">
        <a class="btn ghost" href="#/feed/${ep.feed_id}" title="Back">←</a>
        ${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : ""}
        <div class="meta">
          <div class="title" dir="auto">${esc(ep.title)}</div>
          <div class="small muted">${esc(ep.feed_title)} · ${n.toLocaleString()} words</div>
        </div>
        <div class="row">
          <button type="button" class="ghost" id="font-down" title="Smaller text">A−</button>
          <button type="button" class="ghost" id="font-up" title="Larger text">A+</button>
          <button type="button" id="exp-txt">TXT</button>
          <button type="button" id="exp-srt">SRT</button>
          <button type="button" id="exp-vtt">VTT</button>
        </div>
      </div>
      <div class="transcript-wrap">
        <div class="transcript ar" id="transcript" lang="ar" dir="rtl" tabindex="0"></div>
        <button type="button" class="back-to-current primary" id="back" hidden>↓ Back to current</button>
      </div>
      <div class="controls">
        <div class="seekrow">
          <span id="cur">0:00</span>
          <input type="range" id="seek" min="0" max="1" step="0.1" value="0" aria-label="Seek">
          <span id="dur">0:00</span>
        </div>
        <div class="btnrow">
          <span id="loop-chip" class="chip" hidden>⟲ Looping sentence <button type="button" id="loop-off" title="Stop looping">✕</button></span>
          <button type="button" id="back5" title="Back 5 seconds (←)">⟲ 5s</button>
          <button type="button" id="play" class="play primary" title="Play/Pause (Space)">▶</button>
          <button type="button" id="fwd5" title="Forward 5 seconds (→)">5s ⟳</button>
          <select id="speed" title="Playback speed">${SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join("")}</select>
        </div>
      </div>
    </div>`));

  const $ = (sel) => view.querySelector(sel);
  const tr = $("#transcript");

  // Build transcript HTML in one pass (fast even for 10k+ words).
  const parts = [];
  let w = 0;
  for (const seg of data.segments) {
    parts.push(`<p class="seg" data-s="${seg.idx}" data-t="${formatTime(seg.start)}">`);
    const first = w;
    while (w < n && segOf[w] === seg.idx) {
      if (w > first) parts.push(" ");
      parts.push(`<span class="w" data-i="${w}">${esc(texts[w])}</span>`);
      w++;
    }
    if (w === first) parts.push(esc(seg.text));
    parts.push("</p>");
  }
  tr.innerHTML = parts.join("");
  const wordEls = tr.querySelectorAll(".w");

  // ---------- audio ----------
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = await audioUrl(id);
  window.__apsAudio = audio; // handy for debugging from the devtools console
  let speed = lsGet("speed", 1);
  $("#speed").value = String(speed);
  let duration = ep.duration || 0;
  const posKey = `pos:${id}`;
  const startAt = query.get("t") !== null ? Number(query.get("t")) : lsGet(posKey, 0);

  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) duration = audio.duration;
    $("#seek").max = String(duration);
    $("#dur").textContent = formatTime(duration);
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
    if (startAt > 0 && startAt < duration) audio.currentTime = startAt;
    tick();
  }, { once: true });
  audio.addEventListener("error", () => {
    if (disposed) return;
    toast("Couldn't load the audio. If it streams from the podcast's server, check your connection.", { error: true });
  });

  // ---------- highlight + follow ----------
  let curIdx = -1;
  let follow = true;
  let loop = null; // {start, end, first, last}
  let seeking = false;
  let lastSecond = -1;
  let raf = 0;

  function ensureVisible(el, force = false) {
    const cr = tr.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const topBand = cr.top + cr.height * 0.12;
    const bottomBand = cr.top + cr.height * 0.7;
    if (!force && r.top >= topBand && r.bottom <= bottomBand) return;
    const delta = r.top - cr.top - cr.height * 0.33;
    tr.scrollTo({ top: tr.scrollTop + delta, behavior: Math.abs(delta) > cr.height * 1.5 ? "auto" : "smooth" });
  }

  function setActive(idx) {
    if (idx === curIdx) return;
    if (curIdx >= 0) wordEls[curIdx].classList.remove("cur");
    curIdx = idx;
    if (idx >= 0) {
      wordEls[idx].classList.add("cur");
      if (follow) ensureVisible(wordEls[idx]);
    }
  }

  // update() does the per-frame work. It's driven by requestAnimationFrame while playing, and
  // also by the audio's own 'timeupdate' events (~4 Hz), which keep sentence loops and the
  // highlight correct even when the window is hidden and animation frames are paused.
  function tick() {
    raf = 0;
    update();
    if (!audio.paused) raf = requestAnimationFrame(tick);
  }

  let disposed = false;
  let clipEnd = null; // when set, playback pauses at this time (word/sentence preview)
  let clipTimer = 0;
  function update() {
    if (disposed) return;
    let t = audio.currentTime;
    if (clipEnd !== null && t >= clipEnd) {
      // End of a single-word/sentence clip: stop right after it.
      clipEnd = null;
      audio.pause();
    } else if (loop && clipEnd === null && (t >= loop.end || t < loop.start - 0.5)) {
      audio.currentTime = t = loop.start;
    }
    setActive(activeWordIndex(starts, ends, t, 1.5));
    if (!seeking) {
      $("#seek").value = String(t);
      const s = Math.floor(t);
      if (s !== lastSecond) {
        lastSecond = s;
        $("#cur").textContent = formatTime(t);
        if (s % 5 === 0) lsSet(posKey, t);
      }
    }
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  audio.addEventListener("timeupdate", update);

  audio.addEventListener("play", () => { if (!disposed) { $("#play").textContent = "❚❚"; kick(); } });
  audio.addEventListener("pause", () => {
    clipEnd = null; // any pause ends a word/sentence clip, so the next play continues normally
    if (!disposed) { $("#play").textContent = "▶"; lsSet(posKey, audio.currentTime); kick(); }
  });
  audio.addEventListener("seeked", () => { if (!disposed) kick(); });
  audio.addEventListener("ended", () => { if (!disposed) $("#play").textContent = "▶"; });

  // Manual scrolling is detected from user input (wheel, touch, keys, scrollbar drag), never
  // from 'scroll' events, which our own auto-scroll also fires (possibly late, e.g. when the
  // window is in the background and smooth scrolling stalls).
  function userScrolled() {
    if (follow) { follow = false; $("#back").hidden = false; }
  }
  tr.addEventListener("wheel", userScrolled, { passive: true });
  tr.addEventListener("touchmove", userScrolled, { passive: true });
  tr.addEventListener("keydown", (e) => {
    if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) userScrolled();
  });
  tr.addEventListener("pointerdown", (e) => {
    // Pressing on the scrollbar (left side in RTL, right side in LTR) targets the container itself.
    if (e.target === tr && (e.offsetX < tr.clientLeft || e.offsetX > tr.clientLeft + tr.clientWidth)) userScrolled();
  });
  $("#back").onclick = () => {
    follow = true;
    $("#back").hidden = true;
    if (curIdx >= 0) ensureVisible(wordEls[curIdx], true);
  };

  // ---------- transport ----------
  const play = () => audio.play().catch((e) => toast(`Playback failed: ${e.message}`, { error: true }));
  const seekTo = (t, autoplay = true) => {
    clipEnd = null;
    audio.currentTime = Math.max(0, Math.min(t, duration || t));
    follow = true;
    $("#back").hidden = true;
    if (autoplay && audio.paused) play();
    kick();
  };
  $("#play").onclick = () => { clipEnd = null; audio.paused ? play() : audio.pause(); };
  $("#back5").onclick = () => seekTo(audio.currentTime - 5, false);
  $("#fwd5").onclick = () => seekTo(audio.currentTime + 5, false);
  $("#speed").onchange = (e) => {
    speed = Number(e.target.value);
    audio.playbackRate = speed;
    audio.defaultPlaybackRate = speed;
    lsSet("speed", speed);
  };
  $("#seek").addEventListener("input", (e) => { seeking = true; $("#cur").textContent = formatTime(Number(e.target.value)); });
  $("#seek").addEventListener("change", (e) => { seeking = false; seekTo(Number(e.target.value), false); });

  // ---------- clips: play one word or one sentence, then pause ----------
  function playClip(start, end) {
    const from = Math.max(0, start - 0.04);
    clipEnd = end + 0.03;  // just past the word: more would start highlighting the next one
    audio.currentTime = from;
    if (audio.paused) play();
    kick();
    // Backup stop in case animation frames are throttled.
    clearTimeout(clipTimer);
    const ms = ((clipEnd - from) / (audio.playbackRate || 1)) * 1000 + 250;
    clipTimer = setTimeout(() => {
      if (clipEnd !== null && audio.currentTime >= clipEnd - 0.2) { clipEnd = null; audio.pause(); }
    }, ms);
  }

  // ---------- loop ----------
  function setLoop(first, last) {
    clearLoop();
    loop = { start: starts[first], end: ends[last] + 0.15, first, last };
    for (let i = first; i <= last; i++) wordEls[i].classList.add("loop");
    $("#loop-chip").hidden = false;
    seekTo(loop.start);
  }
  function clearLoop() {
    if (loop) for (let i = loop.first; i <= loop.last; i++) wordEls[i].classList.remove("loop");
    loop = null;
    $("#loop-chip").hidden = true;
  }
  $("#loop-off").onclick = clearLoop;

  // ---------- click to seek (never when selecting text) ----------
  let down = null;
  let pressTimer = 0;
  let suppressClick = false;

  tr.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY };
    suppressClick = false;
    const wEl = e.target.closest(".w");
    clearTimeout(pressTimer);
    // Long-press is for touch/pen. Mouse users right-click; a mouse long-press would fight
    // with press-and-drag text selection.
    if (wEl && e.pointerType !== "mouse") {
      pressTimer = setTimeout(() => {
        suppressClick = true;
        openMenu(e.clientX, e.clientY, wEl);
      }, LONG_PRESS_MS);
    }
  });
  tr.addEventListener("pointermove", (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) clearTimeout(pressTimer);
  });
  const endPress = () => clearTimeout(pressTimer);
  tr.addEventListener("pointerup", endPress);
  tr.addEventListener("pointercancel", endPress);

  tr.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const wEl = e.target.closest(".w");
    if (!wEl || e.detail > 1) return; // ignore the clicks of a double/triple-click (word/line select)
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // user is selecting text
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // drag
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    defineAt(Number(wEl.dataset.i));
  });

  tr.addEventListener("contextmenu", (e) => {
    const wEl = e.target.closest(".w");
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && tr.contains(sel.anchorNode);
    if (!wEl && !hasSel) return; // let the default menu appear on empty space
    e.preventDefault();
    clearTimeout(pressTimer);
    openMenu(e.clientX, e.clientY, wEl);
  });

  // ---------- context menu ----------
  function wordIndexAt(node, offset, atEnd) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const wEl = el && el.closest && el.closest(".w");
    if (wEl) return Number(wEl.dataset.i);
    // Boundary between elements: look at neighbouring child nodes.
    let child = node.nodeType === Node.ELEMENT_NODE ? node.childNodes[atEnd ? offset - 1 : offset] : node;
    while (child) {
      const cand = child.nodeType === Node.ELEMENT_NODE
        ? (child.classList.contains("w") ? child : (atEnd ? [...child.querySelectorAll(".w")].pop() : child.querySelector(".w")))
        : null;
      if (cand) return Number(cand.dataset.i);
      child = atEnd ? child.previousSibling : child.nextSibling;
    }
    return -1;
  }

  function selectionWords() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!tr.contains(range.commonAncestorContainer)) return null;
    let i = wordIndexAt(range.startContainer, range.startOffset, false);
    let j = wordIndexAt(range.endContainer, range.endOffset, true);
    // A range that starts at the very end of a word's text doesn't really include it.
    if (i >= 0 && range.startContainer.nodeType === Node.TEXT_NODE &&
        range.startOffset >= range.startContainer.length && i < n - 1) i++;
    if (j >= 0 && range.endContainer.nodeType === Node.TEXT_NODE && range.endOffset === 0 && j > 0) j--;
    if (i < 0 || j < 0) return null;
    if (j < i) [i, j] = [j, i];
    const text = sel.toString().replace(/\s+/g, " ").trim();
    return text ? { i, j, text } : null;
  }

  function openMenu(x, y, wEl) {
    let target = selectionWords();
    if (!target && wEl) {
      const i = Number(wEl.dataset.i);
      target = { i, j: i, text: texts[i] };
    }
    if (!target) return;
    const { i, j } = target;
    const clean = target.text.replace(EDGE_PUNCT, "") || target.text;
    const [si, sj] = sentenceBounds(texts, segOf, i, j);
    const sentence = texts.slice(si, sj + 1).join(" ");
    showMenu(x, y, clean, [
      {
        label: "★ Save to vocab",
        run: async () => {
          try {
            await api("/vocab", {
              method: "POST",
              body: { text: clean, sentence, episode_id: id, start: starts[i], end: ends[j],
                      sent_start: starts[si], sent_end: ends[sj] },
            });
            toast(`Saved “${clean}” to vocab`, { action: { label: "View", run: () => (location.hash = "#/vocab") } });
          } catch (e) { toast(e.message, { error: true }); }
        },
      },
      { label: "📖 Define", run: () => defineAt(i, j) },
      { label: "⧉ Copy", run: () => copyText(target.text) },
      { label: "▶ Play from here", run: () => seekTo(starts[i]) },
      { label: "⟲ Loop this sentence", run: () => setLoop(si, sj) },
    ]);
  }

  // ---------- definition bubble ----------
  let bubbleTarget = null; // {i, j, si, sj, text}

  function sentenceText(a, b) { return texts.slice(a, b + 1).join(" "); }

  function contextFor(i, j) {
    const [si, sj] = sentenceBounds(texts, segOf, i, j);
    const prev = si > 0 ? sentenceBounds(texts, segOf, si - 1) : null;
    const next = sj < n - 1 ? sentenceBounds(texts, segOf, sj + 1) : null;
    const word = texts.slice(i, j + 1).join(" ").replace(EDGE_PUNCT, "") || texts[i];
    return {
      si, sj, word,
      ctx: {
        word,
        marked: markWord(texts.slice(si, sj + 1), i - si, j - si),
        before: prev ? sentenceText(prev[0], prev[1]) : "",
        after: next ? sentenceText(next[0], next[1]) : "",
        podcast: ep.feed_title,
        episode: ep.title,
      },
    };
  }

  const bubble = createWordBubble($(".transcript-wrap"), {
    fetch: (ctx, refresh) => getDefinition(ctx, refresh),
    onPlayWord: () => bubbleTarget && playClip(starts[bubbleTarget.i], ends[bubbleTarget.j]),
    onPlaySentence: () => bubbleTarget && playClip(starts[bubbleTarget.si], ends[bubbleTarget.sj]),
    onPlayFrom: () => bubbleTarget && seekTo(starts[bubbleTarget.i]),
    onSettings: () => (location.hash = "#/settings"),
    onSave: async (def) => {
      const t = bubbleTarget;
      const notes = def ? [def.lemma && `Dictionary form: ${def.lemma}`, def.root && `Root: ${def.root}`,
        def.pos, def.dialect_note].filter(Boolean).join(" · ") : "";
      try {
        await api("/vocab", {
          method: "POST",
          body: { text: def && def.vocalized ? def.vocalized : t.text, sentence: sentenceText(t.si, t.sj),
                  episode_id: id, start: starts[t.i], end: ends[t.j], sent_start: starts[t.si], sent_end: ends[t.sj],
                  meaning: def ? def.meaning : "", notes },
        });
        toast(`Saved “${t.text}” to vocab`, { action: { label: "View", run: () => (location.hash = "#/vocab") } });
      } catch (e) {
        toast(e.message, { error: true });
        throw e;
      }
    },
  });

  function defineAt(i, j = i) {
    const c = contextFor(i, j);
    bubbleTarget = { i, j, si: c.si, sj: c.sj, text: c.word };
    playClip(starts[i], ends[j]);
    bubble.show(wordEls[i], c.ctx);
  }

  tr.addEventListener("scroll", () => bubble.position(), { passive: true });
  const onResize = () => bubble.position();
  window.addEventListener("resize", onResize);
  const onOutside = (e) => {
    if (bubble.open && !e.target.closest(".word-bubble") && !e.target.closest(".w") && !e.target.closest("#ctxmenu")) bubble.hide();
  };
  document.addEventListener("pointerdown", onOutside);

  // ---------- header actions ----------
  const safe = ep.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "transcript";
  for (const fmt of ["txt", "srt", "vtt"]) {
    $(`#exp-${fmt}`).onclick = () => download(`/api/episodes/${id}/export/${fmt}`, `${safe}.${fmt}`);
  }
  let fontTimer;
  const changeFont = (d) => {
    const s = state.status?.settings || {};
    const size = Math.max(16, Math.min(56, (s.font_size || 26) + d));
    s.font_size = size;
    document.documentElement.style.setProperty("--ar-size", `${size}px`);
    if (curIdx >= 0) ensureVisible(wordEls[curIdx], true);
    clearTimeout(fontTimer);
    fontTimer = setTimeout(() => saveSettings({ font_size: size }), 400);
  };
  $("#font-down").onclick = () => changeFont(-2);
  $("#font-up").onclick = () => changeFont(2);

  // ---------- keyboard ----------
  const onKey = (e) => {
    if (e.target.closest("input, select, textarea, button") && e.key === " ") return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === " " ) { e.preventDefault(); audio.paused ? play() : audio.pause(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo(audio.currentTime - 5, false); }
    else if (e.key === "ArrowRight") { e.preventDefault(); seekTo(audio.currentTime + 5, false); }
    else if (e.key === "Escape") { if (bubble.open) bubble.hide(); else clearLoop(); }
  };
  document.addEventListener("keydown", onKey);

  // ---------- media keys ----------
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: ep.feed_title,
        artwork: img ? [{ src: img }] : [] });
      navigator.mediaSession.setActionHandler("play", play);
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("seekbackward", () => seekTo(audio.currentTime - 5, false));
      navigator.mediaSession.setActionHandler("seekforward", () => seekTo(audio.currentTime + 5, false));
    } catch { /* unsupported */ }
  }

  // Jumped here from search: flash the matching word.
  if (query.get("t") !== null) {
    const idx = Math.max(0, activeWordIndex(starts, ends, startAt + 0.01, 1e9));
    requestAnimationFrame(() => {
      ensureVisible(wordEls[idx], true);
      wordEls[idx].classList.add("flash");
      setTimeout(() => wordEls[idx].classList.remove("flash"), 2500);
    });
  }

  return () => {
    disposed = true;
    clearTimeout(clipTimer);
    bubble.hide();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("pointerdown", onOutside);
    lsSet(posKey, audio.currentTime);
    audio.pause();
    delete window.__apsAudio;
    audio.removeAttribute("src");
    audio.load();
    cancelAnimationFrame(raf);
    clearTimeout(pressTimer);
    document.removeEventListener("keydown", onKey);
    hideMenu();
  };
}

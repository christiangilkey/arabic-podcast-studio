// Vocab list: saved words/phrases with their sentence, notes, audio replay and export.

import { api, esc, h, toast, download, fmtDate } from "../app.js";
import { formatTime } from "../wordlookup.js";

function highlight(sentence, word) {
  const s = esc(sentence);
  const w = esc(word);
  if (!w) return s;
  const at = s.indexOf(w);
  return at < 0 ? s : `${s.slice(0, at)}<b>${w}</b>${s.slice(at + w.length)}`;
}

export async function render(view) {
  view.append(h(`<div class="page">
    <div class="row" style="margin-bottom:12px">
      <h1 style="margin:0">Vocab</h1>
      <span class="muted" id="count"></span>
      <span class="spacer"></span>
      <input type="search" id="q" placeholder="Search vocab… ابحث" style="width:220px">
      <button type="button" id="csv">Export CSV</button>
      <button type="button" id="anki">Export for Anki</button>
    </div>
    <details class="card" id="add-box" style="margin-bottom:12px">
      <summary style="cursor:pointer"><strong>Add a word manually</strong></summary>
      <form id="add" class="stack" style="margin-top:10px">
        <input type="text" name="text" class="ar" placeholder="الكلمة" required dir="rtl" style="font-size:20px;width:100%">
        <input type="text" name="meaning" placeholder="Meaning" style="width:100%">
        <textarea name="sentence" class="ar" rows="2" placeholder="Example sentence (optional)" dir="rtl"></textarea>
        <div><button class="primary" type="submit">Add</button></div>
      </form>
    </details>
    <p class="small muted">Tip: in any transcript, right-click (or long-press) a word or a selected phrase and choose “Save to vocab”. In Anki, use File → Import and pick the exported .txt file.</p>
    <div class="vocab-list" id="list"></div>
  </div>`));
  const $ = (s) => view.querySelector(s);
  const list = $("#list");

  // One shared audio element for snippet playback.
  const audio = new Audio();
  let stopAt = Infinity;
  let raf = 0;
  const watch = () => {
    if (audio.currentTime >= stopAt) { audio.pause(); return; }
    if (!audio.paused) raf = requestAnimationFrame(watch);
  };
  // Backup for when animation frames are paused (window in the background).
  audio.addEventListener("timeupdate", () => { if (audio.currentTime >= stopAt) audio.pause(); });
  async function playSnippet(episodeId, start, end) {
    const src = `/api/episodes/${episodeId}/audio`;
    if (!audio.src.endsWith(src)) {
      audio.src = src;
      await new Promise((res, rej) => {
        audio.addEventListener("loadedmetadata", res, { once: true });
        audio.addEventListener("error", () => rej(new Error("Couldn't load this episode's audio.")), { once: true });
      });
    }
    audio.currentTime = Math.max(0, start - 0.25);
    stopAt = end + 0.35;
    await audio.play();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(watch);
  }

  function item(v) {
    const el = h(`<div class="card vocab-item">
      <div>
        <div class="word" dir="rtl"></div>
        ${v.sentence ? `<div class="sentence" dir="rtl">${highlight(v.sentence, v.text)}</div>` : ""}
        <div class="small muted" style="margin-top:6px">
          ${v.episode_id ? `<a href="#/episode/${v.episode_id}?t=${v.start ?? 0}">${esc(v.episode_title || "Episode")}</a>` : esc(v.episode_title || "Added manually")}
          ${v.start != null ? ` · ${formatTime(v.start)}` : ""} · saved ${fmtDate(v.created_at)}
        </div>
      </div>
      <div class="fields">
        <input type="text" class="meaning" placeholder="Meaning">
        <textarea class="notes" rows="2" placeholder="Notes (root, grammar, usage…)"></textarea>
        <div class="row">
          ${v.episode_id && v.start != null ? `<button type="button" class="play-word">▶ Word</button>` : ""}
          ${v.episode_id && v.sent_start != null ? `<button type="button" class="play-sent">▶ Sentence</button>` : ""}
          <span class="spacer"></span>
          <span class="small muted saved" hidden>Saved</span>
          <button type="button" class="ghost danger del">Delete</button>
        </div>
      </div>
    </div>`);
    el.querySelector(".word").textContent = v.text;
    el.querySelector(".meaning").value = v.meaning;
    el.querySelector(".notes").value = v.notes;
    let timer;
    const save = (field, value) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await api(`/vocab/${v.id}`, { method: "PATCH", body: { [field]: value } });
          v[field] = value;
          const s = el.querySelector(".saved");
          s.hidden = false;
          setTimeout(() => (s.hidden = true), 1200);
        } catch (e) { toast(e.message, { error: true }); }
      }, 500);
    };
    el.querySelector(".meaning").oninput = (e) => save("meaning", e.target.value);
    el.querySelector(".notes").oninput = (e) => save("notes", e.target.value);
    const pw = el.querySelector(".play-word");
    if (pw) pw.onclick = () => playSnippet(v.episode_id, v.start, v.end ?? v.start + 1).catch((e) => toast(e.message, { error: true }));
    const ps = el.querySelector(".play-sent");
    if (ps) ps.onclick = () => playSnippet(v.episode_id, v.sent_start, v.sent_end).catch((e) => toast(e.message, { error: true }));
    el.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete “${v.text}” from your vocab?`)) return;
      await api(`/vocab/${v.id}`, { method: "DELETE" });
      el.remove();
      load($("#q").value);
    };
    return el;
  }

  async function load(q = "") {
    const items = await api(`/vocab${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    $("#count").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    list.innerHTML = "";
    if (!items.length) {
      list.append(h(`<div class="empty">${q ? "No matches." : "No saved words yet."}</div>`));
      return;
    }
    for (const v of items) list.append(item(v));
  }

  let debounce;
  $("#q").oninput = (e) => { clearTimeout(debounce); debounce = setTimeout(() => load(e.target.value.trim()), 200); };
  $("#csv").onclick = () => download("/api/vocab/export/csv", "arabic-vocab.csv");
  $("#anki").onclick = () => download("/api/vocab/export/anki", "arabic-vocab-anki.txt");
  $("#add").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/vocab", { method: "POST", body: { text: f.get("text"), meaning: f.get("meaning"), sentence: f.get("sentence") } });
      e.target.reset();
      load();
    } catch (err) { toast(err.message, { error: true }); }
  };

  await load();
  return () => { audio.pause(); cancelAnimationFrame(raf); };
}

// Vocab list: saved words/phrases with their sentence, notes, audio replay and export.
// Words can be filed in any number of folders; the list can be sorted and filtered by when
// a word was added or last changed.

import { api, esc, h, toast, download, fmtDate, audioUrl, showMenu, shareClip, clipUrl } from "../app.js";
import { formatTime } from "../wordlookup.js";
import * as social from "../social.js";

const DAY = 86400;
const SORTS = {
  added_desc: ["Newest first", (a, b) => b.created_at - a.created_at],
  added_asc: ["Oldest first", (a, b) => a.created_at - b.created_at],
  changed_desc: ["Recently changed", (a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at)],
  changed_asc: ["Least recently changed", (a, b) => (a.updated_at || a.created_at) - (b.updated_at || b.created_at)],
  alpha: ["A–Z (Arabic)", (a, b) => a.text.localeCompare(b.text, "ar")],
};
const RANGES = { any: "Any time", today: "Today", week: "Last 7 days", month: "Last 30 days", year: "Last 12 months", custom: "Between dates…" };

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function highlight(sentence, word) {
  const s = esc(sentence);
  const w = esc(word);
  if (!w) return s;
  const at = s.indexOf(w);
  return at < 0 ? s : `${s.slice(0, at)}<b>${w}</b>${s.slice(at + w.length)}`;
}

/** [from, to) in seconds for a date-range choice; null bounds mean open-ended. */
export function rangeBounds(range, fromDate, toDate, now = Date.now() / 1000) {
  const startOfToday = new Date(now * 1000);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime() / 1000;
  switch (range) {
    case "today": return [today, null];
    case "week": return [now - 7 * DAY, null];
    case "month": return [now - 30 * DAY, null];
    case "year": return [now - 365 * DAY, null];
    case "custom": {
      const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() / 1000 : null;
      const to = toDate ? new Date(`${toDate}T00:00:00`).getTime() / 1000 + DAY : null; // inclusive end day
      return [from, to];
    }
    default: return [null, null];
  }
}

export async function render(view) {
  const prefs = lsGet("vocabView", {});
  const st = {
    folder: prefs.folder || "",           // "" = all, "none" = not in any folder, else a folder uid
    sort: SORTS[prefs.sort] ? prefs.sort : "added_desc",
    dateField: prefs.dateField === "changed" ? "changed" : "added",
    range: RANGES[prefs.range] ? prefs.range : "any",
    from: prefs.from || "",
    to: prefs.to || "",
    q: "",
  };
  const savePrefs = () => lsSet("vocabView", { folder: st.folder, sort: st.sort, dateField: st.dateField,
                                               range: st.range, from: st.from, to: st.to });

  view.append(h(`<div class="page vocab-page">
    <div class="row" style="margin-bottom:12px">
      <h1 style="margin:0">Vocab</h1>
      <span class="muted" id="count"></span>
      <span class="spacer"></span>
      <input type="search" id="q" placeholder="Search vocab… ابحث" style="width:220px">
      <button type="button" id="csv" title="Export the words shown below">Export CSV</button>
      <button type="button" id="anki" title="Export the words shown below">Export for Anki</button>
    </div>
    <div class="folder-bar" id="folders"></div>
    <div class="row vocab-filters">
      <label class="small muted">Sort
        <select id="sort">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}">${label}</option>`).join("")}</select></label>
      <label class="small muted">Show words
        <select id="date-field"><option value="added">added</option><option value="changed">changed</option></select></label>
      <select id="range">${Object.entries(RANGES).map(([k, label]) => `<option value="${k}">${label}</option>`).join("")}</select>
      <span id="custom-range" class="row" hidden>
        <input type="date" id="from" aria-label="From"> <span class="small muted">to</span> <input type="date" id="to" aria-label="To">
      </span>
    </div>
    <div class="bulk-bar" id="bulk" hidden>
      <span id="bulk-count"></span>
      <button type="button" id="bulk-add">📁 Add to folder</button>
      <button type="button" id="bulk-remove">Remove from folder</button>
      <button type="button" id="bulk-send">📨 Send to a friend</button>
      <span class="spacer"></span>
      <button type="button" class="ghost" id="bulk-clear">Clear selection</button>
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
    <p class="small muted">Tip: in any transcript, right-click (or long-press) a word or a selected phrase and choose “Save to vocab”. Tick words to file several into a folder at once. In Anki, use File → Import and pick the exported .txt file.</p>
    <div class="vocab-list" id="list"></div>
  </div>`));
  const $ = (s) => view.querySelector(s);
  const list = $("#list");

  let all = [];      // every word matching the search box
  let folders = [];  // [{uid, name}]
  const selected = new Set();
  const folderName = (uid) => (folders.find((f) => f.uid === uid) || {}).name;

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
  /** Play part of a word's audio: its own clip (a word a friend shared) or its episode. */
  async function playSnippet(v, start, end) {
    const source = v.clip ? `clip:${v.id}` : `episode:${v.episode_id}`;
    if (audio.dataset.episode !== source) {
      audio.dataset.episode = source;
      audio.src = v.clip ? await clipUrl(v) : await audioUrl(v.episode_id);
      await new Promise((res, rej) => {
        audio.addEventListener("loadedmetadata", res, { once: true });
        audio.addEventListener("error", () => { audio.dataset.episode = ""; rej(new Error("Couldn't load this word's audio.")); }, { once: true });
      });
    }
    audio.currentTime = Math.max(0, start - 0.25);
    stopAt = end + 0.35;
    await audio.play();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(watch);
  }

  // ----- folders -----
  async function newFolder() {
    const name = prompt("Name for the new folder:");
    if (!name || !name.trim()) return null;
    try {
      const f = await api("/vocab/folders", { method: "POST", body: { name: name.trim() } });
      folders.push(f);
      folders.sort((a, b) => a.name.localeCompare(b.name));
      return f;
    } catch (e) { toast(e.message, { error: true }); return null; }
  }

  function renderFolders() {
    const bar = $("#folders");
    bar.innerHTML = "";
    const count = (uid) => all.filter((v) => (uid === "none" ? !v.folders.length : v.folders.includes(uid))).length;
    const chip = (key, label, n) => {
      const b = h(`<button type="button" class="folder-chip${st.folder === key ? " active" : ""}"><span></span> <span class="n">${n}</span></button>`);
      b.firstElementChild.textContent = label;
      b.onclick = () => { st.folder = key; savePrefs(); renderAll(); };
      bar.append(b);
    };
    chip("", "All words", all.length);
    chip("none", "Not in a folder", count("none"));
    for (const f of folders) chip(f.uid, `📁 ${f.name}`, count(f.uid));
    const add = h(`<button type="button" class="folder-chip ghost">＋ New folder</button>`);
    add.onclick = async () => { const f = await newFolder(); if (f) { st.folder = f.uid; savePrefs(); renderAll(); } };
    bar.append(add);
    const current = folders.find((f) => f.uid === st.folder);
    if (current) {
      const rn = h(`<button type="button" class="ghost small-btn">Rename</button>`);
      rn.onclick = async () => {
        const name = prompt("Rename folder:", current.name);
        if (!name || !name.trim() || name.trim() === current.name) return;
        try {
          Object.assign(current, await api(`/vocab/folders/${current.uid}`, { method: "PATCH", body: { name: name.trim() } }));
          renderAll();
        } catch (e) { toast(e.message, { error: true }); }
      };
      const del = h(`<button type="button" class="ghost danger small-btn">Delete folder</button>`);
      del.onclick = async () => {
        if (!confirm(`Delete the folder “${current.name}”? The words in it are kept.`)) return;
        try {
          await api(`/vocab/folders/${current.uid}`, { method: "DELETE" });
          st.folder = "";
          savePrefs();
          await load();
        } catch (e) { toast(e.message, { error: true }); }
      };
      const share = h(`<button type="button" class="ghost small-btn">📨 Send folder to a friend</button>`);
      share.onclick = (e) => {
        const words = all.filter((v) => v.folders.includes(current.uid));
        const r = e.currentTarget.getBoundingClientRect();
        sendMenu(r.left, r.bottom + 4, words, current.name);
      };
      bar.append(rn, del, share);
    }
  }

  /** Menu of folders to put the given words into (or take them out of). */
  function folderMenu(x, y, items, mode) {
    const targets = mode === "remove"
      ? folders.filter((f) => items.some((v) => v.folders.includes(f.uid)))
      : folders;
    const apply = async (uid, add) => {
      try {
        await api("/vocab/bulk-folders", { method: "POST",
          body: { ids: items.map((v) => v.id), add: add ? [uid] : [], remove: add ? [] : [uid] } });
        for (const v of items) {
          const set = new Set(v.folders);
          add ? set.add(uid) : set.delete(uid);
          v.folders = [...set].sort();
          v.updated_at = Date.now() / 1000;
        }
        renderAll();
      } catch (e) { toast(e.message, { error: true }); }
    };
    const entries = targets.map((f) => {
      const inAll = items.every((v) => v.folders.includes(f.uid));
      if (mode === "remove") return { label: `✕ ${f.name}`, run: () => apply(f.uid, false) };
      if (mode === "add") return { label: `📁 ${f.name}`, run: () => apply(f.uid, true) };
      return { label: `${inAll ? "☑" : "☐"} ${f.name}`, run: () => apply(f.uid, !inAll) };
    });
    if (mode !== "remove") {
      entries.push({ label: "＋ New folder…", run: async () => { const f = await newFolder(); if (f) apply(f.uid, true); } });
    }
    if (!entries.length) { toast("These words aren't in any folder."); return; }
    showMenu(x, y, items.length === 1 ? items[0].text : `${items.length} words`, entries);
  }

  /** Pick a friend, then send them copies of these words (as a folder when `folderName` is set). */
  async function sendMenu(x, y, words, folderName = null) {
    if (!words.length) { toast("There are no words to send."); return; }
    let st;
    try { st = await social.friendsState(); } catch (e) { toast(e.message, { error: true }); return; }
    if (!st || !st.me.username) {
      toast("Connect and choose a username first.", { action: { label: "Settings", run: () => (location.hash = "#/settings") } });
      return;
    }
    if (!st.friends.length) {
      toast("Add a friend first.", { action: { label: "Friends", run: () => (location.hash = "#/friends") } });
      return;
    }
    const what = folderName ? `the folder “${folderName}” (${words.length} words)` : `${words.length} word${words.length === 1 ? "" : "s"}`;
    showMenu(x, y, `Send ${folderName ? "folder" : `${words.length} word${words.length === 1 ? "" : "s"}`} to…`,
      st.friends.map((f) => ({
        label: `@${f.user.username}`,
        run: async () => {
          const uploaded = [];
          try {
            // Each word takes a short clip of its sentence with it, so your friend's
            // "Word" and "Sentence" buttons play exactly what yours do.
            const withAudio = words.filter((v) => (v.episode_id || v.clip) && v.start != null).slice(0, social.MAX_SHARE_CLIPS);
            if (withAudio.length) toast(`Preparing audio for ${withAudio.length} word${withAudio.length === 1 ? "" : "s"}…`, { timeout: 2500 });
            const clips = new Map();
            for (const v of withAudio) {
              const clip = await shareClip(v);
              if (!clip) continue;
              const path = await social.uploadClip(f.user.id, clip.blob);
              uploaded.push(path);
              clips.set(v.id, { clip: path, times: clip.times });
            }
            await social.sendShare(f.user.id, { folder: folderName, words: words.map((v) => ({ ...v, ...(clips.get(v.id) || {}) })) });
            const audioNote = clips.size === words.length ? " with audio" : clips.size ? ` (${clips.size} with audio)` : "";
            toast(`Sent ${what}${audioNote} to ${f.user.username}.`, { action: { label: "Open chat", run: () => (location.hash = `#/chat/${f.user.id}`) } });
          } catch (e) {
            social.removeShareClips({ words: uploaded.map((clip) => ({ clip })) }).catch(() => {});
            toast(e.message, { error: true });
          }
        },
      })));
  }

  // ----- items -----
  function item(v) {
    const changed = v.updated_at && v.updated_at - v.created_at > 60;
    const el = h(`<div class="card vocab-item">
      <div>
        <div class="row" style="gap:8px;align-items:flex-start">
          <input type="checkbox" class="pick" aria-label="Select word">
          <div class="word" dir="rtl" style="flex:1"></div>
        </div>
        ${v.sentence ? `<div class="sentence" dir="rtl">${highlight(v.sentence, v.text)}</div>` : ""}
        <div class="small muted" style="margin-top:6px">
          ${v.episode_id ? `<a href="#/episode/${v.episode_id}?t=${v.start ?? 0}">${esc(v.episode_title || "Episode")}</a>` : esc(v.episode_title || "Added manually")}
          ${v.start != null ? ` · ${formatTime(v.start)}` : ""} · added ${fmtDate(v.created_at)}${changed ? ` · changed ${fmtDate(v.updated_at)}` : ""}
        </div>
        <div class="item-folders"></div>
      </div>
      <div class="fields">
        <input type="text" class="meaning" placeholder="Meaning">
        <textarea class="notes" rows="2" placeholder="Notes (root, grammar, usage…)"></textarea>
        <div class="row">
          ${(v.episode_id || v.clip) && v.start != null ? `<button type="button" class="play-word">▶ Word</button>` : ""}
          ${(v.episode_id || v.clip) && v.sent_start != null ? `<button type="button" class="play-sent">▶ Sentence</button>` : ""}
          <button type="button" class="ghost folders-btn">📁 Folders</button>
          <span class="spacer"></span>
          <span class="small muted saved" hidden>Saved</span>
          <button type="button" class="ghost danger del">Delete</button>
        </div>
      </div>
    </div>`);
    el.querySelector(".word").textContent = v.text;
    el.querySelector(".meaning").value = v.meaning;
    el.querySelector(".notes").value = v.notes;
    const chips = el.querySelector(".item-folders");
    for (const uid of v.folders) {
      const name = folderName(uid);
      if (!name) continue;
      const c = h(`<span class="tag"></span>`);
      c.textContent = `📁 ${name}`;
      chips.append(c);
    }
    const pick = el.querySelector(".pick");
    pick.checked = selected.has(v.id);
    pick.onchange = () => { pick.checked ? selected.add(v.id) : selected.delete(v.id); renderBulk(); };
    let timer;
    const save = (field, value) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await api(`/vocab/${v.id}`, { method: "PATCH", body: { [field]: value } });
          v[field] = value;
          v.updated_at = Date.now() / 1000;
          const s = el.querySelector(".saved");
          s.hidden = false;
          setTimeout(() => (s.hidden = true), 1200);
        } catch (e) { toast(e.message, { error: true }); }
      }, 500);
    };
    el.querySelector(".meaning").oninput = (e) => save("meaning", e.target.value);
    el.querySelector(".notes").oninput = (e) => save("notes", e.target.value);
    el.querySelector(".folders-btn").onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      folderMenu(r.left, r.bottom + 4, [v], "toggle");
    };
    const pw = el.querySelector(".play-word");
    if (pw) pw.onclick = () => playSnippet(v, v.start, v.end ?? v.start + 1).catch((e) => toast(e.message, { error: true }));
    const ps = el.querySelector(".play-sent");
    if (ps) ps.onclick = () => playSnippet(v, v.sent_start, v.sent_end).catch((e) => toast(e.message, { error: true }));
    el.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete “${v.text}” from your vocab?`)) return;
      await api(`/vocab/${v.id}`, { method: "DELETE" });
      all = all.filter((x) => x !== v);
      selected.delete(v.id);
      renderAll();
    };
    return el;
  }

  function visible() {
    let items = all;
    if (st.folder === "none") items = items.filter((v) => !v.folders.length);
    else if (st.folder) items = items.filter((v) => v.folders.includes(st.folder));
    const [from, to] = rangeBounds(st.range, st.from, st.to);
    const when = (v) => (st.dateField === "changed" ? v.updated_at || v.created_at : v.created_at);
    if (from !== null) items = items.filter((v) => when(v) >= from);
    if (to !== null) items = items.filter((v) => when(v) < to);
    return [...items].sort(SORTS[st.sort][1]);
  }

  function renderBulk() {
    for (const id of [...selected]) if (!all.some((v) => v.id === id)) selected.delete(id);
    $("#bulk").hidden = selected.size === 0;
    $("#bulk-count").textContent = `${selected.size} selected`;
  }

  function renderAll() {
    if (st.folder && st.folder !== "none" && !folderName(st.folder)) st.folder = "";
    renderFolders();
    const items = visible();
    const filtered = items.length !== all.length;
    $("#count").textContent = `${items.length}${filtered ? ` of ${all.length}` : ""} item${items.length === 1 ? "" : "s"}`;
    list.innerHTML = "";
    if (!items.length) {
      list.append(h(`<div class="empty">${all.length ? "No words match these filters." : st.q ? "No matches." : "No saved words yet."}</div>`));
    }
    for (const v of items) list.append(item(v));
    renderBulk();
  }

  async function load() {
    const [items, fl] = await Promise.all([
      api(`/vocab${st.q ? `?q=${encodeURIComponent(st.q)}` : ""}`),
      api("/vocab/folders"),
    ]);
    all = items.map((v) => ({ ...v, folders: v.folders || [] }));
    folders = fl;
    renderAll();
  }

  // ----- wiring -----
  $("#sort").value = st.sort;
  $("#date-field").value = st.dateField;
  $("#range").value = st.range;
  $("#from").value = st.from;
  $("#to").value = st.to;
  $("#custom-range").hidden = st.range !== "custom";
  $("#sort").onchange = (e) => { st.sort = e.target.value; savePrefs(); renderAll(); };
  $("#date-field").onchange = (e) => { st.dateField = e.target.value; savePrefs(); renderAll(); };
  $("#range").onchange = (e) => {
    st.range = e.target.value;
    $("#custom-range").hidden = st.range !== "custom";
    savePrefs();
    renderAll();
  };
  $("#from").onchange = (e) => { st.from = e.target.value; savePrefs(); renderAll(); };
  $("#to").onchange = (e) => { st.to = e.target.value; savePrefs(); renderAll(); };

  const pickedItems = () => all.filter((v) => selected.has(v.id));
  $("#bulk-add").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); folderMenu(r.left, r.bottom + 4, pickedItems(), "add"); };
  $("#bulk-remove").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); folderMenu(r.left, r.bottom + 4, pickedItems(), "remove"); };
  $("#bulk-send").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); sendMenu(r.left, r.bottom + 4, pickedItems()); };
  $("#bulk-clear").onclick = () => { selected.clear(); renderAll(); };

  let debounce;
  $("#q").oninput = (e) => { clearTimeout(debounce); debounce = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 200); };
  const exportUrl = (fmt) => {
    const ids = visible().map((v) => v.id);
    return `/api/vocab/export/${fmt}${ids.length === all.length && !st.q ? "" : `?ids=${encodeURIComponent(ids.join(","))}`}`;
  };
  $("#csv").onclick = () => download(exportUrl("csv"), "arabic-vocab.csv");
  $("#anki").onclick = () => download(exportUrl("anki"), "arabic-vocab-anki.txt");
  $("#add").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const inFolder = st.folder && st.folder !== "none" ? [st.folder] : [];
    try {
      const v = await api("/vocab", { method: "POST", body: { text: f.get("text"), meaning: f.get("meaning"), sentence: f.get("sentence") } });
      if (inFolder.length) await api(`/vocab/${v.id}`, { method: "PATCH", body: { folders: inFolder } });
      e.target.reset();
      load();
    } catch (err) { toast(err.message, { error: true }); }
  };

  await load();
  return () => { audio.pause(); cancelAnimationFrame(raf); };
}

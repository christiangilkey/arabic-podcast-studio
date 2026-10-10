// Library: feeds sidebar, episode list with live status, multi-select transcription.

import { api, esc, h, fmtDate, fmtDuration, on, toast, requestNotifications, uploadVideo, openBrowser } from "../app.js";
import { importUrl } from "../pageimport.js";

const FILTERS = [
  ["", "All"],
  ["new", "Not started"],
  ["queued", "Queued"],
  ["active", "In progress"],
  ["done", "Done"],
  ["failed", "Failed"],
];
const PAGE = 100;

export const isVideo = (ep) => (ep.audio_type || "").startsWith("video/");
export const isLocalFeed = (url) => (url || "").startsWith("local:");
export const isPage = (ep) => (ep.audio_type || "") === "text/html";
const PAGES_FEED = "local:pages";

export function statusInfo(ep) {
  const p = Math.round(ep.progress || 0);
  switch (ep.status) {
    case "queued": return { cls: "queued", label: "Queued" };
    case "downloading": return { cls: "active", label: `Downloading ${p}%`, bar: p };
    case "transcribing": return { cls: "active", label: `Transcribing ${p}%`, bar: p };
    case "done": return { cls: "done", label: "Done" };
    case "failed": return { cls: "failed", label: "Failed" };
    default: return { cls: "", label: "Not started" };
  }
}

export async function render(view, { feedId, query }) {
  const filter = query.get("status") || "";
  const selected = new Set();
  let offset = 0;
  let feeds = [];

  view.append(h(`
    <div class="library">
      <aside class="sidebar">
        <div class="add-page">
          <form class="add-feed" id="add-page">
            <label for="page-url"><strong>Add a webpage</strong></label>
            <div class="row">
              <input id="page-url" type="text" inputmode="url" placeholder="Paste website URL" required autocomplete="off">
              <button class="primary" type="submit">Import</button>
            </div>
          </form>
          <button type="button" id="open-browser" class="browser-btn" title="Browse the web inside the app and import any page you're reading">
            <span class="ico">🌐</span><span>Open Web<br>Browser</span></button>
        </div>
        <form class="add-feed" id="add-feed">
          <label for="feed-url"><strong>Add a podcast</strong></label>
          <div class="row">
            <input id="feed-url" type="url" placeholder="Paste RSS feed URL" required autocomplete="off">
            <button class="primary" type="submit">Add</button>
          </div>
        </form>
        <div class="row">
          <button type="button" id="refresh" class="ghost" title="Check feeds for new episodes and sync with Google Drive (picks up anything queued on your phone)">⟳ Refresh &amp; sync</button>
          <button type="button" id="add-video" class="ghost" title="Add a video file of your own; it's transcribed and stored in your Google Drive">🎬 Add video</button>
          <input type="file" id="video-file" accept="video/*,.mkv" hidden>
        </div>
        <div class="upload-status" id="upload-status" hidden>
          <div class="small"><span id="upload-name"></span> <span class="muted" id="upload-pct"></span></div>
          <div class="progress"><i id="upload-bar"></i></div>
        </div>
        <div class="feed-list" id="feed-list"></div>
      </aside>
      <section class="lib-main">
        <div id="lib-head"></div>
        <div class="tabs" id="tabs"></div>
        <div class="toolbar">
          <label class="switch"><input type="checkbox" id="select-all"> Select all</label>
          <button type="button" id="transcribe-selected" class="primary" disabled>Transcribe selected</button>
          <span class="spacer"></span>
          <input type="search" id="title-filter" placeholder="Filter by title" style="width:200px">
        </div>
        <div class="episodes" id="episodes"></div>
        <div class="row" style="justify-content:center;margin-top:12px"><button type="button" id="more" hidden>Load more</button></div>
      </section>
    </div>`));

  const $ = (sel) => view.querySelector(sel);
  const listEl = $("#episodes");
  let titleQuery = "";

  // ----- feeds -----
  async function loadFeeds() {
    feeds = await api("/feeds");
    const list = $("#feed-list");
    list.innerHTML = "";
    const all = h(`<a class="feed-item${feedId ? "" : " active"}" href="#/library"><div class="ph all">🎧</div><div><div class="t">All episodes</div></div></a>`);
    list.append(all);
    for (const f of feeds) {
      const img = f.url === PAGES_FEED ? `<div class="ph all">🌐</div>` : isLocalFeed(f.url) ? `<div class="ph all">🎬</div>` : f.image ? `<img src="${esc(f.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph"></div>`;
      list.append(h(`<a class="feed-item${f.id === feedId ? " active" : ""}" href="#/feed/${f.id}">
        ${img}<div style="min-width:0"><div class="t">${esc(f.title)}</div>
        <div class="small muted">${f.done_count || 0}/${f.episode_count} transcribed${f.last_error ? " · ⚠" : ""}</div></div></a>`));
    }
    if (!feeds.length) {
      list.append(h(`<p class="small muted" style="padding:6px">No podcasts yet. Paste a feed's RSS URL above. You can usually find it on the podcast's website, or by searching “podcast name RSS”.</p>`));
    }
    renderHead();
  }

  function renderHead() {
    const head = $("#lib-head");
    head.innerHTML = "";
    if (!feedId) {
      head.append(h(`<div class="lib-head"><div class="meta"><h1>All episodes</h1></div></div>`));
      return;
    }
    const f = feeds.find((x) => x.id === feedId);
    if (!f) { location.hash = "#/library"; return; }
    if (f.url === PAGES_FEED) {
      head.append(h(`<div class="lib-head"><div class="ph video-ph">🌐</div><div class="meta"><h1>${esc(f.title)}</h1>
        <div class="desc small">Web pages you imported. Open one to read it with every word clickable. Add more with
        “Add a webpage”, or browse with “Open Web Browser” and press Import Page.</div></div></div>`));
      return;
    }
    if (isLocalFeed(f.url)) {
      head.append(h(`<div class="lib-head"><div class="ph video-ph">🎬</div><div class="meta"><h1>${esc(f.title)}</h1>
        <div class="desc small">Video files you added yourself. They're transcribed on your computer and stored in your
        Google Drive, so every device can play them. Use “🎬 Add video” to add more.</div></div></div>`));
      return;
    }
    const el = h(`<div class="lib-head">
      ${f.image ? `<img src="${esc(f.image)}" alt="" referrerpolicy="no-referrer">` : ""}
      <div class="meta">
        <h1 style="unicode-bidi:plaintext">${esc(f.title)}</h1>
        <div class="desc small" style="unicode-bidi:plaintext">${esc(f.description)}</div>
        <div class="row" style="margin-top:8px">
          <label class="switch" title="Queue new episodes for transcription automatically when they appear">
            <input type="checkbox" id="auto" ${f.auto_transcribe ? "checked" : ""}> Auto-transcribe new episodes
          </label>
          <span class="spacer"></span>
          <span class="small muted">${f.last_error ? `⚠ Last refresh failed: ${esc(f.last_error)}` : f.last_checked ? `Checked ${new Date(f.last_checked * 1000).toLocaleString()}` : ""}</span>
          <button type="button" class="ghost danger" id="remove-feed">Remove podcast</button>
        </div>
      </div></div>`);
    head.append(el);
    el.querySelector("#auto").onchange = async (e) => {
      await api(`/feeds/${feedId}`, { method: "PATCH", body: { auto_transcribe: e.target.checked } });
      toast(e.target.checked ? "New episodes will be transcribed automatically." : "Auto-transcribe turned off.");
    };
    el.querySelector("#remove-feed").onclick = async () => {
      if (!confirm(`Remove “${f.title}”? Its transcripts and downloaded audio will be deleted. Saved vocab is kept.`)) return;
      await api(`/feeds/${feedId}`, { method: "DELETE" });
      location.hash = "#/library";
    };
  }

  // ----- episodes -----
  function renderTabs(counts) {
    const n = (k) => {
      if (!k) return Object.values(counts).reduce((a, b) => a + b, 0);
      if (k === "active") return (counts.downloading || 0) + (counts.transcribing || 0);
      return counts[k] || 0;
    };
    const tabs = $("#tabs");
    tabs.innerHTML = "";
    for (const [key, label] of FILTERS) {
      const b = h(`<button type="button" class="${key === filter ? "active" : ""}">${label} <span class="n">${n(key)}</span></button>`);
      b.onclick = () => {
        const base = feedId ? `#/feed/${feedId}` : "#/library";
        location.hash = key ? `${base}?status=${key}` : base;
      };
      tabs.append(b);
    }
  }

  function epRow(ep) {
    const img = ep.image || ep.feed_image;
    const row = h(`<div class="ep" data-id="${ep.id}">
      <input type="checkbox" class="sel" aria-label="Select episode">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
      <div class="info">
        <div class="title" dir="auto"></div>
        <div class="sub">${feedId ? "" : `${esc(ep.feed_title)} · `}${fmtDate(ep.published)}${ep.duration ? ` · ${fmtDuration(ep.duration)}` : ""}</div>
      </div>
      <div class="status"></div>
    </div>`);
    const title = row.querySelector(".title");
    if (isVideo(ep)) title.dataset.video = "1";
    if (ep.status === "done" || isVideo(ep)) {
      const a = h(`<a href="#/episode/${ep.id}"></a>`);
      a.textContent = ep.title;
      title.append(a);
    } else {
      title.textContent = ep.title;
    }
    row.querySelector(".sel").checked = selected.has(ep.id);
    row.querySelector(".sel").onchange = (e) => {
      e.target.checked ? selected.add(ep.id) : selected.delete(ep.id);
      updateSelection();
    };
    row._ep = ep;
    renderStatus(row);
    return row;
  }

  function renderStatus(row) {
    const ep = row._ep;
    const st = statusInfo(ep);
    const box = row.querySelector(".status");
    box.innerHTML = "";
    const line = h(`<div class="row"><span class="pill ${st.cls}">${st.label}</span></div>`);
    const btn = (label, cls, fn) => {
      const b = h(`<button type="button" class="${cls}">${label}</button>`);
      b.onclick = fn;
      line.append(b);
    };
    switch (ep.status) {
      case "done":
        btn(isVideo(ep) ? "Watch" : isPage(ep) ? "Read" : "Open", "primary", () => (location.hash = `#/episode/${ep.id}`));
        break;
      case "failed":
        btn("Retry", "", () => transcribe([ep.id]));
        break;
      case "queued":
      case "downloading":
      case "transcribing":
        btn("Cancel", "ghost", async () => { await api(`/episodes/${ep.id}/cancel`, { method: "POST" }); });
        break;
      default:
        btn("Transcribe", "", () => transcribe([ep.id]));
    }
    if (isVideo(ep) && ep.status !== "done") btn("Watch", "ghost", () => (location.hash = `#/episode/${ep.id}`));
    if (isLocalFeed(ep.feed_url)) {
      btn("Delete", "ghost danger", async () => {
        if (!confirm(isPage(ep) ? `Delete “${ep.title}” from your webpages? Saved vocab is kept.`
          : `Delete “${ep.title}”? The video and its transcript are removed from this device and from your Google Drive. Saved vocab is kept.`)) return;
        try {
          await api(`/episodes/${ep.id}`, { method: "DELETE" });
          row.remove();
          scheduleReload();
        } catch (e) { toast(e.message, { error: true }); }
      });
    }
    box.append(line);
    if (st.bar !== undefined) box.append(h(`<div class="progress"><i style="width:${st.bar}%"></i></div>`));
    if (ep.status === "failed" && ep.error) {
      const err = h(`<div class="err"></div>`);
      err.textContent = ep.error;
      box.append(err);
    }
    // Title becomes a link once done (videos can be watched straight away).
    const title = row.querySelector(".title");
    if ((ep.status === "done" || isVideo(ep)) && !title.querySelector("a")) {
      title.innerHTML = "";
      const a = h(`<a href="#/episode/${ep.id}"></a>`);
      a.textContent = ep.title;
      title.append(a);
    }
  }

  async function transcribe(ids) {
    requestNotifications();
    try {
      const r = await api("/episodes/transcribe", { method: "POST", body: { ids } });
      if (!r.queued.length) toast("Those episodes are already queued or in progress.");
      else toast(`Queued ${r.queued.length} episode${r.queued.length > 1 ? "s" : ""} for transcription.`);
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  function updateSelection() {
    const b = $("#transcribe-selected");
    b.disabled = selected.size === 0;
    b.textContent = selected.size ? `Transcribe selected (${selected.size})` : "Transcribe selected";
  }

  async function loadEpisodes(append = false) {
    if (!append) offset = 0;
    const params = new URLSearchParams({ limit: PAGE, offset });
    if (feedId) params.set("feed_id", feedId);
    if (filter) params.set("status", filter);
    if (titleQuery) params.set("q", titleQuery);
    const data = await api(`/episodes?${params}`);
    renderTabs(data.counts);
    if (!append) listEl.innerHTML = "";
    for (const ep of data.items) listEl.append(epRow(ep));
    offset += data.items.length;
    $("#more").hidden = offset >= data.total;
    if (!data.total) {
      listEl.append(h(`<div class="empty">${feeds.length ? "No episodes match this filter." : "Add a podcast to get started."}</div>`));
    }
  }

  // ----- wiring -----
  $("#add-feed").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("#feed-url");
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      const feed = await api("/feeds", { method: "POST", body: { url: input.value } });
      input.value = "";
      toast(`Subscribed to ${feed.title}`);
      location.hash = `#/feed/${feed.id}`;
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = "Add";
    }
  };
  $("#refresh").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Refreshing…";
    try {
      const r = await api(feedId ? `/feeds/refresh?feed_id=${feedId}` : "/feeds/refresh", { method: "POST" });
      const found = r.new_episodes ? `${r.new_episodes} new episode(s).` : "No new episodes.";
      toast(r.already_running ? "Already refreshing…" : r.synced ? `${found} Synced with Google Drive.` : found);
      await loadFeeds();
      await loadEpisodes();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      e.target.disabled = false;
      e.target.textContent = "⟳ Refresh & sync";
    }
  };
  $("#select-all").onchange = (e) => {
    listEl.querySelectorAll(".ep").forEach((row) => {
      const cb = row.querySelector(".sel");
      cb.checked = e.target.checked;
      e.target.checked ? selected.add(row._ep.id) : selected.delete(row._ep.id);
    });
    updateSelection();
  };
  $("#transcribe-selected").onclick = async () => {
    await transcribe([...selected]);
    selected.clear();
    $("#select-all").checked = false;
    listEl.querySelectorAll(".sel").forEach((cb) => (cb.checked = false));
    updateSelection();
  };
  $("#more").onclick = () => loadEpisodes(true);
  $("#add-page").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("#page-url");
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const ep = await importUrl(input.value);
      input.value = "";
      toast(`Imported “${ep.title}”.`, { action: { label: "Read", run: () => (location.hash = `#/episode/${ep.id}`) } });
      location.hash = `#/feed/${ep.feed_id}`;
      scheduleReload();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = "Import";
    }
  };
  $("#open-browser").onclick = () => {
    const typed = $("#page-url").value.trim();
    openBrowser(typed).catch((err) => toast(err.message, { error: true }));
  };
  $("#add-video").onclick = () => $("#video-file").click();
  $("#video-file").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const box = $("#upload-status");
    const btn = $("#add-video");
    btn.disabled = true;
    box.hidden = false;
    $("#upload-name").textContent = file.name;
    const paint = (frac) => {
      $("#upload-pct").textContent = `${Math.round(frac * 100)}%`;
      $("#upload-bar").style.width = `${frac * 100}%`;
    };
    paint(0);
    try {
      const ep = await uploadVideo(file, paint);
      toast(`Added “${ep.title}”. ${ep.note || "It's being transcribed now."}`);
      location.hash = `#/feed/${ep.feed_id}`;
      scheduleReload();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
      box.hidden = true;
    }
  };
  let debounce;
  $("#title-filter").oninput = (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { titleQuery = e.target.value.trim(); loadEpisodes(); }, 250);
  };

  // Live status updates: patch rows in place.
  let reloadTimer;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { loadFeeds(); loadEpisodes(); }, 400);
  };
  let countsTimer;
  const scheduleCounts = () => {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(async () => {
      const params = new URLSearchParams({ limit: 1 });
      if (feedId) params.set("feed_id", feedId);
      renderTabs((await api(`/episodes?${params}`)).counts);
      loadFeeds();
    }, 400);
  };
  const offEp = on("episode", (e) => {
    const row = listEl.querySelector(`.ep[data-id="${e.id}"]`);
    const prev = row ? row._ep.status : null;
    if (row) {
      Object.assign(row._ep, e);
      renderStatus(row);
    }
    // Counts/filters only change on status transitions, not on progress ticks.
    if (e.status && e.status !== prev) {
      if (filter || !row) scheduleReload();
      else scheduleCounts();
    }
  });
  const offFeeds = on("feeds", scheduleReload);
  const offRe = on("reconnected", scheduleReload);

  await loadFeeds();
  await loadEpisodes();
  if (!feeds.length) $("#feed-url").focus();

  return () => { offEp(); offFeeds(); offRe(); clearTimeout(reloadTimer); clearTimeout(countsTimer); };
}

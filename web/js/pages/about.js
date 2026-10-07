// About: version, update check, licenses.

import { api, esc, h } from "../app.js";

export async function render(view) {
  const a = await api("/about");
  view.append(h(`<div class="page">
    <div class="card stack">
      <div class="row"><img src="/icons/icon-256.png" alt="" width="72" height="72" style="border-radius:16px">
        <div><h1 style="margin:0">${esc(a.app_name)}</h1><div class="muted">Version ${esc(a.version)}</div></div></div>
      <p>A desktop app for studying Arabic podcasts: subscribe to RSS feeds, transcribe episodes locally with Whisper,
        read along with word-level highlighting, and build a vocabulary list.</p>
      <dl class="kv small">
        <dt>Data folder</dt><dd><code>${esc(a.data_dir)}</code></dd>
        <dt>Source code</dt><dd><a href="https://github.com/${esc(a.repo)}" target="_blank" rel="noopener">github.com/${esc(a.repo)}</a></dd>
        <dt>Runtime</dt><dd>Python ${esc(a.python)}</dd>
      </dl>
      <div class="row"><button type="button" id="upd">Check for updates</button><span id="upd-res" class="small"></span></div>
    </div>
    <div class="card licenses" style="margin-top:12px">
      <h2>Open-source licenses</h2>
      <p class="small muted">This app is built on these projects. Click one to read its license.</p>
      <div id="lic"></div>
    </div>
  </div>`));
  const box = view.querySelector("#lic");
  for (const l of a.licenses) {
    const d = h(`<details><summary><strong>${esc(l.name)}</strong> <span class="muted small">· ${esc(l.license)}</span></summary><pre>Loading…</pre></details>`);
    d.addEventListener("toggle", async () => {
      if (d.open && !d.dataset.loaded) {
        d.dataset.loaded = "1";
        d.querySelector("pre").textContent = await api(`/licenses/${encodeURIComponent(l.file)}`);
      }
    });
    box.append(d);
  }
  view.querySelector("#upd").onclick = async () => {
    const res = view.querySelector("#upd-res");
    res.textContent = "Checking…";
    const r = await api("/updates/check");
    if (!r.ok) res.textContent = r.error;
    else if (r.update_available) res.innerHTML = `Version ${esc(r.latest)} is available. <a href="${esc(r.url)}" target="_blank" rel="noopener">Download</a>`;
    else res.textContent = r.message || "You're up to date.";
  };
}

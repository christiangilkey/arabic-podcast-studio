// Settings: model, GPU, audio storage, appearance, data backup, updates.

import { api, esc, h, on, toast, download, state, loadStatus, saveSettings, fmtBytes } from "../app.js";
import { modelManager, gpuPanel } from "../components/models.js";
import { PROVIDERS, define } from "../definer.js";

export async function render(view) {
  const status = await loadStatus();
  const hw = status.hardware;
  const s = status.settings;
  const engineLabel = hw.engine === "mlx" ? "mlx-whisper on the Apple GPU (Metal)"
    : hw.device === "cuda" ? "faster-whisper on the NVIDIA GPU (CUDA, float16)"
    : "faster-whisper on the CPU (int8)";

  view.append(h(`<div class="page settings">
    <h1>Settings</h1>

    <section class="card">
      <h2>Transcription model</h2>
      <dl class="kv small" style="margin-bottom:10px">
        <dt>Engine</dt><dd>${esc(engineLabel)}</dd>
        <dt>Hardware</dt><dd>${esc(hw.cpu)} · ${hw.cpu_cores} threads · ${hw.ram_gb} GB RAM${hw.nvidia_gpu ? ` · ${esc(hw.nvidia_gpu)}${hw.nvidia_vram_gb ? ` (${hw.nvidia_vram_gb} GB)` : ""}` : ""}</dd>
      </dl>
      <p class="small muted">${esc(hw.recommendation_reason)} Changing the model affects new transcriptions only; re-transcribe an episode from the library to use it there.</p>
      <div id="models"></div>
    </section>

    ${hw.gpu_pack_supported ? `<section class="card"><h2>GPU acceleration</h2><div id="gpu"></div></section>` : ""}

    <section class="card stack" id="sync">
      <h2>Sync with Google Drive</h2>
      <p class="small muted">Keep your podcasts, transcripts and vocab in sync between this computer, other computers
        and the Android app. Everything is stored in a private app folder in <em>your own</em> Google Drive that only
        this app can see. Nothing goes to any other server.</p>
      <div id="sync-panel"></div>
    </section>

    <section class="card stack" id="definer">
      <h2>Word definitions (AI)</h2>
      <p class="small muted">Click any word in a transcript to hear it and see what it means <em>in that sentence</em>.
        This uses an AI provider with your own API key. You pay the provider directly; a lookup typically costs a
        fraction of a cent. The word, its sentence and the neighbouring sentences are sent to the provider you choose.
        Your key stays on this computer and is never included in data exports.</p>
      <div class="row">Provider:
        <select id="def-provider">${Object.entries(PROVIDERS).map(([k, p]) =>
          `<option value="${k}" ${k === (s.definer_provider || "claude") ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
        <a id="def-keylink" class="small" target="_blank" rel="noopener">Get an API key ↗</a>
      </div>
      <div class="row">API key:
        <input type="password" id="def-key" autocomplete="off" spellcheck="false" style="flex:1;min-width:240px" placeholder="Paste your API key">
        <button type="button" class="ghost" id="def-show">Show</button>
      </div>
      <div class="row">Model:
        <input type="text" id="def-model" list="def-models" style="width:240px" spellcheck="false">
        <datalist id="def-models"></datalist>
        <span class="small muted">Pick a suggestion or type any model name your account has.</span>
      </div>
      <div class="row">Explain in:
        <input type="text" id="def-lang" style="width:160px" value="${esc(s.definer_language || "English")}">
      </div>
      <div class="row">
        <button type="button" id="def-test">Test with an example</button>
        <span id="def-test-result" class="small"></span>
      </div>
    </section>

    <section class="card stack">
      <h2>Audio storage</h2>
      <label class="check"><input type="checkbox" id="delete-after" ${s.delete_audio_after ? "checked" : ""}>
        <span>Delete downloaded audio after transcription<br><span class="small muted">Saves disk space. The player then streams the audio from the podcast's server.</span></span></label>
      <label class="check"><input type="checkbox" id="stream" ${s.stream_from_source ? "checked" : ""}>
        <span>Always stream from the original URL<br><span class="small muted">Audio is downloaded only temporarily for transcription and never kept. Playback needs an internet connection.</span></span></label>
    </section>

    <section class="card stack">
      <h2>Appearance</h2>
      <div class="row">Theme:
        <label class="switch"><input type="radio" name="theme" value="system" ${s.theme === "system" ? "checked" : ""}> System</label>
        <label class="switch"><input type="radio" name="theme" value="light" ${s.theme === "light" ? "checked" : ""}> Light</label>
        <label class="switch"><input type="radio" name="theme" value="dark" ${s.theme === "dark" ? "checked" : ""}> Dark</label>
      </div>
      <div class="row">Transcript text size:
        <input type="range" id="font" min="16" max="56" step="1" value="${s.font_size}" style="width:220px">
        <span id="font-val">${s.font_size}px</span>
      </div>
      <div class="ar" dir="rtl" style="font-size:var(--ar-size);line-height:2.1">مَرْحَبًا بِكُمْ فِي حَلْقَةٍ جَدِيدَةٍ مِنَ البودكاست.</div>
    </section>

    <section class="card stack">
      <h2>Your data</h2>
      <p class="small">Your library, transcripts, vocab, models and settings are stored in:<br><code id="data-dir"></code></p>
      <div class="row">
        <button type="button" id="open-data">Open data folder</button>
        <button type="button" id="export">Export my data</button>
        <label class="switch small"><input type="checkbox" id="export-audio"> include downloaded audio</label>
      </div>
      <div class="row">
        <button type="button" id="import">Import data…</button>
        <input type="file" id="import-file" accept=".zip,application/zip" hidden>
        <span class="small muted">Replaces your current library with a backup (.zip).</span>
      </div>
    </section>

    <section class="card stack">
      <h2>Updates</h2>
      <div class="row"><span>Version ${esc(status.version)}</span><button type="button" id="check-updates">Check for updates</button></div>
      <div id="update-result" class="small"></div>
    </section>
  </div>`));

  const $ = (q) => view.querySelector(q);
  $("#data-dir").textContent = status.data_dir;
  const cleanups = [modelManager($("#models"), { hardware: hw })];
  if (hw.gpu_pack_supported) cleanups.push(gpuPanel($("#gpu"), hw));

  // ----- Google Drive sync -----
  function ago(ts) {
    if (!ts) return "never";
    const s = Math.round(Date.now() / 1000 - ts);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return new Date(ts * 1000).toLocaleString();
  }
  function paintSync(st) {
    const box = $("#sync-panel");
    if (!st.configured) {
      box.innerHTML = `<p class="small" style="color:var(--warn)">Sync isn't available in this build (no Google sign-in configured).</p>`;
      return;
    }
    if (!st.signed_in) {
      box.innerHTML = `<div class="row"><button type="button" class="primary" id="sync-login">Sign in with Google</button>
        <span class="small muted">Opens your web browser to sign in.</span></div>
        ${st.error ? `<p class="small" style="color:var(--danger)">${esc(st.error)}</p>` : ""}`;
      box.querySelector("#sync-login").onclick = async (e) => {
        e.target.disabled = true;
        e.target.textContent = "Waiting for Google…";
        try { await api("/sync/login", { method: "POST" }); }
        catch (err) { toast(err.message, { error: true }); e.target.disabled = false; e.target.textContent = "Sign in with Google"; }
      };
      return;
    }
    const busy = st.state === "syncing";
    const r = st.last_result;
    box.innerHTML = `
      <div class="row"><span class="pill done">Signed in</span> <strong>${esc(st.email || "Google account")}</strong>
        <span class="spacer"></span>
        <button type="button" id="sync-now" ${busy ? "disabled" : ""}>${busy ? "Syncing…" : "Sync now"}</button>
        <button type="button" class="ghost danger" id="sync-logout">Sign out</button></div>
      <div class="small ${st.state === "error" ? "" : "muted"}" style="${st.state === "error" ? "color:var(--danger)" : ""}">
        ${st.state === "error" ? `Last sync failed: ${esc(st.error)}` : `Last synced ${ago(st.last_sync)}`}
        ${r && st.state !== "error" ? ` · ${r.uploaded_transcripts} transcript(s) up, ${r.downloaded_transcripts} down, ${r.uploaded_audio} audio up` : ""}
      </div>
      <label class="check"><input type="checkbox" id="sync-audio" ${st.sync_audio ? "checked" : ""}>
        <span>Upload compressed audio copies (about 12 MB per hour)<br><span class="small muted">Lets your phone and other computers
        play exactly the audio that was transcribed, so highlighting stays in sync even on podcasts that insert different ads
        per download. Uses your Google Drive storage.</span></span></label>`;
    box.querySelector("#sync-now").onclick = async () => {
      try { paintSync(await api("/sync/now", { method: "POST" })); } catch (err) { toast(err.message, { error: true }); }
    };
    box.querySelector("#sync-logout").onclick = async () => {
      if (!confirm("Sign out of Google? Your library stays on this computer; it just stops syncing.")) return;
      paintSync(await api("/sync/logout", { method: "POST" }));
    };
    box.querySelector("#sync-audio").onchange = async (e) => {
      paintSync(await api("/sync/settings", { method: "PATCH", body: { sync_audio: e.target.checked } }));
    };
  }
  paintSync(await api("/sync/status"));
  cleanups.push(on("sync", paintSync));

  // ----- AI definitions -----
  const defProvider = () => $("#def-provider").value;
  function paintProvider() {
    const p = defProvider();
    const info = PROVIDERS[p];
    const cur = state.status.settings;
    $("#def-key").value = cur[`llm_key_${p}`] || "";
    $("#def-model").value = cur[`definer_model_${p}`] || info.defaultModel;
    $("#def-models").innerHTML = info.models.map((m) => `<option value="${esc(m)}">`).join("");
    $("#def-keylink").href = info.keyUrl;
    $("#def-test-result").textContent = "";
  }
  paintProvider();
  $("#def-provider").onchange = async () => { await saveSettings({ definer_provider: defProvider() }); paintProvider(); };
  $("#def-key").onchange = (e) => saveSettings({ [`llm_key_${defProvider()}`]: e.target.value.trim() });
  $("#def-model").onchange = (e) => saveSettings({ [`definer_model_${defProvider()}`]: e.target.value.trim() });
  $("#def-lang").onchange = (e) => saveSettings({ definer_language: e.target.value.trim() || "English" });
  $("#def-show").onclick = (e) => {
    const k = $("#def-key");
    k.type = k.type === "password" ? "text" : "password";
    e.target.textContent = k.type === "password" ? "Show" : "Hide";
  };
  $("#def-test").onclick = async (e) => {
    const out = $("#def-test-result");
    e.target.disabled = true;
    out.textContent = "Asking…";
    out.style.color = "";
    const p = defProvider();
    const t0 = performance.now();
    try {
      const d = await define(
        { provider: p, key: $("#def-key").value.trim(), model: $("#def-model").value.trim(), language: $("#def-lang").value.trim() || "English" },
        { word: "هون", marked: "انتي جديدة ⟦هون⟧؟", podcast: "Real Arabic (Levantine)" },
        (req) => api("/llm/relay", { method: "POST", body: req }),
      );
      out.textContent = `✓ Works (${((performance.now() - t0) / 1000).toFixed(1)} s): هون = “${d.meaning}” (${d.dialect || "?"})`;
      out.style.color = "var(--accent)";
    } catch (err) {
      out.textContent = err.message;
      out.style.color = "var(--danger)";
    } finally {
      e.target.disabled = false;
    }
  };

  $("#delete-after").onchange = (e) => saveSettings({ delete_audio_after: e.target.checked });
  $("#stream").onchange = (e) => saveSettings({ stream_from_source: e.target.checked });
  view.querySelectorAll("input[name=theme]").forEach((r) => (r.onchange = () => saveSettings({ theme: r.value })));
  let fontTimer;
  $("#font").oninput = (e) => {
    const v = Number(e.target.value);
    $("#font-val").textContent = `${v}px`;
    document.documentElement.style.setProperty("--ar-size", `${v}px`);
    clearTimeout(fontTimer);
    fontTimer = setTimeout(() => saveSettings({ font_size: v }), 300);
  };

  $("#open-data").onclick = async () => {
    try { await api("/system/open-data-folder", { method: "POST" }); }
    catch (e) { toast(e.message, { error: true }); }
  };
  $("#export").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Preparing…";
    try {
      const r = await api("/backup/export", { method: "POST", body: { include_audio: $("#export-audio").checked } });
      await download(r.url, r.name);
      if (!(window.pywebview && window.pywebview.api)) toast(`Backup ready (${fmtBytes(r.size)})`);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      e.target.disabled = false;
      e.target.textContent = "Export my data";
    }
  };
  $("#import").onclick = () => $("#import-file").click();
  $("#import-file").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!confirm(`Import “${file.name}”? This REPLACES your current library, transcripts and vocab with the backup's contents.`)) return;
    try {
      const r = await api("/backup/import", { method: "POST", raw: file });
      toast(`Imported. ${r.audio_files ? `${r.audio_files} audio files restored.` : ""}`);
      location.hash = "#/";
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  $("#check-updates").onclick = async () => {
    const box = $("#update-result");
    box.textContent = "Checking…";
    const r = await api("/updates/check");
    if (!r.ok) box.textContent = r.error;
    else if (r.update_available) box.innerHTML = `Version ${esc(r.latest)} is available. <a href="${esc(r.url)}" target="_blank" rel="noopener">Download it from GitHub</a>.`;
    else box.textContent = r.message || `You're up to date (${r.current}).`;
  };

  return () => cleanups.forEach((f) => f());
}

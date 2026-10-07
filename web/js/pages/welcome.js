// First run: welcome (how it works / adding a feed) then model setup.

import { api, esc, h, saveSettings, loadStatus, state } from "../app.js";
import { modelManager, gpuPanel } from "../components/models.js";

export async function render(view, { step }) {
  if (step === "welcome") {
    view.append(h(`<div class="welcome">
      <div class="hero"><img src="/icons/icon-256.png" alt=""><div>
        <h1 style="margin:0">Welcome to Arabic Podcast Studio</h1>
        <p class="muted" style="margin:0">Learn Arabic from real podcasts, with word-by-word transcripts.</p></div></div>
      <div class="ar-sample">أَهْلًا وَسَهْلًا</div>
      <div class="card stack">
        <h2>How it works</h2>
        <ol>
          <li><strong>Add a podcast by its RSS feed URL.</strong> Most podcasts publish one. Look for “RSS” on the podcast's website,
            or search the web for “<em>podcast name</em> RSS feed”. Apple Podcasts links won't work directly, but sites like
            castos.com/tools/find-podcast-rss-feed can turn them into an RSS URL.</li>
          <li><strong>Transcribe episodes.</strong> Click “Transcribe” on any episode. Everything runs on your computer.
            Nothing is uploaded anywhere.</li>
          <li><strong>Listen and read along.</strong> The current word is highlighted. Click any word to jump to it, slow the audio
            down, or loop a sentence.</li>
          <li><strong>Build your vocab.</strong> Right-click (or long-press) a word or phrase to save it with its sentence.
            Export to Anki when you're ready.</li>
        </ol>
        <p class="small muted">The app re-checks your podcasts every time it starts, so new episodes appear automatically.</p>
        <div><button class="primary" id="next" type="button">Next: set up transcription →</button></div>
      </div>
    </div>`));
    view.querySelector("#next").onclick = async () => {
      await saveSettings({ welcome_seen: true });
      location.hash = "#/setup";
    };
    return;
  }

  const status = await loadStatus();
  const hw = status.hardware;
  view.append(h(`<div class="welcome">
    <h1>Set up transcription</h1>
    <p>Transcription uses OpenAI's Whisper speech-recognition model, running entirely on your computer.
       The model is downloaded once. Pick a size below. You can download others or delete them later in Settings.</p>
    <div class="card stack">
      <h2>Your computer</h2>
      <dl class="kv small">
        <dt>System</dt><dd>${esc(hw.os)} · ${esc(hw.cpu)} · ${hw.ram_gb} GB RAM</dd>
        <dt>GPU</dt><dd>${hw.apple_silicon ? "Apple Silicon (Metal)" : hw.nvidia_gpu ? `${esc(hw.nvidia_gpu)}${hw.nvidia_vram_gb ? ` (${hw.nvidia_vram_gb} GB)` : ""}` : "No supported GPU. The CPU will be used."}</dd>
      </dl>
      <p><strong>Recommendation: ${esc(hw.recommended)}.</strong> ${esc(hw.recommendation_reason)}</p>
    </div>
    ${hw.gpu_pack_supported ? `<div class="card" style="margin-top:12px"><h2>GPU acceleration (optional)</h2><div id="gpu"></div></div>` : ""}
    <div class="card" style="margin-top:12px"><h2>Choose a model</h2><div id="models"></div></div>
    <div class="row" style="margin-top:16px">
      <span class="spacer"></span>
      <span class="small muted" id="hint">Download a model to continue. You can keep using the app while it downloads.</span>
      <button class="primary" type="button" id="done" disabled>Start using the app →</button>
    </div>
  </div>`));
  const $ = (q) => view.querySelector(q);
  const refresh = () => {
    const ready = state.status && state.status.model_ready;
    $("#done").disabled = !ready;
    $("#hint").hidden = !!ready;
  };
  const cleanups = [modelManager($("#models"), { hardware: hw, onChange: refresh })];
  if (hw.gpu_pack_supported) cleanups.push(gpuPanel($("#gpu"), hw));
  $("#done").onclick = async () => {
    await saveSettings({ welcome_seen: true });
    location.hash = "#/";
  };
  refresh();
  return () => cleanups.forEach((f) => f());
}

// Phone settings: Google account & sync, AI definitions, appearance.

import { esc, h, on, toast, saveSettings } from "../app.js";
import { PROVIDERS, define } from "../definer.js";
import { accountSection } from "../components/account.js";
import { transport } from "../define-service.js";
import { signIn, signOut } from "../drive.js";
import { isNative } from "../native.js";
import { settings } from "../store.js";
import { syncNow, syncState } from "../sync.js";

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ts * 1000).toLocaleString();
}

export async function render(view) {
  const s = settings;
  view.append(h(`<div class="page settings">
    <h1>Settings</h1>
    <section class="card stack">
      <h2>Google account</h2>
      <p class="small muted">Your podcasts, transcripts and vocab come from your computer through a private app folder
        in your own Google Drive. Transcription happens on your computer; tap "Transcribe" here and it will do it on its next sync.</p>
      <div id="account"></div>
    </section>

    <section class="card stack">
      <h2>Word definitions (AI)</h2>
      <p class="small muted">Tap any word to hear it and see what it means in that sentence. Uses your own API key
        (stored only on this phone). The word and its surrounding sentences are sent to the provider you choose.</p>
      <label class="stack-label">Provider
        <select id="def-provider">${Object.entries(PROVIDERS).map(([k, p]) =>
          `<option value="${k}" ${k === s.definer_provider ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
      <label class="stack-label">API key <a id="def-keylink" class="small" target="_blank" rel="noopener">get one ↗</a>
        <input type="password" id="def-key" autocomplete="off" spellcheck="false" placeholder="Paste your API key"></label>
      <label class="stack-label">Model
        <input type="text" id="def-model" list="def-models" spellcheck="false"><datalist id="def-models"></datalist></label>
      <label class="stack-label">Explain in
        <input type="text" id="def-lang" value="${esc(s.definer_language)}"></label>
      <div class="row"><button type="button" id="def-test">Test</button><span id="def-out" class="small"></span></div>
    </section>

    <section class="card stack">
      <h2>Appearance</h2>
      <div class="row">Theme:
        ${["system", "light", "dark"].map((t) => `<label class="switch"><input type="radio" name="theme" value="${t}" ${s.theme === t ? "checked" : ""}> ${t[0].toUpperCase() + t.slice(1)}</label>`).join("")}
      </div>
      <label class="check"><input type="checkbox" id="haptics" ${s.haptics !== false ? "checked" : ""}>
        <span>Vibrate lightly when I tap a word or save one</span></label>
      <div class="row">Podcast &amp; video text: <input type="range" id="font" min="16" max="48" value="${s.font_size}" style="flex:1"> <span id="font-val">${s.font_size}px</span></div>
      <div class="ar" dir="rtl" style="font-size:var(--ar-size);line-height:2">مَرْحَبًا بِكُمْ فِي البودكاست</div>
      <div class="row">Web page text: <input type="range" id="page-font" min="12" max="40" value="${s.page_font_size || 17}" style="flex:1"> <span id="page-font-val">${s.page_font_size || 17}px</span></div>
      <div class="ar" dir="rtl" style="font-size:var(--page-size);line-height:2">القهوة مشروب يُحضر من بذور البن المحمصة.</div>
    </section>

    <section class="card small muted">Tamkeen for Android · <a href="https://christiangilkey.github.io/tamkeen/privacy.html" target="_blank" rel="noopener">Privacy policy</a></section>
  </div>`));
  const $ = (q) => view.querySelector(q);
  $("#haptics").onchange = (e) => saveSettings({ haptics: e.target.checked });
  $("#account").closest("section").after(accountSection());

  function paintAccount(st = syncState) {
    const box = $("#account");
    if (!settings.signed_in) {
      box.innerHTML = `<button type="button" class="primary" id="login">Sign in with Google</button>
        ${isNative ? "" : `<p class="small muted">Sign-in works in the installed app.</p>`}`;
      box.querySelector("#login").onclick = async (e) => {
        e.target.disabled = true;
        try {
          const email = await signIn();
          toast(`Signed in as ${email}`);
          paintAccount();
          syncNow();
        } catch (err) {
          toast(err.message, { error: true });
          e.target.disabled = false;
        }
      };
      return;
    }
    const busy = st.state === "syncing";
    box.innerHTML = `<div class="row"><span class="pill done">Signed in</span> <strong>${esc(settings.google_email)}</strong></div>
      <div class="small ${st.state === "error" ? "" : "muted"}" style="${st.state === "error" ? "color:var(--danger)" : ""}">
        ${st.state === "error" ? `Sync failed: ${esc(st.error)}` : busy ? "Syncing…" : `Last synced ${ago(st.last_sync)}`}</div>
      <div class="row"><button type="button" id="sync-now" ${busy ? "disabled" : ""}>Sync now</button>
        <button type="button" class="ghost danger" id="logout">Sign out</button></div>`;
    box.querySelector("#sync-now").onclick = () => syncNow();
    box.querySelector("#logout").onclick = async () => {
      if (!confirm("Sign out of Google? Your library stays on this phone; it just stops syncing.")) return;
      await signOut();
      paintAccount();
    };
  }
  paintAccount();
  const off = on("sync", paintAccount);

  // AI definitions
  const prov = () => $("#def-provider").value;
  function paintProvider() {
    const p = prov();
    $("#def-key").value = settings[`llm_key_${p}`] || "";
    $("#def-model").value = settings[`definer_model_${p}`] || PROVIDERS[p].defaultModel;
    $("#def-models").innerHTML = PROVIDERS[p].models.map((m) => `<option value="${esc(m)}">`).join("");
    $("#def-keylink").href = PROVIDERS[p].keyUrl;
  }
  paintProvider();
  $("#def-provider").onchange = async () => { await saveSettings({ definer_provider: prov() }); paintProvider(); };
  $("#def-key").onchange = (e) => saveSettings({ [`llm_key_${prov()}`]: e.target.value.trim() });
  $("#def-model").onchange = (e) => saveSettings({ [`definer_model_${prov()}`]: e.target.value.trim() });
  $("#def-lang").onchange = (e) => saveSettings({ definer_language: e.target.value.trim() || "English" });
  $("#def-test").onclick = async (e) => {
    const out = $("#def-out");
    e.target.disabled = true;
    out.textContent = "Asking…";
    out.style.color = "";
    try {
      const d = await define({ provider: prov(), key: $("#def-key").value.trim(), model: $("#def-model").value.trim(),
                               language: $("#def-lang").value.trim() || "English" },
                             { word: "هون", marked: "انتي جديدة ⟦هون⟧؟", podcast: "Real Arabic (Levantine)" }, transport);
      out.textContent = `✓ Works: هون = “${d.meaning}”`;
      out.style.color = "var(--accent)";
    } catch (err) {
      out.textContent = err.message;
      out.style.color = "var(--danger)";
    } finally {
      e.target.disabled = false;
    }
  };

  // Appearance
  view.querySelectorAll("input[name=theme]").forEach((r) => (r.onchange = () => saveSettings({ theme: r.value })));
  $("#font").oninput = (e) => {
    $("#font-val").textContent = `${e.target.value}px`;
    saveSettings({ font_size: Number(e.target.value) });
  };
  $("#page-font").oninput = (e) => {
    $("#page-font-val").textContent = `${e.target.value}px`;
    saveSettings({ page_font_size: Number(e.target.value) });
  };
  return off;
}

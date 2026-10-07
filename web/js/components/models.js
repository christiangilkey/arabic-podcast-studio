// Model and GPU-pack management widgets, shared by Settings and first-run Setup.

import { api, esc, h, on, toast, fmtBytes, saveSettings, loadStatus } from "../app.js";

const INFO = {
  small: "Fastest. Good for clear speech; more mistakes on dialects and fast talk.",
  medium: "Balanced accuracy and speed.",
  "large-v3": "Most accurate, especially for Arabic. Best with a GPU.",
};

/** Renders the model list into `el`. Returns a cleanup function. */
export function modelManager(el, { hardware, onChange } = {}) {
  let data = null;

  async function load() {
    data = await api("/models");
    paint();
  }

  function paint() {
    const dl = data.download;
    el.innerHTML = "";
    for (const m of data.models) {
      const busy = dl.size === m.size && ["preparing", "downloading"].includes(dl.state);
      const recommended = hardware && hardware.recommended === m.size;
      const row = h(`<div class="model-row">
        <input type="radio" name="model" value="${m.size}" ${data.selected === m.size ? "checked" : ""} ${m.installed ? "" : "disabled"} aria-label="Use ${m.size}">
        <div>
          <div><strong>${m.size}</strong>${recommended ? `<span class="badge">Recommended</span>` : ""}
            <span class="small muted"> · ~${fmtBytes(m.approx_mb * 2 ** 20)}${m.installed ? " · downloaded" : m.partial ? " · partially downloaded" : ""}</span></div>
          <div class="small muted">${esc(INFO[m.size] || "")}</div>
          ${busy ? `<div class="progress"><i style="width:${dl.total ? (100 * dl.done) / dl.total : 0}%"></i></div>
                    <div class="small muted">${dl.state === "preparing" ? "Preparing…" : `${fmtBytes(dl.done)} of ${fmtBytes(dl.total)}`}</div>` : ""}
          ${dl.size === m.size && dl.state === "error" ? `<div class="small" style="color:var(--danger)">${esc(dl.error)}</div>` : ""}
        </div>
        <div class="row"></div>
      </div>`);
      const actions = row.querySelector(".row");
      if (busy) {
        const b = h(`<button type="button" class="ghost">Pause</button>`);
        b.onclick = () => api("/models/cancel", { method: "POST" });
        actions.append(b);
      } else if (m.installed) {
        const b = h(`<button type="button" class="ghost danger">Delete</button>`);
        b.onclick = async () => {
          if (!confirm(`Delete the ${m.size} model (${m.disk_mb} MB)? You can download it again later.`)) return;
          await api(`/models/${m.size}`, { method: "DELETE" });
          if (data.selected === m.size) await saveSettings({ model_size: null }).catch(() => {});
          load();
          onChange && onChange();
        };
        actions.append(b);
      } else {
        const b = h(`<button type="button" class="${recommended ? "primary" : ""}">${m.partial ? "Resume download" : "Download"}</button>`);
        b.disabled = ["preparing", "downloading"].includes(dl.state);
        b.onclick = async () => {
          try { await api(`/models/${m.size}/download`, { method: "POST" }); load(); }
          catch (e) { toast(e.message, { error: true }); }
        };
        actions.append(b);
      }
      row.querySelector("input").onchange = async () => {
        await saveSettings({ model_size: m.size });
        data.selected = m.size;
        toast(`Using the ${m.size} model for new transcriptions.`);
        await loadStatus();
        onChange && onChange();
      };
      el.append(row);
    }
  }

  const off = on("model_download", async (s) => {
    if (!data) return;
    data.download = s;
    if (s.state === "done") {
      await load();
      if (!data.selected || !data.models.find((m) => m.size === data.selected && m.installed)) {
        await saveSettings({ model_size: s.size });
        data.selected = s.size;
        paint();
      }
      toast(`The ${s.size} model is ready.`);
      await loadStatus();
      onChange && onChange();
    } else if (s.state === "error" || s.state === "idle") {
      load();
    } else {
      paint();
    }
  });
  load();
  return off;
}

/** GPU acceleration (CUDA libraries) panel. */
export function gpuPanel(el, hardware) {
  async function paint(s) {
    s = s || (await api("/gpu"));
    if (s.state === "done" || s.installed) hardware = await api("/hardware");
    const busy = ["preparing", "downloading", "extracting"].includes(s.state);
    el.innerHTML = "";
    const box = h(`<div class="stack">
      <p>Your <strong>${esc(hardware.nvidia_gpu)}</strong> can transcribe many times faster than the CPU.
      This needs NVIDIA's CUDA libraries (about 1.2 GB), which aren't included in the installer to keep it small.</p>
      <div id="gpu-state"></div>
    </div>`);
    const st = box.querySelector("#gpu-state");
    if (s.installed && hardware.cuda_libs_ready) {
      st.append(h(`<p><span class="pill done">GPU acceleration is active</span></p>`));
      const b = h(`<button type="button" class="ghost danger">Remove GPU libraries</button>`);
      b.onclick = async () => {
        if (!confirm("Remove the CUDA libraries? Transcription will use the CPU.")) return;
        const r = await api("/gpu", { method: "DELETE" });
        toast(r.restart_required ? "They'll be removed when you restart the app." : "Removed.");
      };
      st.append(b);
    } else if (s.installed) {
      st.append(h(`<p><span class="pill done">Installed</span> <span class="small muted">Restart the app to start using the GPU.</span></p>`));
    } else if (busy) {
      const pct = s.total ? (100 * s.done) / s.total : 0;
      st.append(h(`<div><div class="progress"><i style="width:${pct}%"></i></div>
        <div class="small muted">${s.state === "extracting" ? "Unpacking…" : s.state === "preparing" ? "Preparing…" : `${fmtBytes(s.done)} of ${fmtBytes(s.total)}`}</div></div>`));
    } else {
      if (s.state === "error") st.append(h(`<p class="small" style="color:var(--danger)">${esc(s.error)}</p>`));
      const b = h(`<button type="button" class="primary">Install GPU acceleration (~1.2 GB)</button>`);
      b.onclick = async () => {
        try { paint(await api("/gpu/install", { method: "POST" })); }
        catch (e) { toast(e.message, { error: true }); }
      };
      st.append(b);
      st.append(h(`<p class="small muted">Downloads NVIDIA's official cuBLAS and cuDNN packages from pypi.org and verifies their checksums.</p>`));
    }
    el.append(box);
  }
  const off = on("gpu_pack", (s) => {
    paint(s);
    if (s.state === "done") { toast("GPU acceleration installed."); loadStatus(); }
  });
  paint();
  return off;
}

// A conversation with one friend: text, voice notes, and words/folders they shared
// (each shared item has an "Add to my vocab" button, so this is also the sharing inbox).
//
// Messages disappear, Snapchat-style, so nothing piles up in storage: text is deleted for both
// people once the recipient has seen it and left the chat, a voice note once it has been
// played, shared words once added or dismissed, and anything unopened after 30 days.

import { api, h, toast } from "../app.js";
import * as social from "../social.js";

const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Copy shared words into this device's vocab (in a new folder when they came as one). */
async function addShared(payload) {
  let folderUid = null;
  if (payload.folder) {
    const existing = (await api("/vocab/folders")).find((f) => f.name === payload.folder);
    folderUid = existing ? existing.uid : (await api("/vocab/folders", { method: "POST", body: { name: payload.folder } })).uid;
  }
  const ids = [];
  for (const w of payload.words || []) {
    const v = await api("/vocab", { method: "POST", body: { text: w.text, meaning: w.meaning || "", notes: w.notes || "", sentence: w.sentence || "" } });
    ids.push(v.id);
  }
  if (folderUid && ids.length) await api("/vocab/bulk-folders", { method: "POST", body: { ids, add: [folderUid] } });
  return ids.length;
}

export async function render(view, { friendId }) {
  view.append(h(`<div class="chat">
    <div class="chat-head"><a class="btn ghost" href="#/friends" title="Back">←</a>
      <span class="avatar" id="chat-avatar"></span><strong id="chat-name">…</strong></div>
    <div class="chat-note small muted">👻 Messages disappear after they're seen · voice notes after they're played</div>
    <div class="chat-list" id="chat-list"><p class="muted" style="text-align:center">Loading…</p></div>
    <form class="chat-compose" id="compose">
      <button type="button" id="mic" title="Record a voice note (up to 2 minutes)">🎤</button>
      <input type="text" id="msg" placeholder="Message" autocomplete="off" maxlength="4000" dir="auto">
      <button type="submit" class="primary" id="send">Send</button>
    </form>
    <div class="chat-compose recording" id="rec" hidden>
      <span class="rec-dot"></span><span id="rec-time">0:00</span><span class="small muted">Recording…</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" id="rec-cancel">Cancel</button>
      <button type="button" class="primary" id="rec-send">Send voice note</button>
    </div>
  </div>`));
  const $ = (q) => view.querySelector(q);
  const list = $("#chat-list");
  let disposed = false;
  let me = null;
  let lastDay = "";
  const seen = new Set();
  const bubbles = new Map(); // message id -> element
  const player = new Audio();
  let playingBtn = null;
  player.addEventListener("ended", () => { if (playingBtn) playingBtn.textContent = playingBtn.dataset.label; playingBtn = null; });

  // Friend's name (only friends can be messaged; anyone else just sees an empty chat).
  social.sb().then((c) => c.from("profiles").select("username").eq("id", friendId).maybeSingle()).then(({ data }) => {
    if (disposed) return;
    const name = (data && data.username) || "Friend";
    $("#chat-name").textContent = name;
    $("#chat-avatar").textContent = name[0].toUpperCase();
  }).catch(() => {});

  function bubble(m) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const day = fmtDay(m.created_at);
    if (day !== lastDay) {
      lastDay = day;
      const d = h(`<div class="chat-day small muted"></div>`);
      d.textContent = day;
      list.append(d);
    }
    const mine = m.sender === me;
    const el = h(`<div class="msg ${mine ? "mine" : "theirs"}"><div class="msg-body"></div><div class="msg-meta small"></div></div>`);
    const body = el.querySelector(".msg-body");
    if (m.kind === "voice" && m.payload && m.payload.path) {
      const label = `▶ Voice note · ${fmtSecs(m.payload.seconds || 0)}`;
      const b = h(`<button type="button" class="voice-btn"></button>`);
      b.textContent = label;
      b.dataset.label = label;
      b.onclick = async () => {
        if (playingBtn === b) { player.pause(); b.textContent = label; playingBtn = null; return; }
        try {
          if (playingBtn) playingBtn.textContent = playingBtn.dataset.label;
          b.textContent = "Loading…";
          player.src = await social.voiceUrl(m.payload.path);
          await player.play();
          playingBtn = b;
          b.textContent = "❚❚ Playing…";
          // Heard: it disappears for both of you when you leave this chat.
          if (!mine) social.markSeen([m.id]).catch(() => {});
        } catch (e) {
          b.textContent = label;
          toast(`Couldn't play the voice note. ${e.message}`, { error: true });
        }
      };
      body.append(b);
    } else if (m.kind === "share" && m.payload) {
      const words = m.payload.words || [];
      const card = h(`<div class="share-card"><div class="share-title"></div><div class="share-words ar" dir="rtl"></div>
        <div class="share-action"></div></div>`);
      card.querySelector(".share-title").textContent = m.payload.folder
        ? `📁 ${m.payload.folder} · ${words.length} word${words.length === 1 ? "" : "s"}`
        : `★ ${words.length} word${words.length === 1 ? "" : "s"}`;
      card.querySelector(".share-words").textContent = words.slice(0, 6).map((w) => w.text).join(" · ") + (words.length > 6 ? " …" : "");
      const action = card.querySelector(".share-action");
      if (mine) {
        action.append(h(`<span class="small muted">Sent</span>`));
      } else {
        const add = h(`<button type="button" class="primary">Add to my vocab</button>`);
        const dismiss = h(`<button type="button" class="ghost">Dismiss</button>`);
        add.onclick = async () => {
          add.disabled = dismiss.disabled = true;
          add.textContent = "Adding…";
          try {
            const n = await addShared(m.payload);
            action.innerHTML = `<span class="small muted">✓ Added to your vocab</span>`;
            toast(`Added ${n} word${n === 1 ? "" : "s"}${m.payload.folder ? ` to the folder “${m.payload.folder}”` : ""}.`,
                  { action: { label: "View", run: () => (location.hash = "#/vocab") } });
            social.dismissMessage(m.id).catch(() => {}); // saved: the card is no longer needed online
          } catch (e) {
            add.disabled = dismiss.disabled = false;
            add.textContent = "Add to my vocab";
            toast(e.message, { error: true });
          }
        };
        dismiss.onclick = async () => {
          try { await social.dismissMessage(m.id); el.remove(); } catch (e) { toast(e.message, { error: true }); }
        };
        action.append(add, dismiss);
      }
      body.append(card);
    } else {
      const t = h(`<div class="msg-text" dir="auto"></div>`);
      t.textContent = m.body;
      body.append(t);
    }
    const meta = el.querySelector(".msg-meta");
    meta.textContent = fmtClock(m.created_at);
    if (mine) {
      const del = h(`<button type="button" class="msg-del" title="Unsend: delete this message for both of you">✕</button>`);
      del.onclick = async () => {
        if (!confirm("Unsend this message? It's deleted for both of you.")) return;
        try { await social.deleteMessage(m); el.remove(); } catch (e) { toast(e.message, { error: true }); }
      };
      meta.append(del);
    }
    bubbles.set(m.id, el);
    list.append(el);
  }
  /** Text counts as seen as soon as it's on screen here; voice notes when played. */
  const markShown = (messages) => {
    const ids = messages.filter((m) => m.recipient === me && m.kind === "text" && !m.read_at).map((m) => m.id);
    if (ids.length) social.markSeen(ids).catch(() => {});
  };
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  try {
    // What I saw last time is gone before anything is shown again.
    await social.clearSeen(friendId);
    social.purgeOldMessages().catch(() => {});
    const conv = await social.conversation(friendId);
    me = conv.me;
    list.innerHTML = "";
    if (!conv.messages.length) list.append(h(`<p class="muted chat-empty" style="text-align:center">No messages yet. Say مرحبا 👋</p>`));
    conv.messages.forEach(bubble);
    toBottom();
    markShown(conv.messages);
  } catch (e) {
    list.innerHTML = "";
    const p = h(`<p style="color:var(--danger);text-align:center"></p>`);
    p.textContent = e.message;
    list.append(p);
  }

  const off = await social.onMessage((m) => {
    if (disposed) return;
    const ours = (m.sender === friendId && m.recipient === me) || (m.sender === me && m.recipient === friendId);
    if (!ours) return;
    list.querySelector(".chat-empty")?.remove();
    bubble(m);
    toBottom();
    markShown([m]);
  }, (goneId) => {
    // The other person saw it (or unsent it): it disappears here too.
    const el = bubbles.get(goneId);
    if (el && !disposed) { el.classList.add("vanish"); setTimeout(() => el.remove(), 350); bubbles.delete(goneId); }
  });

  // ----- sending text -----
  $("#compose").onsubmit = async (e) => {
    e.preventDefault();
    const input = $("#msg");
    const text = input.value;
    if (!text.trim()) return;
    $("#send").disabled = true;
    try {
      const m = await social.sendText(friendId, text);
      input.value = "";
      list.querySelector(".chat-empty")?.remove();
      bubble(m);
      toBottom();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      $("#send").disabled = false;
      input.focus();
    }
  };

  // ----- voice notes -----
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let ticker = 0;
  let sendWhenStopped = false;

  function stopRecording(send) {
    sendWhenStopped = send;
    clearInterval(ticker);
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else cleanupRecording();
  }
  function cleanupRecording() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
    $("#rec").hidden = true;
    $("#compose").hidden = false;
  }

  $("#mic").onclick = async () => {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast("Voice notes aren't supported on this device.", { error: true });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("The app needs permission to use the microphone for voice notes.", { error: true });
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const seconds = (Date.now() - startedAt) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      cleanupRecording();
      if (!sendWhenStopped || disposed) return;
      if (seconds < 0.7 || !blob.size) { toast("That was too short to send."); return; }
      try {
        toast("Sending voice note…", { timeout: 1500 });
        const m = await social.sendVoice(friendId, blob, seconds);
        list.querySelector(".chat-empty")?.remove();
        bubble(m);
        toBottom();
      } catch (e) {
        toast(e.message, { error: true });
      }
    };
    startedAt = Date.now();
    recorder.start();
    $("#compose").hidden = true;
    $("#rec").hidden = false;
    $("#rec-time").textContent = "0:00";
    ticker = setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      $("#rec-time").textContent = fmtSecs(s);
      if (s >= social.VOICE_MAX_SECONDS) stopRecording(true);
    }, 250);
  };
  $("#rec-cancel").onclick = () => stopRecording(false);
  $("#rec-send").onclick = () => stopRecording(true);

  return () => {
    disposed = true;
    off();
    stopRecording(false);
    player.pause();
    social.clearSeen(friendId).catch(() => {}); // leaving the chat: what I've seen disappears
  };
}

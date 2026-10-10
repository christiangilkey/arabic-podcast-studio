// Settings section for the online features: connect with Google, choose/change a username.
// Shared by the desktop and Android settings pages.

import { esc, h, toast } from "../app.js";
import * as social from "../social.js";

export function accountSection() {
  const el = h(`<section class="card stack" id="social">
    <h2>Friends &amp; sharing (online)</h2>
    <p class="small muted">Optional. Connect to add friends by username, share words and folders, keep folders in
      sync with friends, and play live vocab quizzes together. This uses the same Google account as Drive sync.
      Your username, friend list and anything you share are stored on the app's online service (Supabase);
      everything else stays in your own Google Drive.</p>
    <div id="social-panel"><p class="small muted">Checking…</p></div>
  </section>`);
  const panel = el.querySelector("#social-panel");

  async function paint() {
    let profile = null;
    try {
      profile = await social.myProfile();
    } catch (e) {
      panel.innerHTML = "";
      const p = h(`<p class="small" style="color:var(--danger)"></p>`);
      p.textContent = e.message;
      const retry = h(`<button type="button">Try again</button>`);
      retry.onclick = paint;
      panel.append(p, retry);
      return;
    }
    if (!profile) {
      panel.innerHTML = `<div class="row"><button type="button" class="primary" id="acc-connect">Connect with Google</button>
        <span class="small muted">You'll pick a username next.</span></div>`;
      panel.querySelector("#acc-connect").onclick = async (e) => {
        e.target.disabled = true;
        e.target.textContent = "Connecting…";
        try {
          await social.connect();
          toast("Connected. Now choose a username.");
        } catch (err) {
          toast(err.message, { error: true });
        }
        paint();
      };
      return;
    }
    panel.innerHTML = `
      <div class="row"><span class="pill done">Connected</span> <strong>${esc(profile.email)}</strong>
        <span class="spacer"></span><button type="button" class="ghost danger" id="acc-disconnect">Disconnect</button></div>
      <form class="row" id="acc-form">
        <label for="acc-username">Username</label>
        <input id="acc-username" autocomplete="off" spellcheck="false" maxlength="20" style="width:200px"
          placeholder="e.g. layla_learns">
        <button type="submit" class="primary" id="acc-save">${profile.username ? "Change" : "Save"}</button>
        <span class="small" id="acc-hint"></span>
      </form>
      <p class="small muted">Friends find you by this name. ${esc(social.USERNAME_HELP)} You can change it any time;
        your friends and shares stay connected.</p>`;
    const input = panel.querySelector("#acc-username");
    const hint = panel.querySelector("#acc-hint");
    input.value = profile.username || "";
    if (!profile.username) input.focus();
    let timer;
    input.oninput = () => {
      clearTimeout(timer);
      const name = input.value.trim();
      hint.textContent = "";
      hint.style.color = "";
      if (!name || name === profile.username) return;
      const problem = social.checkUsername(name);
      if (problem) { hint.textContent = problem; hint.style.color = "var(--danger)"; return; }
      timer = setTimeout(async () => {
        try {
          const free = await social.usernameFree(name);
          if (input.value.trim() !== name) return;
          hint.textContent = free ? "✓ Available" : "Taken";
          hint.style.color = free ? "var(--accent)" : "var(--danger)";
        } catch { /* offline: the save will report it */ }
      }, 350);
    };
    panel.querySelector("#acc-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name === profile.username) return;
      try {
        await social.setUsername(name);
        toast(`Your username is now ${name}.`);
        paint();
      } catch (err) {
        hint.textContent = err.message;
        hint.style.color = "var(--danger)";
      }
    };
    panel.querySelector("#acc-disconnect").onclick = async () => {
      if (!confirm("Disconnect from friends & sharing on this device? Your username and friends are kept online.")) return;
      await social.disconnect();
      paint();
    };
  }

  paint();
  return el;
}

// First run on the phone: what the app does, then Google sign-in to bring in the library.

import { h, toast, saveSettings } from "../app.js";
import { signIn } from "../drive.js";
import { isNative } from "../native.js";
import { syncNow } from "../sync.js";

export async function render(view) {
  view.append(h(`<div class="welcome">
    <div class="hero"><img src="icons/icon-256.png" alt=""><div>
      <h1 style="margin:0">Tamkeen</h1>
      <p class="muted" style="margin:0">Your podcasts, transcripts and vocab, on your phone.</p></div></div>
    <div class="ar-sample">أَهْلًا وَسَهْلًا</div>
    <div class="card stack">
      <ol>
        <li><strong>Transcribe on your computer.</strong> The desktop app makes the word-by-word transcripts.</li>
        <li><strong>Sign in with the same Google account</strong> here and on your computer. Everything syncs through a
          private app folder in your own Google Drive.</li>
        <li><strong>Tap any word</strong> to hear it and see what it means in context. Long-press for more options.</li>
      </ol>
      <button type="button" class="primary" id="go">Sign in with Google</button>
      <button type="button" class="ghost" id="skip">Not now</button>
      ${isNative ? "" : `<p class="small muted">Preview mode: sign-in works in the installed app.</p>`}
    </div>
  </div>`));
  const finish = async () => { await saveSettings({ welcome_seen: true }); location.hash = "#/"; };
  view.querySelector("#go").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const email = await signIn();
      toast(`Signed in as ${email}. Bringing in your library…`);
      syncNow();
      await finish();
    } catch (err) {
      toast(err.message, { error: true });
      e.target.disabled = false;
    }
  };
  view.querySelector("#skip").onclick = finish;
}

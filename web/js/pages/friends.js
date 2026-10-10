// Friends: add people by username, answer requests, message friends, and see what each one
// is studying. Your own "What I'm studying" card is edited here and shown only on this tab.

import { esc, h, toast } from "../app.js";
import * as social from "../social.js";
import { studyCard, studyEditor } from "../components/studycard.js";

export async function render(view) {
  view.append(h(`<div class="page friends-page">
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Friends</h1><span class="muted" id="me"></span></div>
    <div id="body"><p class="muted">Loading…</p></div>
  </div>`));
  const body = view.querySelector("#body");
  let disposed = false;
  let editing = false;

  function personRow(entry, buttons, extra) {
    const row = h(`<div class="friend-row"><div class="friend-head">
      <span class="avatar"></span><span class="name"></span><span class="spacer"></span></div></div>`);
    const head = row.querySelector(".friend-head");
    row.querySelector(".avatar").textContent = (entry.user.username[0] || "?").toUpperCase();
    row.querySelector(".name").textContent = entry.user.username;
    for (const [label, cls, run] of buttons) {
      const b = h(`<button type="button" class="${cls}"></button>`);
      b.innerHTML = label;
      b.onclick = async () => {
        b.disabled = true;
        try { await run(); } catch (e) { toast(e.message, { error: true }); }
        load();
      };
      head.append(b);
    }
    if (extra) row.append(extra);
    return row;
  }

  async function load() {
    if (editing) return; // don't redraw (and lose typing) while the card editor is open
    let st;
    let mine = null;
    let cards = new Map();
    let unread = new Map();
    try {
      st = await social.friendsState();
      if (st && st.me.username) {
        [mine, cards, unread] = await Promise.all([
          social.myStatus(), social.statusesOf(st.friends.map((f) => f.user.id)), social.unreadCounts(),
        ]);
      }
    } catch (e) {
      if (disposed) return;
      body.innerHTML = "";
      const p = h(`<div class="card"><p style="color:var(--danger)"></p><button type="button">Try again</button></div>`);
      p.querySelector("p").textContent = e.message;
      p.querySelector("button").onclick = load;
      body.append(p);
      return;
    }
    if (disposed) return;
    body.innerHTML = "";
    if (!st) {
      body.append(h(`<div class="card stack empty-state">
        <h2>Learn together</h2>
        <p class="muted">Add friends by username, message each other (with voice notes), send words and folders,
          see what your friends are studying, and play live vocab quizzes. Connect your Google account in Settings to start.</p>
        <div><a class="btn primary" href="#/settings">Open Settings → Friends &amp; sharing</a></div>
      </div>`));
      return;
    }
    view.querySelector("#me").textContent = st.me.username ? `You are @${st.me.username}` : "";
    if (!st.me.username) {
      body.append(h(`<div class="card stack"><p>Pick a username first, so friends can find you.</p>
        <div><a class="btn primary" href="#/settings">Choose a username</a></div></div>`));
      return;
    }

    // ----- my card -----
    const my = h(`<section class="card stack"><div class="row"><h2 style="margin:0">What I'm studying</h2>
      <span class="spacer"></span><button type="button" class="ghost" id="edit-card">Edit</button></div>
      <div id="my-card"></div></section>`);
    const myBox = my.querySelector("#my-card");
    const card = studyCard(mine, { own: true });
    if (card) myBox.append(card);
    else myBox.append(h(`<p class="small muted">Nothing yet. Show your friends a podcast episode, a YouTube video or a
      Spotify song you're learning from, and add a short note.</p>`));
    my.querySelector("#edit-card").onclick = (e) => {
      editing = true;
      e.target.hidden = true;
      myBox.innerHTML = "";
      const editor = studyEditor(mine, () => { editing = false; load(); });
      const cancel = h(`<button type="button" class="ghost">Cancel</button>`);
      cancel.onclick = () => { editing = false; load(); };
      editor.querySelector("#se-save").after(cancel);
      myBox.append(editor);
    };
    body.append(my);

    // ----- add a friend -----
    const add = h(`<form class="card row add-friend">
      <label for="friend-name"><strong>Add a friend</strong></label>
      <input id="friend-name" placeholder="Their username" autocomplete="off" spellcheck="false" maxlength="21" style="flex:1;min-width:160px">
      <button type="submit" class="primary">Send request</button>
    </form>`);
    add.onsubmit = async (e) => {
      e.preventDefault();
      const input = add.querySelector("input");
      const btn = add.querySelector("button");
      btn.disabled = true;
      try {
        const r = await social.addFriend(input.value);
        toast(r.accepted ? `You and ${r.username} are now friends.` : `Request sent to ${r.username}.`);
        input.value = "";
        load();
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        btn.disabled = false;
      }
    };
    body.append(add);

    if (st.incoming.length) {
      const sec = h(`<section class="card stack"><h2>Friend requests <span class="badge">${st.incoming.length}</span></h2></section>`);
      for (const r of st.incoming) {
        sec.append(personRow(r, [
          ["Accept", "primary", () => social.acceptFriend(r.id).then(() => toast(`You and ${r.user.username} are now friends.`))],
          ["Decline", "ghost", () => social.removeFriendship(r.id)],
        ]));
      }
      body.append(sec);
    }

    // ----- friends -----
    const list = h(`<section class="card stack"><h2>Your friends <span class="muted small">${st.friends.length}</span></h2></section>`);
    if (!st.friends.length) {
      list.append(h(`<p class="small muted">No friends yet. Share your username, <strong>@${esc(st.me.username)}</strong>,
        or add someone above.</p>`));
    }
    for (const f of st.friends) {
      const n = unread.get(f.user.id) || 0;
      list.append(personRow(f, [
        [`💬 Message${n ? ` <span class="nav-count">${n}</span>` : ""}`, n ? "primary" : "", async () => { location.hash = `#/chat/${f.user.id}`; }],
        ["Remove", "ghost danger", async () => {
          if (!confirm(`Remove ${f.user.username} from your friends?`)) return;
          await social.removeFriendship(f.id);
        }],
      ], studyCard(cards.get(f.user.id))));
    }
    body.append(list);

    if (st.outgoing.length) {
      const sec = h(`<section class="card stack"><h2 class="small muted">Waiting for them to accept</h2></section>`);
      for (const r of st.outgoing) sec.append(personRow(r, [["Cancel", "ghost", () => social.removeFriendship(r.id)]]));
      body.append(sec);
    }
  }

  await load();
  // Live: requests, new messages and friends' cards appear without reloading.
  let timer;
  const off = await social.onActivity(() => { clearTimeout(timer); timer = setTimeout(load, 300); });
  return () => { disposed = true; off(); clearTimeout(timer); };
}

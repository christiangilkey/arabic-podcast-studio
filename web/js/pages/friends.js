// Friends: your profile (photo, "What I'm studying"), your guilds, and your friends. Add
// people by username, answer requests and guild invitations, message friends and guild-mates,
// and see who is online and what each one is studying.

import { esc, h, toast, showMenu } from "../app.js";
import * as social from "../social.js";
import { studyCard, studyEditor } from "../components/studycard.js";
import { avatar, tagChips } from "../components/avatar.js";

export async function render(view) {
  view.append(h(`<div class="page friends-page">
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Friends</h1></div>
    <div id="body"><p class="muted">Loading…</p></div>
    <input type="file" id="photo-file" accept="image/*" hidden>
  </div>`));
  const body = view.querySelector("#body");
  const photoInput = view.querySelector("#photo-file");
  let disposed = false;
  let editing = false; // true while a form is open: live updates must not redraw over typing

  /** One person: picture with online dot, name, guild tags, buttons, and their study card. */
  function personRow(user, { online = null, tags = [], buttons = [], extra = null, note = "" } = {}) {
    const row = h(`<div class="friend-row"><div class="friend-head"><span class="name"></span><span class="spacer"></span></div></div>`);
    const head = row.querySelector(".friend-head");
    head.prepend(avatar(user, { online }));
    row.querySelector(".name").textContent = user.username;
    if (tags.length) row.querySelector(".name").after(tagChips(tags));
    if (note) {
      const n = h(`<span class="small muted"></span>`);
      n.textContent = note;
      head.querySelector(".spacer").before(n);
    }
    for (const [label, cls, run] of buttons) {
      const b = h(`<button type="button" class="${cls}"></button>`);
      b.innerHTML = label;
      b.onclick = async () => {
        b.disabled = true;
        try { await run(b); } catch (e) { toast(e.message, { error: true }); }
        load();
      };
      head.append(b);
    }
    if (extra) row.append(extra);
    return row;
  }

  async function load() {
    if (editing) return;
    let st;
    let mine = null;
    let gs = { guilds: [], invites: [], sent: [] };
    let cards = new Map();
    let unread = new Map();
    let tags = new Map();
    let online = new Set();
    try {
      st = await social.friendsState();
      if (st && st.me.username) {
        gs = await social.guildsState();
        const everyone = [...new Set([st.me.id, ...st.friends.map((f) => f.user.id), ...gs.guilds.flatMap((g) => g.members.map((m) => m.id))])];
        [mine, cards, unread, tags, online] = await Promise.all([
          social.myStatus(), social.statusesOf(everyone.filter((id) => id !== st.me.id)), social.unreadCounts(),
          social.tagsOf(everyone), social.onlineAmong(everyone),
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
        <p class="muted">Add friends by username, form guilds, message each other (with voice notes), send words and
          folders, and see what everyone is studying. Connect your Google account in Settings to start.</p>
        <div><a class="btn primary" href="#/settings">Open Settings → Friends &amp; sharing</a></div>
      </div>`));
      return;
    }
    if (!st.me.username) {
      body.append(h(`<div class="card stack"><p>Pick a username first, so friends can find you.</p>
        <div><a class="btn primary" href="#/settings">Choose a username</a></div></div>`));
      return;
    }
    const friendIds = new Set(st.friends.map((f) => f.user.id));
    const pendingIds = new Set([...st.outgoing, ...st.incoming].map((r) => r.user.id));
    const messageButton = (userId) => {
      const n = unread.get(userId) || 0;
      return [`💬 Message${n ? ` <span class="nav-count">${n}</span>` : ""}`, n ? "primary" : "", async () => { location.hash = `#/chat/${userId}`; }];
    };

    // ----- me: photo, name, tags, and my card -----
    const me = h(`<section class="card stack me-card">
      <div class="me-head"><button type="button" class="me-photo" title="Change your profile photo"></button>
        <div class="me-id"><div class="me-name"></div><div class="small muted">Tap your picture to change it</div></div>
        <span class="spacer"></span>
        ${st.me.avatar_path ? `<button type="button" class="ghost small-btn" id="photo-remove">Remove photo</button>` : ""}
        <button type="button" class="ghost" id="edit-card">Edit what I'm studying</button></div>
      <div id="my-card"></div></section>`);
    me.querySelector(".me-photo").append(avatar(st.me, { online: true, large: true }));
    me.querySelector(".me-name").textContent = `@${st.me.username}`;
    if ((tags.get(st.me.id) || []).length) me.querySelector(".me-name").append(" ", tagChips(tags.get(st.me.id)));
    me.querySelector(".me-photo").onclick = () => photoInput.click();
    const removeBtn = me.querySelector("#photo-remove");
    if (removeBtn) {
      removeBtn.onclick = async () => {
        try { await social.removeAvatar(); toast("Photo removed."); } catch (e) { toast(e.message, { error: true }); }
        load();
      };
    }
    const myBox = me.querySelector("#my-card");
    const card = studyCard(mine, { own: true });
    if (card) myBox.append(card);
    else myBox.append(h(`<p class="small muted">Show your friends what you're learning from: a podcast episode, a YouTube
      video, a song, a film. Add a short note too.</p>`));
    me.querySelector("#edit-card").onclick = (e) => {
      editing = true;
      e.target.hidden = true;
      myBox.innerHTML = "";
      const editor = studyEditor(mine, () => { editing = false; load(); });
      const cancel = h(`<button type="button" class="ghost">Cancel</button>`);
      cancel.onclick = () => { editing = false; load(); };
      editor.querySelector("#se-save").after(cancel);
      myBox.append(editor);
    };
    body.append(me);

    // ----- things waiting for an answer -----
    if (st.incoming.length || gs.invites.length) {
      const sec = h(`<section class="card stack"><h2>Waiting for you <span class="badge">${st.incoming.length + gs.invites.length}</span></h2></section>`);
      for (const r of st.incoming) {
        sec.append(personRow(r.user, { note: "wants to be friends", buttons: [
          ["Accept", "primary", () => social.acceptFriend(r.id).then(() => toast(`You and ${r.user.username} are now friends.`))],
          ["Decline", "ghost", () => social.removeFriendship(r.id)],
        ] }));
      }
      for (const inv of gs.invites) {
        const row = h(`<div class="friend-row"><div class="friend-head"><span class="guild-badge"></span>
          <span class="name"></span><span class="small muted"></span><span class="spacer"></span></div></div>`);
        row.querySelector(".guild-badge").textContent = inv.guild.tag;
        row.querySelector(".name").textContent = inv.guild.name;
        row.querySelector(".muted").textContent = `${inv.inviter} invited you to this guild`;
        const head = row.querySelector(".friend-head");
        const accept = h(`<button type="button" class="primary">Join</button>`);
        accept.onclick = async () => {
          try { await social.acceptGuildInvite(inv.id); toast(`You joined ${inv.guild.name}.`); } catch (e) { toast(e.message, { error: true }); }
          load();
        };
        const decline = h(`<button type="button" class="ghost">Decline</button>`);
        decline.onclick = async () => { await social.declineGuildInvite(inv.id).catch(() => {}); load(); };
        head.append(accept, decline);
        sec.append(row);
      }
      body.append(sec);
    }

    // ----- guilds -----
    const guildsSec = h(`<section class="card stack"><div class="row"><h2 style="margin:0">Guilds <span class="muted small">${gs.guilds.length}</span></h2>
      <span class="spacer"></span><button type="button" id="new-guild">＋ New guild</button></div>
      <div id="guild-form"></div><div id="guild-list" class="stack"></div></section>`);
    const guildForm = (target, existing, done) => {
      editing = true;
      target.innerHTML = "";
      const f = h(`<form class="guild-form row">
        <input name="name" placeholder="Guild name" maxlength="40" required style="flex:1;min-width:160px" autocomplete="off">
        <input name="tag" placeholder="TAG" maxlength="5" required style="width:90px;text-transform:uppercase" autocomplete="off" title="${esc(social.GUILD_TAG_HELP)}">
        <button type="submit" class="primary">${existing ? "Save" : "Create"}</button>
        <button type="button" class="ghost" data-cancel>Cancel</button>
        <div class="small muted" style="flex-basis:100%">The tag appears beside members' names. ${esc(social.GUILD_TAG_HELP)}</div>
      </form>`);
      if (existing) { f.name.value = existing.name; f.tag.value = existing.tag; }
      f.querySelector("[data-cancel]").onclick = () => { editing = false; load(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const name = f.name.value.trim();
        const tag = f.tag.value.trim().toUpperCase();
        try {
          await done(name, tag);
          editing = false;
          load();
        } catch (err) { toast(err.message, { error: true }); }
      };
      target.append(f);
      f.name.focus();
    };
    guildsSec.querySelector("#new-guild").onclick = () => guildForm(guildsSec.querySelector("#guild-form"), null,
      async (name, tag) => { await social.createGuild(name, tag); toast(`Guild “${name}” created. Invite your friends!`); });
    const guildList = guildsSec.querySelector("#guild-list");
    if (!gs.guilds.length) {
      guildList.append(h(`<p class="small muted">A guild is a group of friends with its own name and tag. Everyone in it sees
        each other here, with what they're studying, and can message each other. Create one, or wait for an invitation.</p>`));
    }
    for (const g of gs.guilds) {
      const box = h(`<div class="guild">
        <div class="guild-head"><span class="guild-badge"></span><strong class="guild-name"></strong>
          <span class="small muted">${g.members.length} member${g.members.length === 1 ? "" : "s"}${g.mine ? " · you founded it" : ""}</span>
          <span class="spacer"></span></div>
        <div class="guild-edit"></div><div class="guild-members"></div></div>`);
      box.querySelector(".guild-badge").textContent = g.tag;
      box.querySelector(".guild-name").textContent = g.name;
      const head = box.querySelector(".guild-head");
      const invite = h(`<button type="button">＋ Invite a friend</button>`);
      invite.onclick = (e) => {
        const memberIds = new Set(g.members.map((m) => m.id));
        const invited = new Set(gs.sent.filter((s) => s.guild_id === g.id).map((s) => s.invitee));
        const choices = st.friends.filter((f) => !memberIds.has(f.user.id));
        if (!choices.length) {
          toast(st.friends.length ? "All your friends are already in this guild." : "Add a friend first, then invite them.");
          return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, `Invite to ${g.name}`, choices.map((f) => ({
          label: `@${f.user.username}${invited.has(f.user.id) ? " (invited)" : ""}`,
          run: async () => {
            try { await social.inviteToGuild(g.id, f.user.id); toast(`Invited ${f.user.username} to ${g.name}.`); } catch (err) { toast(err.message, { error: true }); }
            load();
          },
        })));
      };
      head.append(invite);
      if (g.mine) {
        const edit = h(`<button type="button" class="ghost">Rename</button>`);
        edit.onclick = () => guildForm(box.querySelector(".guild-edit"), g, (name, tag) => social.updateGuild(g.id, { name, tag }));
        head.append(edit);
      }
      const leave = h(`<button type="button" class="ghost danger">Leave</button>`);
      leave.onclick = async () => {
        const last = g.members.length === 1;
        if (!confirm(last ? `Leave “${g.name}”? You're the only member, so the guild will be closed.`
          : `Leave “${g.name}”?${g.mine ? " The longest-standing member becomes its founder." : ""}`)) return;
        try { await social.leaveGuild(g.id); } catch (err) { toast(err.message, { error: true }); }
        load();
      };
      head.append(leave);
      const members = box.querySelector(".guild-members");
      for (const m of g.members) {
        if (m.id === st.me.id) continue;
        const buttons = [messageButton(m.id)];
        if (!friendIds.has(m.id)) {
          buttons.push(pendingIds.has(m.id) ? ["Request pending", "ghost", async (b) => { b.disabled = true; }]
            : ["＋ Add friend", "", () => social.addFriend(m.username).then((r) => toast(r.accepted ? `You and ${r.username} are now friends.` : `Request sent to ${r.username}.`))]);
        }
        if (g.mine) {
          buttons.push(["Remove", "ghost danger", async () => {
            if (!confirm(`Remove ${m.username} from ${g.name}?`)) return;
            await social.removeGuildMember(g.id, m.id);
          }]);
        }
        members.append(personRow(m, { online: online.has(m.id), tags: (tags.get(m.id) || []).filter((t) => t !== g.tag),
                                      note: m.id === g.owner ? "founder" : "", buttons, extra: studyCard(cards.get(m.id)) }));
      }
      if (g.members.length === 1) members.append(h(`<p class="small muted">Just you so far. Invite a friend to get it going.</p>`));
      guildList.append(box);
    }
    body.append(guildsSec);

    // ----- friends -----
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

    const onlineCount = st.friends.filter((f) => online.has(f.user.id)).length;
    const list = h(`<section class="card stack"><h2>Your friends <span class="muted small">${st.friends.length}${st.friends.length ? ` · ${onlineCount} online` : ""}</span></h2></section>`);
    if (!st.friends.length) {
      list.append(h(`<p class="small muted">No friends yet. Share your username, <strong>@${esc(st.me.username)}</strong>,
        or add someone above.</p>`));
    }
    // Online friends first, then by name.
    const sorted = [...st.friends].sort((a, b) => (online.has(b.user.id) - online.has(a.user.id)) || a.user.username.localeCompare(b.user.username));
    for (const f of sorted) {
      list.append(personRow(f.user, { online: online.has(f.user.id), tags: tags.get(f.user.id) || [], buttons: [
        messageButton(f.user.id),
        ["Remove", "ghost danger", async () => {
          if (!confirm(`Remove ${f.user.username} from your friends?`)) return;
          await social.removeFriendship(f.id);
        }],
      ], extra: studyCard(cards.get(f.user.id)) }));
    }
    body.append(list);

    if (st.outgoing.length) {
      const sec = h(`<section class="card stack"><h2 class="small muted">Waiting for them to accept</h2></section>`);
      for (const r of st.outgoing) sec.append(personRow(r.user, { buttons: [["Cancel", "ghost", () => social.removeFriendship(r.id)]] }));
      body.append(sec);
    }
  }

  photoInput.onchange = async () => {
    const file = photoInput.files[0];
    photoInput.value = "";
    if (!file) return;
    try {
      toast("Uploading your photo…", { timeout: 1500 });
      await social.uploadAvatar(file);
      toast("Profile photo updated.");
    } catch (e) {
      toast(e.message, { error: true });
    }
    load();
  };

  await load();
  // Live: requests, invitations, messages, cards and guild changes appear without reloading;
  // online dots refresh every minute.
  let timer;
  const off = await social.onActivity(() => { clearTimeout(timer); timer = setTimeout(load, 300); });
  const tick = setInterval(load, 60000);
  return () => { disposed = true; off(); clearTimeout(timer); clearInterval(tick); };
}

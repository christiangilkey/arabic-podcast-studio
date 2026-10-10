// Online features (username, friends, sharing, shared folders, live quiz) through Supabase.
//
// Everything else stays in the user's own Google Drive. Signing in reuses the Google account
// the app already uses for Drive sync: the platform shell (app.js) supplies a Google ID token,
// which Supabase checks against the app's Google client IDs. Data is protected by the
// row-level security rules in supabase/schema.sql; the key below is public by design.

import { googleIdToken } from "./app.js";

export const SUPABASE_URL = "https://ktzgcohmgmbccvegwxqz.supabase.co";
const SUPABASE_KEY = "sb_publishable_VttMCOKQYH9FL-kekzhqmg_w9qXTkxt";
export const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
export const USERNAME_HELP = "3–20 letters, numbers, dots or underscores.";

let client = null;
let loading = null;

function loadLibrary() {
  if (window.supabase) return Promise.resolve();
  loading = loading || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("./vendor/supabase.js", import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error("Couldn't load the online features.")); };
    document.head.append(s);
  });
  return loading;
}

/** The Supabase client (created on first use). */
export async function sb() {
  if (!client) {
    await loadLibrary();
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "aps-social-auth", detectSessionInUrl: false },
    });
  }
  return client;
}

function friendly(error) {
  const msg = (error && (error.message || error.error_description)) || String(error);
  if (/fetch|network|Failed to/i.test(msg)) return "Couldn't reach the online service. Check your internet connection.";
  return msg;
}

/** The signed-in user, or null. Never throws (offline just means "not available right now"). */
export async function currentUser() {
  try {
    const { data } = await (await sb()).auth.getSession();
    return data.session ? data.session.user : null;
  } catch {
    return null;
  }
}

/** Sign in to the online features with the app's Google account. */
export async function connect() {
  const c = await sb();
  const { token, nonce } = await googleIdToken();
  const { data, error } = await c.auth.signInWithIdToken({ provider: "google", token, ...(nonce ? { nonce } : {}) });
  if (error) throw new Error(friendly(error));
  return data.user;
}

export async function disconnect() {
  const c = await sb();
  await c.auth.signOut().catch(() => {});
}

/** {id, username, email} of the signed-in user; creates the profile row if it's missing. */
export async function myProfile() {
  const c = await sb();
  const user = await currentUser();
  if (!user) return null;
  let { data, error } = await c.from("profiles").select("id, username, avatar_path").eq("id", user.id).maybeSingle();
  if (error) throw new Error(friendly(error));
  if (!data) {
    const ins = await c.from("profiles").insert({ id: user.id }).select("id, username, avatar_path").single();
    if (ins.error) throw new Error(friendly(ins.error));
    data = ins.data;
  }
  return { ...data, email: user.email || "" };
}

export function checkUsername(name) {
  if (!USERNAME_RE.test(name)) return `Usernames are ${USERNAME_HELP.toLowerCase()}`;
  return "";
}

/** True when nobody else has this username (case doesn't matter). */
export async function usernameFree(name) {
  const c = await sb();
  const user = await currentUser();
  // username is case-insensitive text (citext), so "eq" ignores case.
  const { data, error } = await c.from("profiles").select("id").eq("username", name).limit(1);
  if (error) throw new Error(friendly(error));
  return !data.length || (user && data[0].id === user.id);
}

export async function setUsername(name) {
  const problem = checkUsername(name);
  if (problem) throw new Error(problem);
  const c = await sb();
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const { error } = await c.from("profiles").update({ username: name }).eq("id", user.id);
  if (error) {
    if (error.code === "23505") throw new Error(`“${name}” is taken. Try another.`);
    throw new Error(friendly(error));
  }
}

// ---------------------------------------------------------------- friends

/** {me, friends, incoming, outgoing}: each entry {id: friendship id, user: {id, username}, since}. */
export async function friendsState() {
  const c = await sb();
  const me = await myProfile();
  if (!me) return null;
  const { data: rows, error } = await c.from("friendships").select("id, requester, addressee, status, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(friendly(error));
  const otherIds = [...new Set(rows.map((r) => (r.requester === me.id ? r.addressee : r.requester)))];
  const names = new Map();
  const photos = new Map();
  if (otherIds.length) {
    const { data: people, error: e2 } = await c.from("profiles").select("id, username, avatar_path").in("id", otherIds);
    if (e2) throw new Error(friendly(e2));
    for (const p of people) { names.set(p.id, p.username || "(no username yet)"); photos.set(p.id, p.avatar_path || null); }
  }
  const entry = (r) => {
    const other = r.requester === me.id ? r.addressee : r.requester;
    return { id: r.id, user: { id: other, username: names.get(other) || "(unknown)", avatar_path: photos.get(other) || null },
             since: r.created_at };
  };
  const friends = rows.filter((r) => r.status === "accepted").map(entry)
    .sort((a, b) => a.user.username.localeCompare(b.user.username));
  const incoming = rows.filter((r) => r.status === "pending" && r.addressee === me.id).map(entry);
  const outgoing = rows.filter((r) => r.status === "pending" && r.requester === me.id).map(entry);
  return { me, friends, incoming, outgoing };
}

/** Send a friend request by username. If they already asked you, this accepts theirs. */
export async function addFriend(username) {
  const name = username.trim().replace(/^@/, "");
  if (!name) throw new Error("Type your friend's username.");
  const c = await sb();
  const me = await myProfile();
  if (!me) throw new Error("Connect first (Settings → Friends & sharing).");
  if (!me.username) throw new Error("Choose your own username first (Settings → Friends & sharing).");
  const { data: found, error } = await c.from("profiles").select("id, username").eq("username", name).limit(1);
  if (error) throw new Error(friendly(error));
  if (!found.length) throw new Error(`Nobody is called “${name}”. Usernames are exact (but not case-sensitive).`);
  const them = found[0];
  if (them.id === me.id) throw new Error("That's you!");
  const { data: existing } = await c.from("friendships").select("id, requester, status")
    .or(`and(requester.eq.${me.id},addressee.eq.${them.id}),and(requester.eq.${them.id},addressee.eq.${me.id})`);
  const prior = existing && existing[0];
  if (prior) {
    if (prior.status === "accepted") throw new Error(`You and ${them.username} are already friends.`);
    if (prior.requester === me.id) throw new Error(`You already sent ${them.username} a request.`);
    await acceptFriend(prior.id);
    return { accepted: true, username: them.username };
  }
  const { error: e2 } = await c.from("friendships").insert({ requester: me.id, addressee: them.id });
  if (e2) throw new Error(e2.code === "23505" ? `You and ${them.username} already have a request pending.` : friendly(e2));
  return { accepted: false, username: them.username };
}

export async function acceptFriend(friendshipId) {
  const { error } = await (await sb()).rpc("accept_friend", { request_id: friendshipId });
  if (error) throw new Error(friendly(error));
}

/** Decline a request, cancel your own, or unfriend. */
export async function removeFriendship(friendshipId) {
  const { error } = await (await sb()).from("friendships").delete().eq("id", friendshipId);
  if (error) throw new Error(friendly(error));
}

// ---------------------------------------------------------------- live updates + badge

/** Call `handler` whenever friend requests, messages, status cards or quiz invites change. Returns an unsubscribe. */
export async function onActivity(handler) {
  const user = await currentUser();
  if (!user) return () => {};
  const c = await sb();
  const channel = c.channel(`activity-${user.id}-${Math.random().toString(36).slice(2, 8)}`);
  for (const table of ["friendships", "messages", "game_invites", "statuses", "guild_members", "guild_invites", "guilds"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, () => handler(table));
  }
  channel.subscribe();
  return () => { c.removeChannel(channel); };
}

/** Things waiting for you: friend requests, unread messages (incl. shared words), quiz invites. */
export async function pendingCount() {
  const user = await currentUser();
  if (!user) return 0;
  const c = await sb();
  const counts = await Promise.all([
    c.from("friendships").select("id", { count: "exact", head: true }).eq("addressee", user.id).eq("status", "pending"),
    c.from("messages").select("id", { count: "exact", head: true }).eq("recipient", user.id).is("read_at", null),
    c.from("game_invites").select("id", { count: "exact", head: true }).eq("invitee", user.id),
    c.from("guild_invites").select("id", { count: "exact", head: true }).eq("invitee", user.id),
  ]);
  return counts.reduce((n, r) => n + (r.count || 0), 0);
}

let badgeStarted = false;
/** Keep the number on the Friends tab up to date (call once at startup). */
export function startBadge() {
  if (badgeStarted) return;
  badgeStarted = true;
  const paint = async () => {
    const n = await pendingCount().catch(() => 0);
    document.querySelectorAll('[data-nav="friends"] .nav-count').forEach((el) => {
      el.textContent = n ? String(n) : "";
      el.hidden = !n;
    });
  };
  let off = () => {};
  const watch = async () => { off(); off = await onActivity(paint).catch(() => () => {}); paint(); };
  sb().then((c) => c.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "INITIAL_SESSION") setTimeout(watch, 0);
    if (event === "SIGNED_IN") setTimeout(() => heartbeat(true), 0);
  })).catch(() => {});
  setInterval(paint, 120000);
  // "I'm here": while the app is in use, about once a minute; "gone" as soon as it's put away.
  const beat = () => { if (document.visibilityState !== "hidden") heartbeat(true); };
  setInterval(beat, 60000);
  setTimeout(beat, 1500);
  document.addEventListener("visibilitychange", () => heartbeat(document.visibilityState !== "hidden"));
  window.addEventListener("pagehide", () => heartbeat(false));
}

// ---------------------------------------------------------------- "What I'm studying" cards

const YOUTUBE_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
const SPOTIFY_HOST = "open.spotify.com";
const APPLE_HOST = "music.apple.com";
const IMDB_HOSTS = ["www.imdb.com", "imdb.com", "m.imdb.com"];
export const MAX_STUDY_ITEMS = 3;

/** The kinds of links a "What I'm studying" bar accepts (shown in the editor's help). */
export const LINK_TYPES = [
  ["▶ YouTube", "a video or a YouTube Music song", "https://www.youtube.com/watch?v=…  or  https://youtu.be/…"],
  ["♫ Spotify", "a song, album, playlist or podcast episode (Share → Copy link)", "https://open.spotify.com/track/…"],
  ["♪ Apple Music", "a song, album or playlist (Share → Copy Link)", "https://music.apple.com/…/album/…"],
  ["🎬 IMDb", "a film, series or person page", "https://www.imdb.com/title/tt…"],
  ["🎧 Podcast episode", "any episode from your own library: use the 🎧 button on the bar", ""],
];

function httpsUrl(text) {
  try {
    const u = new URL(text.trim());
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Only https links (and nothing else) are ever shown or opened from a friend's card. */
export function safeUrl(text) {
  const u = typeof text === "string" ? httpsUrl(text) : null;
  return u ? u.href : "";
}

/** Spotify's official mini-player address for a track/album/playlist/episode link, or "". */
export function spotifyEmbedUrl(link) {
  const u = httpsUrl(link || "");
  if (!u || u.hostname !== SPOTIFY_HOST) return "";
  const m = u.pathname.match(/\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : "";
}

/** Apple Music's official mini-player address for a song/album/playlist link, or "". */
export function appleEmbedUrl(link) {
  const u = httpsUrl(link || "");
  if (!u || u.hostname !== APPLE_HOST || !/\/(album|song|playlist)\//.test(u.pathname)) return "";
  return `https://embed.music.apple.com${u.pathname}${u.searchParams.get("i") ? `?i=${encodeURIComponent(u.searchParams.get("i"))}` : ""}`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function previewApple(u) {
  const country = (u.pathname.match(/^\/([a-z]{2})\//) || [])[1] || "us";
  const id = u.searchParams.get("i") || (u.pathname.match(/\/(\d+)\/?$/) || [])[1];
  if (id) {
    // Apple's public catalogue lookup gives the song name and artist.
    const data = await getJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${country}`).catch(() => null);
    const r = data && data.results && data.results[0];
    if (r) {
      return { kind: "apple", url: u.href, title: String(r.trackName || r.collectionName || "Apple Music").slice(0, 200),
               subtitle: String(r.artistName || "Apple Music").slice(0, 120),
               image: safeUrl(String(r.artworkUrl100 || "").replace("100x100bb", "300x300bb")) };
    }
  }
  const data = await getJson(`https://music.apple.com/api/oembed?url=${encodeURIComponent(u.href)}`);
  return { kind: "apple", url: u.href, title: String(data.title || "Apple Music").slice(0, 200),
           subtitle: String(data.author_name || "Apple Music").slice(0, 120), image: safeUrl(data.thumbnail_url || "") };
}

async function previewImdb(u) {
  const id = (u.pathname.match(/\/(?:title|name)\/((?:tt|nm)\d+)/) || [])[1];
  if (!id) throw new Error("bad link");
  // IMDb's public search-suggestion service: title, year, main cast and poster.
  const data = await getJson(`https://v3.sg.media-imdb.com/suggestion/x/${id}.json`);
  const r = (data.d || []).find((x) => x.id === id);
  if (!r) throw new Error("not found");
  const poster = r.i && r.i.imageUrl ? String(r.i.imageUrl).replace(/\._V1_.*\.jpg$/, "._V1_UX300_.jpg") : "";
  return { kind: "imdb", url: `https://www.imdb.com/${id.startsWith("nm") ? "name" : "title"}/${id}/`,
           title: String(r.l || "IMDb").slice(0, 200),
           subtitle: [r.y, r.q, r.s].filter(Boolean).join(" · ").slice(0, 160), image: safeUrl(poster) };
}

/** Turn a pasted YouTube, Spotify, Apple Music or IMDb link into a card
 * {kind, url, title, subtitle, image}, using the sites' public preview services (no keys). */
export async function previewLink(text) {
  const u = httpsUrl(text || "");
  if (!u) throw new Error("Paste a link that starts with https://");
  let kind;
  let endpoint;
  if (u.hostname === APPLE_HOST || IMDB_HOSTS.includes(u.hostname)) {
    const apple = u.hostname === APPLE_HOST;
    try {
      return await (apple ? previewApple(u) : previewImdb(u));
    } catch {
      throw new Error(`Couldn't find that on ${apple ? "Apple Music" : "IMDb"}. Check the link.`);
    }
  }
  if (YOUTUBE_HOSTS.includes(u.hostname)) {
    kind = "youtube";
    endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`;
  } else if (u.hostname === SPOTIFY_HOST) {
    kind = "spotify";
    endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(u.href)}`;
  } else {
    throw new Error("That kind of link isn't supported. Use YouTube, Spotify, Apple Music or IMDb.");
  }
  let data;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    throw new Error(`Couldn't find that on ${kind === "youtube" ? "YouTube" : "Spotify"}. Check the link.`);
  }
  return {
    kind,
    url: u.href,
    title: String(data.title || "").slice(0, 200) || (kind === "youtube" ? "YouTube video" : "Spotify"),
    subtitle: String(data.author_name || (kind === "spotify" ? "Spotify" : "")).slice(0, 120),
    image: safeUrl(data.thumbnail_url || ""),
  };
}

/** A card's items as a clean list (older cards stored a single item). Blank ones are dropped. */
export function studyItems(studying) {
  const list = Array.isArray(studying) ? studying : studying ? [studying] : [];
  return list.filter((x) => x && typeof x === "object" && x.kind && x.title).slice(0, MAX_STUDY_ITEMS);
}

/** My own card: {studying, message}. */
export async function myStatus() {
  const c = await sb();
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await c.from("statuses").select("studying, message").eq("user_id", user.id).maybeSingle();
  if (error) throw new Error(friendly(error));
  return data || { studying: null, message: "" };
}

export async function setStatus({ studying, message }) {
  const c = await sb();
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const items = studyItems(studying);
  const row = { user_id: user.id, studying: items.length ? items : null, message: (message || "").trim().slice(0, 300) };
  const { error } = await c.from("statuses").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(friendly(error));
}

/** Cards of the given friends: Map(user id -> {studying, message, updated_at}). */
export async function statusesOf(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const { data, error } = await (await sb()).from("statuses").select("user_id, studying, message, updated_at").in("user_id", userIds);
  if (error) throw new Error(friendly(error));
  for (const r of data) out.set(r.user_id, r);
  return out;
}

// ---------------------------------------------------------------- messages, voice notes, shared words

export const VOICE_MAX_SECONDS = 120;
const conversationFolder = (a, b) => [a, b].sort().join("_");

/** Unread message counts: Map(friend id -> n). */
export async function unreadCounts() {
  const user = await currentUser();
  const out = new Map();
  if (!user) return out;
  const { data, error } = await (await sb()).from("messages").select("sender").eq("recipient", user.id).is("read_at", null);
  if (error) throw new Error(friendly(error));
  for (const r of data) out.set(r.sender, (out.get(r.sender) || 0) + 1);
  return out;
}

/** The latest messages with a friend, oldest first. */
export async function conversation(friendId, limit = 200) {
  const c = await sb();
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const { data, error } = await c.from("messages").select("id, sender, recipient, kind, body, payload, created_at, read_at")
    .or(`and(sender.eq.${user.id},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${user.id})`)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(friendly(error));
  return { me: user.id, messages: data.reverse() };
}

async function insertMessage(friendId, fields) {
  const c = await sb();
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const { data, error } = await c.from("messages").insert({ sender: user.id, recipient: friendId, ...fields })
    .select("id, sender, recipient, kind, body, payload, created_at, read_at").single();
  if (error) {
    throw new Error(error.code === "42501" ? "You can only message people on your friends list." : friendly(error));
  }
  return data;
}

export function sendText(friendId, text) {
  const body = text.trim();
  if (!body) throw new Error("Type a message first.");
  return insertMessage(friendId, { kind: "text", body: body.slice(0, 4000) });
}

/** Upload a recorded voice note, then send it as a message. */
export async function sendVoice(friendId, blob, seconds) {
  const c = await sb();
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const type = (blob.type || "audio/webm").split(";")[0];
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
  const path = `${conversationFolder(user.id, friendId)}/${crypto.randomUUID()}.${ext}`;
  const { error } = await c.storage.from("voice").upload(path, blob, { contentType: type });
  if (error) throw new Error(`Couldn't send the voice note: ${friendly(error)}`);
  return insertMessage(friendId, { kind: "voice", payload: { path, seconds: Math.round(seconds) } });
}

/** A temporary private link to play a voice note. */
export async function voiceUrl(path) {
  const { data, error } = await (await sb()).storage.from("voice").createSignedUrl(path, 3600);
  if (error) throw new Error(friendly(error));
  return data.signedUrl;
}

export const MAX_SHARE_CLIPS = 80;

/** Upload the audio clip that travels with a shared word. Resolves to its storage path. */
export async function uploadClip(friendId, blob) {
  const c = await sb();
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const path = `${conversationFolder(user.id, friendId)}/clip-${crypto.randomUUID()}.ogg`;
  const { error } = await c.storage.from("voice").upload(path, blob, { contentType: "audio/ogg" });
  if (error) throw new Error(friendly(error));
  return path;
}

/** Download a clip that came with a shared word. */
export async function downloadClip(path) {
  const { data, error } = await (await sb()).storage.from("voice").download(path);
  if (error) throw new Error(friendly(error));
  return data;
}

/** Delete the clips of a share from online storage (once added, dismissed or unsent). */
export function removeShareClips(payload) {
  return removeVoiceFiles(((payload && payload.words) || []).map((w) => w.clip));
}

/** Send copies of vocab words (optionally as a named folder) to a friend. A word may carry
 * `clip` (the storage path of its audio) and `times` (word and sentence positions in it). */
export function sendShare(friendId, { folder = null, words }) {
  const num = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : 0);
  const clean = words.slice(0, 500).map((w) => ({
    text: String(w.text || "").slice(0, 300), meaning: String(w.meaning || "").slice(0, 2000),
    notes: String(w.notes || "").slice(0, 4000), sentence: String(w.sentence || "").slice(0, 2000),
    episode_title: String(w.episode_title || "").slice(0, 300),
    ...(w.clip && w.times ? { clip: String(w.clip).slice(0, 300), times: {
      start: num(w.times.start), end: num(w.times.end), sent_start: num(w.times.sent_start), sent_end: num(w.times.sent_end) } } : {}),
  })).filter((w) => w.text);
  if (!clean.length) throw new Error("There's nothing to share.");
  return insertMessage(friendId, { kind: "share", payload: { folder: folder ? String(folder).slice(0, 80) : null, words: clean } });
}

// Messages disappear, Snapchat-style: text once the recipient has seen it and left the chat,
// voice notes once played, shared words once added or dismissed, everything after 30 days.

async function removeVoiceFiles(paths) {
  const list = (paths || []).filter(Boolean);
  if (list.length) await (await sb()).storage.from("voice").remove(list).catch(() => {});
}

/** Mark messages as seen (they are deleted the next time `clearSeen` runs). */
export async function markSeen(ids) {
  if (ids.length) await (await sb()).rpc("mark_seen", { ids });
}

/** Delete everything from this friend that I've already seen (and its voice files). */
export async function clearSeen(friendId) {
  const { data, error } = await (await sb()).rpc("clear_seen", { friend: friendId });
  if (!error) await removeVoiceFiles(data);
}

/** Remove one message sent to me (a shared-words card I've added or dismissed). */
export async function dismissMessage(id) {
  const { data, error } = await (await sb()).rpc("dismiss_message", { message_id: id });
  if (error) throw new Error(friendly(error));
  await removeVoiceFiles(data);
}

/** Clear anything older than 30 days from my conversations. */
export async function purgeOldMessages() {
  const { data, error } = await (await sb()).rpc("purge_old_messages");
  if (!error) await removeVoiceFiles(data);
}

/** Unsend one of my own messages. */
export async function deleteMessage(message) {
  if (message.kind === "voice" && message.payload) await removeVoiceFiles([message.payload.path]);
  if (message.kind === "share") await removeShareClips(message.payload);
  const { error } = await (await sb()).from("messages").delete().eq("id", message.id);
  if (error) throw new Error(friendly(error));
}

/** Call `handler(message)` for each new message to or from me, and `onGone(id)` when one is
 * deleted (seen by the other person, or unsent). Returns an unsubscribe. */
export async function onMessage(handler, onGone = () => {}) {
  const user = await currentUser();
  if (!user) return () => {};
  const c = await sb();
  const channel = c.channel(`messages-${user.id}-${Math.random().toString(36).slice(2, 8)}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (e) => handler(e.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (e) => onGone(e.old && e.old.id))
    .subscribe();
  return () => { c.removeChannel(channel); };
}

// ---------------------------------------------------------------- profile photos

const AVATAR_SIZE = 256;

/** Public address of a profile photo ("" when the person has none). */
export function avatarUrl(path) {
  return path ? `${SUPABASE_URL}/storage/v1/object/public/avatars/${String(path).split("/").map(encodeURIComponent).join("/")}` : "";
}

/** Crop a picture to a centred square and shrink it: a small file whatever was chosen. */
async function squarePhoto(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't a picture the app can read. Try a JPG or PNG.");
  }
  const side = Math.min(source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  canvas.getContext("2d").drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const blob = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
  return (await blob("image/webp")) || (await blob("image/jpeg"));
}

/** Set my profile photo from a picture file. Resolves to the new avatar path. */
export async function uploadAvatar(file) {
  const c = await sb();
  const me = await myProfile();
  if (!me) throw new Error("Connect first.");
  const photo = await squarePhoto(file);
  if (!photo) throw new Error("Couldn't prepare that picture.");
  const path = `${me.id}/${Date.now()}.${photo.type === "image/webp" ? "webp" : "jpg"}`;
  const up = await c.storage.from("avatars").upload(path, photo, { contentType: photo.type, cacheControl: "31536000" });
  if (up.error) throw new Error(`Couldn't upload the picture: ${friendly(up.error)}`);
  const { error } = await c.from("profiles").update({ avatar_path: path }).eq("id", me.id);
  if (error) throw new Error(friendly(error));
  if (me.avatar_path) c.storage.from("avatars").remove([me.avatar_path]).catch(() => {});
  return path;
}

export async function removeAvatar() {
  const c = await sb();
  const me = await myProfile();
  if (!me || !me.avatar_path) return;
  const { error } = await c.from("profiles").update({ avatar_path: null }).eq("id", me.id);
  if (error) throw new Error(friendly(error));
  c.storage.from("avatars").remove([me.avatar_path]).catch(() => {});
}

// ---------------------------------------------------------------- online / offline

export const ONLINE_WITHIN_SECONDS = 150;

/** Tell the service this device is in use (or, with false, that it just stopped being). */
export async function heartbeat(online = true) {
  if (!(await currentUser())) return;
  await (await sb()).rpc("heartbeat", { online }).then(() => {}, () => {});
}

/** Who of these people is online right now: Set of user ids. */
export async function onlineAmong(userIds) {
  const out = new Set();
  if (!userIds.length) return out;
  const { data, error } = await (await sb()).rpc("seen_ago", { people: userIds });
  if (error) return out;
  for (const r of data) if (r.seconds !== null && r.seconds < ONLINE_WITHIN_SECONDS) out.add(r.user_id);
  return out;
}

// ---------------------------------------------------------------- guilds
// A guild has a name, a short tag shown beside its members' names, and up to 50 members. You
// can be in any number of guilds. Any member can invite their own friends; the founder can
// rename it and remove members. Guild-mates see each other's cards and can message each other.

export const GUILD_TAG_HELP = "2–5 letters or numbers, no spaces.";

function guildError(error) {
  const msg = (error && error.message) || "";
  if (error && error.code === "23505") return "A guild with that name already exists. Try another name.";
  if (error && error.code === "23514") return `Guild names are 2–40 characters; tags are ${GUILD_TAG_HELP.toLowerCase()}`;
  if (error && error.code === "42501") return "You can only invite your own friends, to a guild you're in.";
  return /full|no longer available|Not signed in/.test(msg) ? msg : friendly(error);
}

/** My guilds with their members, and invitations waiting for me:
 * {me, guilds: [{id, name, tag, owner, mine, members: [{id, username, avatar_path}]}],
 *  invites: [{id, guild: {id, name, tag}, inviter}], sent: [{id, guild_id, invitee}]} */
export async function guildsState() {
  const c = await sb();
  const user = await currentUser();
  if (!user) return null;
  const mine = await c.from("guild_members").select("guild_id").eq("user_id", user.id);
  if (mine.error) throw new Error(friendly(mine.error));
  const invites = await c.from("guild_invites").select("id, guild_id, inviter, invitee, created_at");
  if (invites.error) throw new Error(friendly(invites.error));
  const myIds = mine.data.map((r) => r.guild_id);
  const guildIds = [...new Set([...myIds, ...invites.data.map((i) => i.guild_id)])];
  const guilds = new Map();
  if (guildIds.length) {
    const g = await c.from("guilds").select("id, name, tag, owner, created_at").in("id", guildIds);
    if (g.error) throw new Error(friendly(g.error));
    for (const row of g.data) guilds.set(row.id, { ...row, mine: row.owner === user.id, members: [] });
  }
  const people = new Map();
  if (myIds.length) {
    const m = await c.from("guild_members").select("guild_id, user_id, joined_at").in("guild_id", myIds).order("joined_at");
    if (m.error) throw new Error(friendly(m.error));
    const ids = [...new Set([...m.data.map((r) => r.user_id), ...invites.data.flatMap((i) => [i.inviter, i.invitee])])];
    const p = await c.from("profiles").select("id, username, avatar_path").in("id", ids);
    if (p.error) throw new Error(friendly(p.error));
    for (const row of p.data) people.set(row.id, { ...row, username: row.username || "(no username yet)" });
    for (const r of m.data) {
      const guild = guilds.get(r.guild_id);
      if (guild) guild.members.push(people.get(r.user_id) || { id: r.user_id, username: "(unknown)", avatar_path: null });
    }
  } else if (invites.data.length) {
    const p = await c.from("profiles").select("id, username, avatar_path").in("id", invites.data.map((i) => i.inviter));
    for (const row of p.data || []) people.set(row.id, row);
  }
  return {
    me: user.id,
    guilds: myIds.map((id) => guilds.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
    invites: invites.data.filter((i) => i.invitee === user.id && guilds.has(i.guild_id))
      .map((i) => ({ id: i.id, guild: guilds.get(i.guild_id), inviter: (people.get(i.inviter) || {}).username || "A friend" })),
    sent: invites.data.filter((i) => i.inviter === user.id),
  };
}

/** Guild tags to show beside people's names: Map(user id -> ["TAG", ...]). */
export async function tagsOf(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const c = await sb();
  const m = await c.from("guild_members").select("guild_id, user_id").in("user_id", userIds);
  if (m.error || !m.data.length) return out;
  const g = await c.from("guilds").select("id, tag").in("id", [...new Set(m.data.map((r) => r.guild_id))]);
  if (g.error) return out;
  const tag = new Map(g.data.map((r) => [r.id, r.tag]));
  for (const r of m.data) {
    if (!tag.has(r.guild_id)) continue;
    out.set(r.user_id, [...(out.get(r.user_id) || []), tag.get(r.guild_id)].sort());
  }
  return out;
}

export async function createGuild(name, tag) {
  const { data, error } = await (await sb()).rpc("create_guild", { guild_name: name.trim(), guild_tag: tag.trim() });
  if (error) throw new Error(guildError(error));
  return data;
}

/** Founder only: change the guild's name and/or tag. */
export async function updateGuild(id, { name, tag }) {
  const { error } = await (await sb()).from("guilds").update({ name: name.trim(), tag: tag.trim() }).eq("id", id);
  if (error) throw new Error(guildError(error));
}

export async function leaveGuild(id) {
  const { error } = await (await sb()).rpc("leave_guild", { g: id });
  if (error) throw new Error(friendly(error));
}

export async function removeGuildMember(id, person) {
  const { error } = await (await sb()).rpc("remove_guild_member", { g: id, person });
  if (error) throw new Error(friendly(error));
}

export async function inviteToGuild(id, friendId) {
  const user = await currentUser();
  if (!user) throw new Error("Connect first.");
  const { error } = await (await sb()).from("guild_invites").insert({ guild_id: id, inviter: user.id, invitee: friendId });
  if (error) throw new Error(error.code === "23505" ? "They've already been invited to this guild." : guildError(error));
}

export async function acceptGuildInvite(inviteId) {
  const { error } = await (await sb()).rpc("accept_guild_invite", { invite_id: inviteId });
  if (error) throw new Error(guildError(error));
}

export async function declineGuildInvite(inviteId) {
  const { error } = await (await sb()).from("guild_invites").delete().eq("id", inviteId);
  if (error) throw new Error(friendly(error));
}

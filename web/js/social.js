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
  let { data, error } = await c.from("profiles").select("id, username").eq("id", user.id).maybeSingle();
  if (error) throw new Error(friendly(error));
  if (!data) {
    const ins = await c.from("profiles").insert({ id: user.id }).select("id, username").single();
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
  if (otherIds.length) {
    const { data: people, error: e2 } = await c.from("profiles").select("id, username").in("id", otherIds);
    if (e2) throw new Error(friendly(e2));
    for (const p of people) names.set(p.id, p.username || "(no username yet)");
  }
  const entry = (r) => {
    const other = r.requester === me.id ? r.addressee : r.requester;
    return { id: r.id, user: { id: other, username: names.get(other) || "(unknown)" }, since: r.created_at };
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
  for (const table of ["friendships", "messages", "game_invites", "statuses"]) {
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
  })).catch(() => {});
  setInterval(paint, 120000);
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

/** Send copies of vocab words (optionally as a named folder) to a friend. */
export function sendShare(friendId, { folder = null, words }) {
  const clean = words.slice(0, 500).map((w) => ({
    text: String(w.text || "").slice(0, 300), meaning: String(w.meaning || "").slice(0, 2000),
    notes: String(w.notes || "").slice(0, 4000), sentence: String(w.sentence || "").slice(0, 2000),
    episode_title: String(w.episode_title || "").slice(0, 300),
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

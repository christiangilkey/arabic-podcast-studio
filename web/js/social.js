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

/** Call `handler` whenever friend requests, shares or quiz invites change. Returns an unsubscribe. */
export async function onActivity(handler) {
  const user = await currentUser();
  if (!user) return () => {};
  const c = await sb();
  const channel = c.channel(`activity-${user.id}-${Math.random().toString(36).slice(2, 8)}`);
  for (const table of ["friendships", "shares", "game_invites"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, () => handler(table));
  }
  channel.subscribe();
  return () => { c.removeChannel(channel); };
}

/** Things waiting for you (friend requests now; shares and quiz invites as they arrive). */
export async function pendingCount() {
  const user = await currentUser();
  if (!user) return 0;
  const c = await sb();
  const counts = await Promise.all([
    c.from("friendships").select("id", { count: "exact", head: true }).eq("addressee", user.id).eq("status", "pending"),
    c.from("shares").select("id", { count: "exact", head: true }).eq("recipient", user.id),
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

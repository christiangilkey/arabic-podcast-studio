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

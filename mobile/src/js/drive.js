// Google sign-in (native Android) and a minimal Drive client for the hidden app folder.

import { GoogleDriveAuth, isNative } from "./native.js";
import { saveSettingsPatch, settings } from "./store.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,size,modifiedTime";

let token = null;
let tokenExpires = 0;

export class AuthError extends Error {}

/** Interactive sign-in: shows Google's account picker / consent the first time. */
export async function signIn() {
  if (!isNative) throw new AuthError("Google sign-in works in the installed Android app.");
  const r = await GoogleDriveAuth.authorize({ interactive: true });
  token = r.accessToken;
  tokenExpires = Date.now() + 50 * 60 * 1000;
  const email = await fetchEmail();
  await saveSettingsPatch({ signed_in: true, google_email: email });
  return email;
}

/** Access token, refreshed silently (no UI) once access has been granted. */
export async function accessToken(forceRefresh = false) {
  if (!settings.signed_in) throw new AuthError("Not signed in.");
  if (!forceRefresh && token && Date.now() < tokenExpires) return token;
  try {
    const r = await GoogleDriveAuth.authorize({ interactive: false });
    token = r.accessToken;
    tokenExpires = Date.now() + 50 * 60 * 1000;
    return token;
  } catch (e) {
    throw new AuthError("Your Google sign-in needs renewing. Open Settings and sign in again.");
  }
}

async function fetchEmail() {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? (await r.json()).email || "" : "";
}

export async function signOut() {
  if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
  token = null;
  tokenExpires = 0;
  await saveSettingsPatch({ signed_in: false, google_email: "" });
}

async function request(url, opts = {}, retry = true) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 401 && retry) {
    await accessToken(true);
    return request(url, opts, false);
  }
  if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

export const drive = {
  async list() {
    const out = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({ spaces: "appDataFolder", pageSize: "1000", fields: `nextPageToken,files(${FIELDS})` });
      if (pageToken) q.set("pageToken", pageToken);
      const data = await (await request(`${API}/files?${q}`)).json();
      out.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return out;
  },
  async get(id) {
    return (await request(`${API}/files/${id}?fields=${FIELDS}`)).json();
  },
  async download(id) {
    return (await request(`${API}/files/${id}?alt=media`)).arrayBuffer();
  },
  async downloadBlob(id) {
    return (await request(`${API}/files/${id}?alt=media`)).blob();
  },
  async upload(name, bytes, mime, id = null) {
    const meta = id ? { name } : { name, parents: ["appDataFolder"] };
    const boundary = "aps-boundary-7f3c";
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
    ]);
    const url = `${UPLOAD}/files${id ? `/${id}` : ""}?uploadType=multipart&fields=${FIELDS}`;
    return (await request(url, { method: id ? "PATCH" : "POST", body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` } })).json();
  },
};

// ---------- gzip (the format the desktop writes) ----------
export async function gunzipJson(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
export async function gzipJson(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

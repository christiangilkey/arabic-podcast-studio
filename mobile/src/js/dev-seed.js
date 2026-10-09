// Development only: fill the phone's storage from a desktop library export, so the app can be
// previewed in a normal browser without Google sign-in. Never used in the installed app.

import { lib, saveLibrary, transcripts } from "./store.js";

export async function seedFrom(url) {
  const res = await fetch(url);
  if (!res.ok) return;
  const seed = await res.json();
  Object.assign(lib, seed.library);
  saveLibrary();
  for (const [uid, payload] of Object.entries(seed.transcripts || {})) await transcripts.put(uid, payload);
}

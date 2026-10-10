// On-phone storage (IndexedDB): the synced library, transcripts, audio copies and settings.
//
// The library is kept in exactly the format of library.json.gz in Google Drive, so syncing is
// a record-by-record merge with no translation layer.

const DB_NAME = "aps";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ["kv", "transcripts", "audio"]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kv = {
  get: (key) => run("kv", "readonly", (s) => s.get(key)),
  set: (key, value) => run("kv", "readwrite", (s) => s.put(value, key)),
};
export const transcripts = {
  get: (uid) => run("transcripts", "readonly", (s) => s.get(uid)),
  put: (uid, payload) => run("transcripts", "readwrite", (s) => s.put(payload, uid)),
  delete: (uid) => run("transcripts", "readwrite", (s) => s.delete(uid)),
  keys: () => run("transcripts", "readonly", (s) => s.getAllKeys()),
};
export const audio = {
  get: (uid) => run("audio", "readonly", (s) => s.get(uid)),
  put: (uid, blob) => run("audio", "readwrite", (s) => s.put(blob, uid)),
  delete: (uid) => run("audio", "readwrite", (s) => s.delete(uid)),
};

// ---------- library (in memory, persisted after each change) ----------

export const lib = { feeds: [], episodes: [], vocab: [], folders: [], definitions: [] };
let saveTimer = 0;

export async function loadLibrary() {
  const saved = await kv.get("library");
  if (saved) Object.assign(lib, saved);
}

export function saveLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kv.set("library", lib).catch(console.error), 200);
}

export const now = () => Date.now() / 1000; // seconds, matching the desktop's timestamps

// ---------- settings ----------

const DEFAULTS = {
  theme: "system",
  font_size: 26,
  page_font_size: 17,
  welcome_seen: false,
  definer_provider: "claude",
  definer_language: "English",
  definer_model_claude: "", definer_model_gemini: "", definer_model_openai: "", definer_model_grok: "",
  llm_key_claude: "", llm_key_gemini: "", llm_key_openai: "", llm_key_grok: "",
  google_email: "",
  signed_in: false,
  haptics: true,
};
export const settings = { ...DEFAULTS };

export async function loadSettings() {
  Object.assign(settings, DEFAULTS, (await kv.get("settings")) || {});
  return settings;
}

export async function saveSettingsPatch(patch) {
  Object.assign(settings, patch);
  await kv.set("settings", { ...settings });
  return settings;
}

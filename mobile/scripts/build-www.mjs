// Assemble mobile/www: shared screens from ../web, then phone-specific files from ./src on top.
//   node scripts/build-www.mjs
// Shared files are copied (not linked) so the Android build has a self-contained web bundle.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "..");
const web = join(mobile, "..", "web");
const out = join(mobile, "www");

// Files shared verbatim with the desktop app.
const SHARED = [
  "css/app.css",
  "fonts",
  "icons",
  "js/wordlookup.js",
  "js/definer.js",
  "js/components/wordbubble.js",
  "js/components/account.js",
  "js/social.js",
  "js/vendor/supabase.js",
  "js/pages/library.js",
  "js/pages/player.js",
  "js/pages/vocab.js",
  "js/pages/search.js",
  "js/pages/friends.js",
  "js/pages/chat.js",
  "js/updatenotice.js",
  "js/pages/home.js",
  "js/progress.js",
  "js/pages/reader.js",
  "js/extract.js",
  "js/pageimport.js",
  "js/components/studycard.js",
  "js/components/avatar.js",
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const rel of SHARED) {
  const src = join(web, rel);
  if (!existsSync(src)) throw new Error(`Missing shared file: ${src}`);
  cpSync(src, join(out, rel), { recursive: true });
}
// Capacitor's core library (a single self-contained module) so plain <script type="module">
// code can reach native plugins without a bundler.
cpSync(join(mobile, "node_modules", "@capacitor", "core", "dist", "index.js"), join(out, "js", "vendor", "capacitor-core.js"));
// Phone-specific files (index.html, app shell, storage, sync, settings) override shared ones.
cpSync(join(mobile, "src"), out, { recursive: true });
// This build's version (set by the release workflow), so the app can tell when a newer one exists.
const version = process.env.APP_VERSION || "0.0.0-dev";
writeFileSync(join(out, "js", "version.js"), `export const APP_VERSION = ${JSON.stringify(version)};\n`);
console.log(`Built ${out} (version ${version})`);

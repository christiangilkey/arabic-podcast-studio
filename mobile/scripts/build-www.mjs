// Assemble mobile/www: shared screens from ../web, then phone-specific files from ./src on top.
//   node scripts/build-www.mjs
// Shared files are copied (not linked) so the Android build has a self-contained web bundle.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
console.log(`Built ${out}`);

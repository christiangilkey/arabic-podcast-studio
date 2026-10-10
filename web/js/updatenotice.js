// "A new version is available" popup, shown when the app opens. Clicking it opens the release
// page (in the system browser), where the new installer or APK can be downloaded.
// Each app shell checks in its own way and calls showUpdateNotice() when there is one.

import { h } from "./app.js";

/** Version numbers as comparable lists: "0.10.1" -> [0, 10, 1]. */
export function parseVersion(v) {
  const nums = String(v || "").split("-")[0].match(/\d+/g) || [];
  return nums.slice(0, 3).map(Number);
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Only ever a link to the app's own releases on GitHub. */
function releaseUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "github.com" ? u.href : "";
  } catch {
    return "";
  }
}

/** Show the popup for version `latest`. It stays until clicked or closed (once per app start). */
export function showUpdateNotice({ latest, current, url }) {
  const link = releaseUrl(url);
  if (!latest || !link || document.getElementById("update-notice")) return;
  const el = h(`<div class="update-notice" id="update-notice" role="status">
    <a class="update-link" target="_blank" rel="noopener">
      <span class="update-ico">⬆</span>
      <span class="update-text"><strong></strong><span class="small">See what's new and download it ↗</span></span>
    </a>
    <button type="button" class="ghost icon update-close" title="Not now" aria-label="Close">✕</button>
  </div>`);
  el.querySelector("a").href = link;
  el.querySelector("strong").textContent = `Tamkeen ${latest} is available${current ? ` (you have ${current})` : ""}`;
  el.querySelector(".update-close").onclick = () => el.remove();
  el.querySelector("a").addEventListener("click", () => setTimeout(() => el.remove(), 300));
  document.body.append(el);
}

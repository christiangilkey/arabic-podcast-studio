// A person's round picture (their photo, or their initial when they have none), with an
// optional online/offline dot, plus the little guild tags shown beside names.

import { h } from "../app.js";
import { avatarUrl } from "../social.js";

/**
 * @param {{username?: string, avatar_path?: string|null}} user
 * @param {{online?: boolean|null, large?: boolean}} [opts] online: true/false shows a dot; null hides it
 */
export function avatar(user, { online = null, large = false } = {}) {
  const el = h(`<span class="avatar${large ? " large" : ""}"></span>`);
  const name = (user && user.username) || "?";
  const url = avatarUrl(user && user.avatar_path);
  if (url) {
    const img = h(`<img alt="" loading="lazy" referrerpolicy="no-referrer">`);
    img.src = url;
    // A picture that fails to load falls back to the initial.
    img.onerror = () => { img.remove(); el.prepend(document.createTextNode((name[0] || "?").toUpperCase())); };
    el.append(img);
  } else {
    el.textContent = (name[0] || "?").toUpperCase();
  }
  if (online !== null) {
    const dot = h(`<span class="presence ${online ? "on" : "off"}" role="img"></span>`);
    dot.title = online ? "Online" : "Offline";
    dot.setAttribute("aria-label", dot.title);
    el.append(dot);
  }
  return el;
}

/** Guild tags as small chips, e.g. [TMK]. */
export function tagChips(tags) {
  const wrap = h(`<span class="guild-tags"></span>`);
  for (const t of tags || []) {
    const chip = h(`<span class="guild-tag"></span>`);
    chip.textContent = t;
    wrap.append(chip);
  }
  return wrap;
}

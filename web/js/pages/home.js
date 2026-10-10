// Home: one obvious next step. If something is unfinished (see progress.js for the rules) the
// screen is a big "Continue" button; otherwise it says you're caught up and offers at most
// three things to do next. Deliberately short: no feed, nothing endless.

import { api, esc, h } from "../app.js";
import { continueItems, forgetProgress, fraction, leftLabel } from "../progress.js";

const KIND_ICON = { audio: "🎧", video: "🎬", page: "🌐" };
const KIND_VERB = { audio: "Continue listening", video: "Continue watching", page: "Continue reading" };

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return ["مساء الخير", "Good evening"];
  if (hour < 12) return ["صباح الخير", "Good morning"];
  if (hour < 18) return ["نهارك سعيد", "Good afternoon"];
  return ["مساء الخير", "Good evening"];
}

/** Items still in the library (anything deleted since is forgotten). */
async function existing(items, limit) {
  const out = [];
  for (const item of items) {
    if (out.length >= limit) break;
    try {
      await api(`/episodes/${item.id}`);
      out.push(item);
    } catch {
      forgetProgress(item.id);
    }
  }
  return out;
}

export async function render(view) {
  const [ar, en] = greeting();
  view.append(h(`<div class="home">
    <section class="hero">
      <div class="hero-top">
        <img class="hero-logo" src="${new URL("../../icons/icon-256.png", import.meta.url).href}" alt="" width="56" height="56">
        <div><div class="hero-ar ar" dir="rtl" lang="ar">${ar}</div><div class="hero-en">${en}</div></div>
      </div>
      <div class="hero-main" id="main"><div class="hero-loading">…</div></div>
    </section>
    <div class="home-more" id="more"></div>
    <div class="home-today" id="today"></div>
  </div>`));
  const main = view.querySelector("#main");
  const more = view.querySelector("#more");

  const items = await existing(continueItems(), 3);
  main.innerHTML = "";
  if (items.length) {
    const first = items[0];
    const btn = h(`<a class="continue-btn" href="#/episode/${first.id}">
      <span class="continue-play">▶</span>
      <span class="continue-text">
        <span class="continue-verb">${KIND_VERB[first.kind] || "Continue"}</span>
        <span class="continue-title" dir="auto"></span>
        <span class="continue-sub"><span dir="auto" class="continue-from"></span><span>${esc(leftLabel(first))}</span></span>
      </span>
      <span class="continue-bar"><i style="width:${Math.round(fraction(first) * 100)}%"></i></span>
    </a>`);
    btn.querySelector(".continue-title").textContent = first.title || "";
    btn.querySelector(".continue-from").textContent = first.sub ? `${first.sub} · ` : "";
    main.append(btn);
    // At most two more: three choices in total.
    if (items.length > 1) more.append(h(`<h2 class="home-h">Also in progress</h2>`));
    for (const item of items.slice(1)) {
      const row = h(`<a class="continue-row card" href="#/episode/${item.id}">
        <span class="continue-ico">${KIND_ICON[item.kind] || "▶"}</span>
        <span class="continue-text"><span class="t" dir="auto"></span>
          <span class="small muted">${esc(leftLabel(item))}</span></span>
        <span class="continue-bar"><i style="width:${Math.round(fraction(item) * 100)}%"></i></span>
      </a>`);
      row.querySelector(".t").textContent = item.title || "";
      more.append(row);
    }
  } else {
    main.append(h(`<div class="caught-up">
      <div class="caught-up-mark">✓</div>
      <div class="caught-up-title">You're all caught up</div>
      <div class="caught-up-sub">Nothing left unfinished. Pick something new whenever you like.</div>
    </div>`));
    more.append(h(`<div class="home-choices">
      <a class="choice card" href="#/library"><span class="choice-ico">🎧</span><span><strong>Open your library</strong>
        <span class="small muted">Podcasts, videos and web pages</span></span></a>
      <a class="choice card" href="#/vocab"><span class="choice-ico">★</span><span><strong>Look over your vocab</strong>
        <span class="small muted">The words you've saved</span></span></a>
      <a class="choice card" href="#/friends"><span class="choice-ico">👥</span><span><strong>See what friends are studying</strong>
        <span class="small muted">Messages and shared words</span></span></a>
    </div>`));
  }

  // A small, honest summary of today: no streak pressure, nothing to lose.
  try {
    const words = await api("/vocab");
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = words.filter((v) => v.created_at * 1000 >= midnight.getTime()).length;
    const box = view.querySelector("#today");
    if (box) {
      box.append(h(`<div class="today-chips">
        <span class="today-chip${today ? " lit" : ""}">★ ${today} word${today === 1 ? "" : "s"} saved today</span>
        <span class="today-chip">${words.length} in your vocab</span>
      </div>`));
    }
  } catch { /* vocab unavailable: the summary is optional */ }
}

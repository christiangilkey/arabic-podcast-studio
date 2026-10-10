// Swipe left/right between the bottom-tab sections, and a highlight "blob" in the tab bar that
// slides between tabs: it follows your finger during a swipe and glides when you tap a tab.
//
// How a swipe works: once a touch is clearly horizontal the page follows the finger; letting
// go past a third of the screen (or with a quick flick) slides it out, switches section, and
// slides the new one in from the other side. Anything shorter springs back.
//
// A swipe never starts inside something that scrolls sideways itself (the podcast strip in
// the library), on sliders or text fields, while text is selected, or in the player/chat
// (which hide the tab bar).

const COMMIT_FRACTION = 0.3;   // of the screen width
const FLICK_SPEED = 0.45;      // px per ms
const SLIDE_MS = 190;

let view;
let bar;
let blob;
let tabs = [];

const activeIndex = () => tabs.findIndex((a) => a.classList.contains("active"));
const centre = (a) => {
  const ico = a.querySelector(".ico") || a;
  const r = ico.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 };
};

/** Put the blob under tab `index`, or part-way towards a neighbour (progress -1..1). */
function placeBlob(index, progress = 0, animate = true) {
  if (!blob) return;
  if (index < 0) { blob.style.opacity = "0"; return; }
  const from = centre(tabs[index]);
  const neighbour = tabs[index + Math.sign(progress)];
  const to = neighbour ? centre(neighbour) : from;
  const p = neighbour ? Math.min(1, Math.abs(progress)) : 0;
  const x = from.x + (to.x - from.x) * p;
  blob.style.transition = animate ? "transform .28s cubic-bezier(.3, 1.3, .5, 1), opacity .2s" : "none";
  // Stretch a little mid-way, like something soft being dragged.
  const stretch = 1 + 0.35 * Math.sin(Math.PI * p);
  blob.style.opacity = "1";
  blob.style.transform = `translate(${x - 26}px, ${from.y - 14}px) scaleX(${stretch})`;
}

function scrollsSideways(el) {
  for (let n = el; n && n !== view; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 4) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

function blocked(target) {
  if (document.body.classList.contains("in-player")) return true;
  if (target.closest("input, textarea, select, [contenteditable], .word-bubble, #ctxmenu, iframe, video, .transcript, .reader-text")) return true;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return true;
  return scrollsSideways(target);
}

export function initSwipe() {
  view = document.getElementById("view");
  bar = document.querySelector(".tabbar");
  if (!view || !bar) return;
  tabs = [...bar.querySelectorAll("a[data-nav]")];
  blob = document.createElement("span");
  blob.className = "tab-blob";
  bar.prepend(blob);
  bar.classList.add("has-blob");

  const settle = () => placeBlob(activeIndex(), 0, true);
  window.addEventListener("routed", settle);
  window.addEventListener("resize", () => placeBlob(activeIndex(), 0, false));
  setTimeout(() => placeBlob(activeIndex(), 0, false), 0);

  let start = null;      // {x, y, t, index}
  let swiping = false;
  let dx = 0;
  let busy = false;

  view.addEventListener("touchstart", (e) => {
    swiping = false;
    start = null;
    if (busy || e.touches.length !== 1 || blocked(e.target)) return;
    const index = activeIndex();
    if (index < 0) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), index };
  }, { passive: true });

  view.addEventListener("touchmove", (e) => {
    if (!start) return;
    const mx = e.touches[0].clientX - start.x;
    const my = e.touches[0].clientY - start.y;
    if (!swiping) {
      if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) { start = null; return; } // it's a vertical scroll
      if (Math.abs(mx) < 14 || Math.abs(mx) < Math.abs(my) * 1.6) return;
      swiping = true;
      view.style.transition = "none";
      view.style.willChange = "transform";
    }
    e.preventDefault(); // we own this gesture now: no vertical scrolling at the same time
    // Finger moving left (negative) goes to the next tab on the right.
    const hasNeighbour = !!tabs[start.index - Math.sign(mx)];
    dx = hasNeighbour ? mx : mx * 0.22; // rubber-band at the first and last tab
    view.style.transform = `translateX(${dx}px)`;
    placeBlob(start.index, hasNeighbour ? -dx / view.clientWidth : 0, false);
  }, { passive: false });

  const finish = () => {
    if (!start || !swiping) { start = null; swiping = false; return; }
    const s = start;
    const width = view.clientWidth;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - s.t);
    const target = tabs[s.index - Math.sign(dx)];
    const commit = target && (Math.abs(dx) > width * COMMIT_FRACTION || (speed > FLICK_SPEED && Math.abs(dx) > 40));
    start = null;
    swiping = false;
    view.style.transition = `transform ${SLIDE_MS}ms ease-out`;
    if (!commit) {
      view.style.transform = "translateX(0)";
      placeBlob(s.index, 0, true);
      setTimeout(() => { view.style.transition = view.style.transform = view.style.willChange = ""; }, SLIDE_MS);
      return;
    }
    busy = true;
    const dir = Math.sign(dx);
    view.style.transform = `translateX(${dir * width}px)`;
    placeBlob(s.index, -dir, true);
    setTimeout(() => {
      // New section comes in from the opposite edge once it has been drawn.
      let arrived = false;
      const arrive = () => {
        if (arrived) return;
        arrived = true;
        window.removeEventListener("routed", arrive);
        view.style.transition = "none";
        view.style.transform = `translateX(${-dir * width * 0.35}px)`;
        view.style.opacity = "0.4";
        void view.offsetWidth; // make the starting position take effect before animating from it
        // (A timer rather than an animation frame: frames pause when the app isn't visible,
        // and the page must never be left part-way off the screen.)
        setTimeout(() => {
          view.style.transition = `transform ${SLIDE_MS}ms ease-out, opacity ${SLIDE_MS}ms ease-out`;
          view.style.transform = "translateX(0)";
          view.style.opacity = "1";
          setTimeout(() => {
            view.style.transition = view.style.transform = view.style.willChange = view.style.opacity = "";
            busy = false;
          }, SLIDE_MS);
        }, 16);
      };
      window.addEventListener("routed", arrive);
      // Safety net: never leave the page off-screen if the section fails to draw.
      setTimeout(() => { if (busy) arrive(); }, 2500);
      location.hash = target.getAttribute("href");
    }, SLIDE_MS);
  };
  view.addEventListener("touchend", finish);
  view.addEventListener("touchcancel", finish);
}

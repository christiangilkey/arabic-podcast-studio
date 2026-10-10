// Injected by the desktop app into every page shown in its "Web Browser" window (see
// app/desktop.py): a slim bar along the bottom with back / forward / reload, the address, and
// the "Import Page" button at the bottom right.
//
// It runs inside other people's websites, so it is deliberately defensive: plain script (not
// a module), no innerHTML (some sites forbid it), styles applied through the style object
// (allowed even under strict site security policies), and everything inside a closed shadow
// root so the site's own styles and scripts can't interfere with it.
(function () {
  if (window.top !== window || window.__apsBrowserBar) return;
  window.__apsBrowserBar = true;

  var H = 46;
  var host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;left:0;right:0;bottom:0;height:" + H + "px;z-index:2147483647;";
  var root = host.attachShadow({ mode: "closed" });

  function el(tag, css, text) {
    var n = document.createElement(tag);
    n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }
  var FONT = "font:14px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;";
  var BTN = FONT + "box-sizing:border-box;height:32px;min-width:34px;padding:0 10px;border:1px solid #3a3a38;border-radius:8px;" +
    "background:#262624;color:#f2f1ec;cursor:pointer;";
  var bar = el("div", FONT + "box-sizing:border-box;display:flex;align-items:center;gap:6px;height:" + H + "px;padding:0 8px;" +
    "background:#1c1c1a;border-top:1px solid #3a3a38;color:#f2f1ec;direction:ltr;");
  var back = el("button", BTN, "‹");
  var fwd = el("button", BTN, "›");
  var reload = el("button", BTN, "⟳");
  var input = el("input", FONT + "box-sizing:border-box;flex:1;min-width:80px;height:32px;padding:0 10px;border:1px solid #3a3a38;" +
    "border-radius:8px;background:#141413;color:#f2f1ec;outline:none;");
  var status = el("span", FONT + "max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b8b6ad;");
  var imp = el("button", BTN + "background:#2dd4bf;border-color:#2dd4bf;color:#062a26;font-weight:600;padding:0 14px;", "Import Page");
  back.title = "Back";
  fwd.title = "Forward";
  reload.title = "Reload";
  imp.title = "Save this page to Arabic Podcast Studio, to read with clickable words";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "Search or type a web address";
  input.value = location.href;

  back.onclick = function () { history.back(); };
  fwd.onclick = function () { history.forward(); };
  reload.onclick = function () { location.reload(); };
  input.onfocus = function () { input.select(); };
  input.onkeydown = function (e) {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    var text = input.value.trim();
    if (!text) return;
    var looksLikeAddress = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || (/^[^\s]+\.[^\s]{2,}$/.test(text) && text.indexOf(" ") < 0);
    location.href = looksLikeAddress ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "https://" + text)
      : "https://www.google.com/search?q=" + encodeURIComponent(text);
  };
  ["keyup", "keypress"].forEach(function (t) { input.addEventListener(t, function (e) { e.stopPropagation(); }); });

  var busy = false;
  function say(text, good) {
    status.textContent = text;
    status.style.color = good === false ? "#fca5a5" : good ? "#5eead4" : "#b8b6ad";
  }
  imp.onclick = function () {
    if (busy) return;
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.import_page) { say("Still loading… try again in a moment.", false); return; }
    busy = true;
    imp.textContent = "Importing…";
    say("");
    api.import_page().then(function (r) {
      if (r && r.ok) say("✓ Imported “" + r.title + "” (" + r.words + " words). It's in My webpages.", true);
      else say((r && r.error) || "Couldn't import this page.", false);
    }).catch(function (e) {
      say("Couldn't import this page. " + (e && e.message ? e.message : ""), false);
    }).then(function () {
      busy = false;
      imp.textContent = "Import Page";
    });
  };

  bar.appendChild(back);
  bar.appendChild(fwd);
  bar.appendChild(reload);
  bar.appendChild(input);
  bar.appendChild(status);
  bar.appendChild(imp);
  root.appendChild(bar);

  function attach() {
    (document.body || document.documentElement).appendChild(host);
    // Leave room so the bar never covers the end of the page.
    if (document.body) document.body.style.paddingBottom = "calc(" + H + "px + " + (getComputedStyle(document.body).paddingBottom || "0px") + ")";
  }
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);
  // Keep the address current on sites that change pages without reloading.
  setInterval(function () {
    if (root.activeElement !== input && input.value !== location.href) input.value = location.href;
    if (!host.isConnected && document.body) document.body.appendChild(host);
  }, 700);
})();

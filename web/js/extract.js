// Pulls the readable text (title, headings, paragraphs, list items, quotes) out of a web page,
// leaving out menus, ads, cookie banners, comments and the like.
//
// This one function is used three ways, so it must stay self-contained plain JavaScript:
//   - on a page downloaded for "Add a webpage" (parsed with DOMParser);
//   - inside the desktop's Web Browser window and the Android in-app browser, where the app
//     injects this source into the page being viewed when "Import Page" is pressed.
// (Those two read this file as text and drop the final `export` line.)

function extractArticle(doc, url) {
  var MAX_BLOCKS = 3000;
  var MAX_WORDS = 30000;
  var SKIP = "script,style,noscript,template,svg,canvas,iframe,form,button,select,nav,footer,aside,menu,dialog," +
    "[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog],[aria-hidden=true],[hidden]," +
    ".advert,.advertisement,.ads,.ad,.cookie,.cookies,.share,.sharing,.social,.comments,.comment,.related," +
    ".sidebar,.newsletter,.breadcrumb,.breadcrumbs,.footer,.nav,.navbar,.menu,.popup,.modal,.promo," +
    ".references,.reflist,.mw-references-wrap,.refbegin,[role=doc-endnotes],[role=doc-bibliography]";
  var BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dd,dt";
  // Class/id words that mark page furniture rather than the article (matched as whole words).
  var JUNK = /(?:^|[\s_-])(menu|navbar|navigation|nav|toc|footer|sidebar|share|sharing|social|cookies?|comments?|related|promo|advert|ads?|breadcrumbs?|popup|modal|dropdown|langs?|languages|interlanguage|toolbar|newsletter|subscribe|catlinks|navbox|infobox|metadata)(?:$|[\s_-])/i;
  // Bits inside a paragraph that aren't part of its text: footnote markers, "[edit]" links.
  var INLINE_JUNK = "sup,script,style,.reference,.mw-editsection,.noprint,.sr-only,.visually-hidden";

  function clean(text) {
    return String(text || "").replace(/[\u200b\u200e\u200f\ufeff]/g, "").replace(/\s+/g, " ").trim();
  }
  function meta(name) {
    var el = doc.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return el ? clean(el.getAttribute("content")) : "";
  }
  function skipped(el, root) {
    for (var n = el; n && n !== root; n = n.parentElement) {
      if (n.matches && n.matches(SKIP)) return true;
      var names = (typeof n.className === "string" ? n.className : "") + " " + (n.id || "");
      if (names.length > 1 && JUNK.test(names)) return true;
      if (n.tagName === "HEADER" && n.parentElement && n.parentElement.tagName === "BODY") return true;
    }
    return false;
  }
  function textLength(root) {
    var total = 0;
    var ps = root.querySelectorAll("p");
    for (var i = 0; i < ps.length; i++) if (!skipped(ps[i], root)) total += clean(ps[i].textContent).length;
    return total;
  }

  // The part of the page holding the article: whichever likely container has the most paragraph text.
  var body = doc.body || doc.documentElement;
  var root = body;
  var best = 0;
  var bodyLength = textLength(body);
  var candidates = doc.querySelectorAll("article, main, [role=main], [itemprop=articleBody], #content, #main, .post-content, .entry-content, .article-body, .article-content, .content");
  for (var c = 0; c < candidates.length; c++) {
    var len = textLength(candidates[c]);
    if (len > best) { best = len; root = candidates[c]; }
  }
  if (best < bodyLength * 0.5) root = body; // the "article" tag held only a fragment

  var blocks = [];
  var words = 0;
  var seen = {};
  function add(kind, text) {
    if (!text || blocks.length >= MAX_BLOCKS || words >= MAX_WORDS) return;
    if (kind !== "p" && seen[kind + text]) return; // repeated headings / menu items
    seen[kind + text] = true;
    var count = text.split(" ").length;
    if (words + count > MAX_WORDS) text = text.split(" ").slice(0, MAX_WORDS - words).join(" ");
    words += count;
    blocks.push({ kind: kind, text: text });
  }
  var els = root.querySelectorAll(BLOCKS);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (skipped(el, root)) continue;
    if (el.querySelector(BLOCKS)) continue; // a container (e.g. <li><p>..</p></li>): its inner blocks are taken instead
    var tag = el.tagName.toLowerCase();
    var copy = el.cloneNode(true);
    var junk = copy.querySelectorAll(INLINE_JUNK);
    for (var j = 0; j < junk.length; j++) junk[j].parentNode.removeChild(junk[j]);
    var text = clean(copy.textContent);
    if (!text) continue;
    if (tag === "li" || tag === "dd" || tag === "dt") {
      // A short list item that is nothing but a link is a menu entry, not content.
      var linked = 0;
      var links = copy.querySelectorAll("a");
      for (var a = 0; a < links.length; a++) linked += clean(links[a].textContent).length;
      if (linked >= text.length * 0.9 && text.split(" ").length < 8) continue;
    }
    var kind = /^h[1-6]$/.test(tag) ? "h" + Math.min(3, Number(tag[1])) : tag === "li" || tag === "dd" || tag === "dt" ? "li"
      : tag === "blockquote" ? "q" : "p";
    if (kind === "li" && text.length < 2) continue;
    add(kind, text);
  }
  // Pages built without <p> tags (text separated by line breaks): if the blocks found hold only a
  // small part of the page's text, fall back to the text itself, line by line.
  if (words < 40) {
    var raw = (root.innerText || root.textContent || "").split(/\n+/);
    var rawWords = 0;
    for (var r = 0; r < raw.length; r++) { raw[r] = clean(raw[r]); if (raw[r]) rawWords += raw[r].split(" ").length; }
    if (rawWords > words * 2 + 20) {
      blocks = [];
      words = 0;
      seen = {};
      for (var k = 0; k < raw.length; k++) add("p", raw[k]);
    }
  }

  var h1 = doc.querySelector("h1");
  var title = meta("og:title") || (h1 ? clean(h1.textContent) : "") || clean(doc.title) || url;
  // The page's own title heading would otherwise appear twice.
  if (blocks.length && blocks[0].kind === "h1" && blocks[0].text === title) blocks.shift();
  var html = doc.documentElement;
  return {
    url: String(url || ""),
    title: title.slice(0, 300),
    lang: clean(html && html.getAttribute("lang")).slice(0, 12),
    site: meta("og:site_name").slice(0, 120),
    image: meta("og:image").slice(0, 1000),
    blocks: blocks,
    words: words,
  };
}

export { extractArticle };

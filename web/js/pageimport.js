// Importing web pages into "My webpages": download (or receive) a page, pull out its readable
// text with extract.js, and store it so it opens in the reader with clickable words.

import { api, fetchPage } from "./app.js";
import { extractArticle } from "./extract.js";

/** Store an already-extracted article ({url, title, blocks, ...}). Resolves to the new episode. */
export async function saveArticle(article) {
  if (!article || !article.blocks || !article.blocks.length) {
    throw new Error("No readable text was found on that page. Try “Open Web Browser” and use Import Page there.");
  }
  return api("/pages", { method: "POST", body: {
    url: article.url, title: article.title, blocks: article.blocks, image: article.image || null, site: article.site || null,
  } });
}

/** Download the page at `url` and import it. */
export async function importUrl(url) {
  const page = await fetchPage(url);
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  return saveArticle(extractArticle(doc, page.url || url));
}

/** extract.js as plain script text, for injecting into a page shown in the in-app browser. */
export async function extractorSource() {
  const res = await fetch(new URL("./extract.js", import.meta.url));
  return (await res.text()).replace(/^export \{[^}]*\};?\s*$/m, "");
}

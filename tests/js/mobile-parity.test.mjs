// The phone's logic must match the desktop's Python exactly (ids, search, exports).
// tests/fixtures/parity.json is generated from the Python code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js from "../../mobile/src/js/shared-logic.js";

const py = JSON.parse(readFileSync(new URL("../fixtures/parity.json", import.meta.url), "utf8"));
const segs = [{ start: 0.0, end: 2.5, text: "مرحبا بكم" }, { start: 2.5, end: 3661.042, text: "في الحلقة" }];
const vocab = [{ text: "كتاب", sentence: "هذا كتاب جميل", meaning: 'book, "tome"', notes: "n.", episode_title: "Ep", start: 65.0, end: 65.5 }];

test("Arabic normalization matches Python", () => {
  for (const [input, expected] of Object.entries(py.normalize)) assert.equal(js.normalize(input), expected, input);
});
test("search highlight spans match Python", () => {
  for (const [text, q, expected] of py.spans) assert.deepEqual(js.findSpans(text, q), expected);
});
test("feed ids match Python", async () => {
  for (const [url, expected] of Object.entries(py.feedUid)) assert.equal(await js.feedUid(url), expected);
});
test("feed URL cleanup matches Python", () => {
  for (const [url, expected] of Object.entries(py.normalizeUrl)) assert.equal(js.normalizeUrl(url), expected);
});
test("transcript exports match Python", () => {
  assert.equal(js.toSrt(segs), py.srt);
  assert.equal(js.toVtt(segs), py.vtt);
  assert.equal(js.toTxt(segs, "T"), py.txt);
});
test("vocab exports match Python", () => {
  assert.equal(js.vocabAnki(vocab), py.anki);
  assert.equal(js.vocabCsv(vocab), py.csv);
});

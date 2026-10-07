// Run with: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { findWordIndex, activeWordIndex, sentenceBounds, endsSentence, formatTime } from "../../web/js/wordlookup.js";

const starts = Float64Array.from([0.0, 0.5, 1.0, 2.0, 5.0]);
const ends = Float64Array.from([0.4, 0.9, 1.8, 2.5, 5.5]);

test("findWordIndex: before, on, between, after", () => {
  assert.equal(findWordIndex(starts, -1), -1);
  assert.equal(findWordIndex(starts, 0), 0);
  assert.equal(findWordIndex(starts, 0.49), 0);
  assert.equal(findWordIndex(starts, 0.5), 1);
  assert.equal(findWordIndex(starts, 3.9), 3);
  assert.equal(findWordIndex(starts, 100), 4);
  assert.equal(findWordIndex(new Float64Array(0), 1), -1);
});

test("findWordIndex matches a linear scan on 20k random words", () => {
  const n = 20000;
  const s = new Float64Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) { t += Math.random() * 0.6; s[i] = t; }
  for (let k = 0; k < 2000; k++) {
    const q = Math.random() * (t + 2) - 1;
    let lin = -1;
    for (let i = 0; i < n; i++) if (s[i] <= q) lin = i; else break;
    assert.equal(findWordIndex(s, q), lin);
  }
});

test("activeWordIndex clears highlight in long gaps", () => {
  assert.equal(activeWordIndex(starts, ends, 2.2), 3);
  assert.equal(activeWordIndex(starts, ends, 3.4), 3); // within 1 s gap
  assert.equal(activeWordIndex(starts, ends, 4.0), -1); // silence
  assert.equal(activeWordIndex(starts, ends, 5.1), 4);
});

test("sentenceBounds uses punctuation and segment boundaries", () => {
  const texts = ["قال", "الرجل.", "ثم", "ذهب", "إلى", "البيت؟", "نعم"];
  const segs = [0, 0, 0, 0, 0, 0, 1];
  assert.deepEqual(sentenceBounds(texts, segs, 0), [0, 1]);
  assert.deepEqual(sentenceBounds(texts, segs, 3), [2, 5]);
  assert.deepEqual(sentenceBounds(texts, segs, 2, 4), [2, 5]);
  assert.deepEqual(sentenceBounds(texts, segs, 6), [6, 6]);
  assert.deepEqual(sentenceBounds(texts, segs, 1, 3), [0, 5]); // selection spanning two sentences
  assert.deepEqual(sentenceBounds([], [], 0), [-1, -1]);
});

test("endsSentence handles Arabic punctuation", () => {
  assert.ok(endsSentence("البيت؟"));
  assert.ok(endsSentence("نعم؛"));
  assert.ok(endsSentence("قال.»"));
  assert.ok(!endsSentence("قال،"));
});

test("formatTime", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65.4), "1:05");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(NaN), "0:00");
});

// Pure timing helpers for the transcript player. No DOM access, so they're unit-testable
// (tests/js/wordlookup.test.mjs).

/**
 * Index of the last word whose start <= t, or -1 if t is before the first word.
 * O(log n) binary search over a sorted Float64Array of word start times.
 * @param {Float64Array|number[]} starts
 * @param {number} t
 */
export function findWordIndex(starts, t) {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * The word to highlight at time t: the last started word, as long as we haven't moved
 * past its end by more than `gap` seconds (so long silences clear the highlight).
 */
export function activeWordIndex(starts, ends, t, gap = 1.0) {
  const i = findWordIndex(starts, t);
  if (i < 0) return -1;
  return t <= ends[i] + gap ? i : -1;
}

const TERMINAL = /[.!?؟؛…]["'»”)\]]*$/u;

/** True if a word ends a sentence (Latin or Arabic punctuation). */
export function endsSentence(text) {
  return TERMINAL.test(text);
}

/**
 * Word index range [first, last] of the sentence containing words i..j.
 * A sentence ends at terminal punctuation or a Whisper segment boundary.
 * @param {string[]} texts word texts
 * @param {Int32Array|number[]} segs segment index of each word
 */
export function sentenceBounds(texts, segs, i, j = i) {
  const n = texts.length;
  if (n === 0) return [-1, -1];
  i = Math.max(0, Math.min(i, n - 1));
  j = Math.max(i, Math.min(j, n - 1));
  let first = i;
  while (first > 0 && segs[first - 1] === segs[first] && !endsSentence(texts[first - 1])) first--;
  let last = j;
  while (last < n - 1 && segs[last + 1] === segs[last] && !endsSentence(texts[last])) last++;
  return [first, last];
}

/** Format seconds as m:ss or h:mm:ss. */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

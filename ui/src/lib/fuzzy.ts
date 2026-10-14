/** Speed-search style fuzzy matching (DataGrip / VS Code quick open). */
export interface FuzzyResult {
  score: number;
  /** Indexes in `text` of matched characters, for highlighting. */
  positions: number[];
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text.charCodeAt(i - 1);
  // _ . space - / $ #
  if (prev === 95 || prev === 46 || prev === 32 || prev === 45 || prev === 47 || prev === 36 || prev === 35) return true;
  const p = text[i - 1];
  const ch = text[i];
  if (p >= '0' && p <= '9') return !(ch >= '0' && ch <= '9');
  return p === p.toLowerCase() && ch !== ch.toLowerCase(); // camelCase hump
}

/** Cheap pre-check: is `p` (lower-case) a subsequence of `t` (lower-case)? */
export function isSubsequence(p: string, t: string): boolean {
  const pl = p.length;
  if (pl === 0) return true;
  if (pl > t.length) return false;
  let pi = 0;
  let c = p.charCodeAt(0);
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) === c) {
      if (++pi === pl) return true;
      c = p.charCodeAt(pi);
    }
  }
  return false;
}

/**
 * Like `fuzzyMatch`, with the lower-cased pattern and text supplied by the caller (index hot path: no allocation for
 * non-matches, no repeated toLowerCase).
 */
export function fuzzyMatchLower(p: string, text: string, t: string): FuzzyResult | null {
  if (!p) return { score: 0, positions: [] };
  if (p.length > t.length || !isSubsequence(p, t)) return null;

  if (t === p) return { score: 1000, positions: range(0, p.length) };
  const idx = t.indexOf(p);
  if (idx === 0) return { score: 900 - t.length, positions: range(0, p.length) };
  // A contiguous hit starting at a word boundary beats scattered matches ("ord" in "SalesOrderLines").
  if (idx > 0 && isWordStart(text, idx)) return { score: 800 - t.length - idx, positions: range(idx, idx + p.length) };

  // Greedy subsequence that prefers word starts, then contiguous characters.
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    let found = -1;
    // Prefer a word-start occurrence ahead, unless the next char is contiguous with the previous match.
    if (prevMatch >= 0 && t[prevMatch + 1] === ch && prevMatch + 1 >= ti) {
      found = prevMatch + 1;
    } else {
      for (let k = ti; k < t.length; k++) {
        if (t[k] === ch && isWordStart(text, k)) {
          found = k;
          break;
        }
      }
      if (found < 0) found = t.indexOf(ch, ti);
    }
    if (found < 0) return null;
    if (found === prevMatch + 1) score += 15;
    if (isWordStart(text, found)) score += 20;
    score -= Math.min(found - ti, 10);
    positions.push(found);
    prevMatch = found;
    ti = found + 1;
  }
  if (idx > 0) {
    score += 60; // contiguous substring somewhere
    return { score: score + 100 - Math.min(t.length, 100) / 2, positions: range(idx, idx + p.length) };
  }
  score += 100 - Math.min(t.length, 100) / 2;
  return { score, positions };
}

/**
 * Returns null when `pattern` is not a subsequence of `text` (case-insensitive).
 * Higher score is better: exact > prefix > word-start substring > contiguous runs > scattered.
 */
export function fuzzyMatch(pattern: string, text: string): FuzzyResult | null {
  if (!pattern) return { score: 0, positions: [] };
  return fuzzyMatchLower(pattern.toLowerCase(), text, text.toLowerCase());
}

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i < b; i++) r.push(i);
  return r;
}

/** Filters and sorts `items` by fuzzy score of `key(item)`. */
export function fuzzyFilter<T>(items: readonly T[], pattern: string, key: (t: T) => string, limit = Infinity) {
  if (!pattern) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, positions: [] } as FuzzyResult }));
  const p = pattern.toLowerCase();
  const out: { item: T; match: FuzzyResult }[] = [];
  for (const item of items) {
    const text = key(item);
    const m = fuzzyMatchLower(p, text, text.toLowerCase());
    if (m) out.push({ item, match: m });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}

/** Keeps the best `k` of `items` by `score` (descending) without sorting everything. */
export function topK<T>(items: T[], k: number, score: (t: T) => number): T[] {
  if (items.length <= k) return items.sort((a, b) => score(b) - score(a));
  // Partial selection: sort a copy once when large; still O(n log n) but only on the matched subset.
  return items.sort((a, b) => score(b) - score(a)).slice(0, k);
}

/** Speed-search style fuzzy matching (DataGrip / VS Code quick open). */
export interface FuzzyResult {
  score: number;
  /** Indexes in `text` of matched characters, for highlighting. */
  positions: number[];
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const ch = text[i];
  if (prev === '_' || prev === '.' || prev === ' ' || prev === '-' || prev === '/' || prev === '$') return true;
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase(); // camelCase hump
}

/**
 * Returns null when `pattern` is not a subsequence of `text` (case-insensitive).
 * Higher score is better: exact > prefix > word-start hits > contiguous runs > scattered.
 */
export function fuzzyMatch(pattern: string, text: string): FuzzyResult | null {
  if (!pattern) return { score: 0, positions: [] };
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  if (p.length > t.length) return null;

  if (t === p) return { score: 1000, positions: range(0, p.length) };
  const idx = t.indexOf(p);
  if (idx === 0) return { score: 900 - t.length, positions: range(0, p.length) };

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
  if (idx > 0) score += 60; // contiguous substring somewhere
  score += 100 - Math.min(t.length, 100) / 2;
  return { score, positions };
}

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i < b; i++) r.push(i);
  return r;
}

/** Filters and sorts `items` by fuzzy score of `key(item)`. */
export function fuzzyFilter<T>(items: readonly T[], pattern: string, key: (t: T) => string, limit = Infinity) {
  if (!pattern) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, positions: [] } as FuzzyResult }));
  const out: { item: T; match: FuzzyResult }[] = [];
  for (const item of items) {
    const m = fuzzyMatch(pattern, key(item));
    if (m) out.push({ item, match: m });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}

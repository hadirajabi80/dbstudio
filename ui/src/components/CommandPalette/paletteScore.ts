// Command palette matching (design-20). Plain subsequence matching is too noisy for short command titles ("code"
// matched "Toggle compact density", "Disconnect all", "Command palette"), so a query only matches a field when it is
// a contiguous substring of it, or when it splits into chunks that each start at a word start ("newcon" → New
// console, "tgres" → Toggle results). Title matches rank above keyword matches, which rank above category matches.

export interface PaletteMatch {
  score: number;
  /** Matched character indexes in the title (highlighting); empty for keyword/category matches. */
  positions: number[];
  /** Which field matched. */
  field: 'title' | 'keywords' | 'category';
  /** Length of the shortest matched chunk (the query length for a contiguous match). */
  minChunk: number;
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const p = text[i - 1];
  const ch = text[i];
  if (/[\s_./\\:,;()[\]{}'"`<>|&+*=-]/.test(p)) return true;
  if (/[0-9]/.test(p)) return !/[0-9]/.test(ch);
  return p === p.toLowerCase() && ch !== ch.toLowerCase();
}

/**
 * Match `q` (lower-case, no spaces) against `text` as chunks that each start at a word start. Returns the positions,
 * or null. Small recursive search: titles are short.
 */
function chunkMatch(q: string, text: string, lower: string): number[] | null {
  const starts: number[] = [];
  for (let i = 0; i < lower.length; i++) if (isWordStart(text, i) && /\S/.test(text[i])) starts.push(i);
  const go = (qi: number, from: number): number[] | null => {
    if (qi === q.length) return [];
    for (const s of starts) {
      if (s < from || lower[s] !== q[qi]) continue;
      // Longest chunk first, then shorter ones (backtracking).
      let len = 1;
      while (qi + len < q.length && s + len < lower.length && lower[s + len] === q[qi + len]) len++;
      for (let l = len; l >= 1; l--) {
        const rest = go(qi + l, s + l);
        if (rest) return [...Array.from({ length: l }, (_, k) => s + k), ...rest];
      }
    }
    return null;
  };
  return go(0, 0);
}

/** Score of `query` against one field; null when it does not match well enough. */
export function fieldMatch(query: string, text: string): { score: number; positions: number[]; minChunk: number } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [], minChunk: 0 };
  const lower = text.toLowerCase();
  // Words of the query in order ("new con") are the same as one query.
  const idx = lower.indexOf(q);
  if (idx >= 0) {
    const atWord = isWordStart(text, idx);
    const score = (idx === 0 ? 1000 : atWord ? 900 : 700) - Math.min(text.length, 80) - idx;
    return { score, positions: Array.from({ length: q.length }, (_, k) => idx + k), minChunk: q.length };
  }
  // The spaced form ("tog res") is also tried as a contiguous phrase without spaces above; now word-start chunks.
  const pos = chunkMatch(q, text, lower);
  if (!pos) return null;
  let chunks = 1;
  let run = 1;
  let minChunk = Infinity;
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] === pos[i - 1] + 1) run++;
    else {
      chunks++;
      minChunk = Math.min(minChunk, run);
      run = 1;
    }
  }
  minChunk = Math.min(minChunk, run);
  // Acronyms ("nc" → New console) and multi-word prefixes are fine; long queries that only match as many 1–2 letter
  // fragments are noise.
  const avg = q.length / chunks;
  if (q.length >= 4 && avg < 2) return null;
  const score = 500 - chunks * 40 - Math.min(text.length, 80) / 2 - pos[0];
  return { score, positions: pos, minChunk };
}

/** Best match of a palette command; title > keywords > category. */
export function paletteMatch(query: string, c: { title: string; category: string; keywords?: string }): PaletteMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, positions: [], field: 'title', minChunk: 0 };
  const t = fieldMatch(q, c.title);
  if (t) return { score: t.score + 2000, positions: t.positions, field: 'title', minChunk: t.minChunk };
  // "Query: run" style queries: the category prefix is part of the label people see.
  const label = `${c.category}: ${c.title}`;
  const l = fieldMatch(q, label);
  if (l && l.positions[0] < c.category.length + 2 && l.positions[l.positions.length - 1] >= c.category.length + 2) {
    return { score: l.score + 1500, positions: l.positions.map((p) => p - c.category.length - 2).filter((p) => p >= 0), field: 'title', minChunk: l.minChunk };
  }
  if (c.keywords) {
    let best: { score: number; minChunk: number } | null = null;
    for (const kw of c.keywords.split(/[\s,]+/).filter(Boolean)) {
      const m = fieldMatch(q, kw);
      if (m && (!best || m.score > best.score)) best = m;
    }
    const whole = fieldMatch(q, c.keywords);
    if (whole && (!best || whole.score > best.score)) best = whole;
    if (best) return { score: best.score + 1000, positions: [], field: 'keywords', minChunk: best.minChunk };
  }
  const cat = fieldMatch(q, c.category);
  if (cat) return { score: cat.score, positions: [], field: 'category', minChunk: cat.minChunk };
  return null;
}

/**
 * Rank palette hits and drop the noisy ones: when some command contains the query as a word or substring, fragment
 * matches made of 1–2 letter pieces ("co…de…") are dropped.
 */
export function rankPalette<T>(hits: readonly { item: T; match: PaletteMatch }[], query: string): { item: T; match: PaletteMatch }[] {
  const q = query.trim().replace(/\s+/g, '');
  const strong = hits.some((h) => h.match.minChunk >= q.length);
  const kept = strong && q.length >= 3 ? hits.filter((h) => h.match.minChunk >= 3 || h.match.minChunk >= q.length) : [...hits];
  return kept.sort((a, b) => b.match.score - a.match.score);
}

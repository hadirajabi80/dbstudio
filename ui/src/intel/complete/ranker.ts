// Ranking and fuzzy matching (PLAN 4.13).

/** Split a label into word segments on `_`, `$`, `#`, spaces, digits and camelCase humps. */
export function segments(label: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (ch === '_' || ch === ' ' || ch === '$' || ch === '#' || ch === '.' || ch === '-') {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    const prev = label[i - 1];
    const next = label[i + 1];
    const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
    const prevLower = prev !== undefined && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
    const prevUpper = prev !== undefined && prev !== prev.toLowerCase();
    const nextLower = next !== undefined && next === next.toLowerCase() && next !== next.toUpperCase();
    const isDigit = ch >= '0' && ch <= '9';
    const prevDigit = prev !== undefined && prev >= '0' && prev <= '9';
    if (cur && ((isUpper && (prevLower || (prevUpper && nextLower))) || (isDigit !== prevDigit))) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Can `p` be matched as prefixes of successive segments (segments may be skipped)? */
function wordStartMatch(p: string, segs: string[]): { ok: boolean; skippedFirst: boolean } {
  const pl = p.toLowerCase();
  const sl = segs.map((s) => s.toLowerCase());
  const memo = new Map<number, boolean>();
  const rec = (pi: number, si: number): boolean => {
    if (pi === pl.length) return true;
    if (si >= sl.length) return false;
    const key = pi * 1000 + si;
    const m = memo.get(key);
    if (m !== undefined) return m;
    let res = false;
    for (let s = si; s < sl.length && !res; s++) {
      const seg = sl[s];
      let k = 0;
      while (k < seg.length && pi + k < pl.length && seg[k] === pl[pi + k]) {
        k++;
        if (rec(pi + k, s + 1)) { res = true; break; }
      }
    }
    memo.set(key, res);
    return res;
  };
  if (sl.length === 0) return { ok: false, skippedFirst: false };
  // prefer matches anchored at the first segment
  const first = sl[0];
  let anchored = false;
  for (let k = 1; k <= Math.min(first.length, pl.length) && !anchored; k++) {
    if (first.slice(0, k) === pl.slice(0, k) && rec(k, 1)) anchored = true;
  }
  if (anchored) return { ok: true, skippedFirst: false };
  return { ok: rec(0, 0), skippedFirst: true };
}

/** VS Code-like subsequence score: contiguous runs score higher, gaps are penalised. Returns 0..1 or -1. */
function subsequence(p: string, l: string): number {
  const pl = p.toLowerCase(), ll = l.toLowerCase();
  let pi = 0, runs = 0, gaps = 0, last = -2;
  for (let i = 0; i < ll.length && pi < pl.length; i++) {
    if (ll[i] === pl[pi]) {
      if (i !== last + 1) { runs++; if (last >= 0) gaps += i - last - 1; }
      last = i;
      pi++;
    }
  }
  if (pi < pl.length) return -1;
  return Math.max(0, 1 - (runs - 1) * 0.2 - gaps * 0.02);
}

/**
 * Match score (PLAN 4.13): exact 100 > case-insensitive prefix 90 > word-start 70 > substring 50 > subsequence 30.
 * Returns -1 when there is no match. Shorter labels win ties (small length penalty).
 */
export function matchScore(prefix: string, label: string): number {
  if (!prefix) return 0;
  const raw = prefix;
  // spaces inside a quoted prefix (`[Order `) act as word separators
  const p = raw.replace(/\s+/g, '');
  if (!p) return 0;
  const lenPenalty = Math.min(5, Math.floor(Math.max(0, label.length - p.length) / 3));
  if (label === raw || label === p) return 100;
  const ll = label.toLowerCase(), pl = p.toLowerCase();
  if (ll === pl) return 96;
  if (ll.startsWith(pl)) return 90 - lenPenalty;
  const segs = segments(label);
  if (pl.includes('_')) {
    const parts = pl.split('_').filter(Boolean);
    let si = 0, ok = true;
    for (const part of parts) {
      const lower = segs.map((s) => s.toLowerCase());
      while (si < lower.length && !lower[si].startsWith(part)) si++;
      if (si >= lower.length) { ok = false; break; }
      si++;
    }
    if (ok && parts.length) return 70 - lenPenalty;
  }
  const ws = wordStartMatch(pl, segs);
  if (ws.ok && segs.length > 1) return (ws.skippedFirst ? 62 : 70) - lenPenalty;
  if (ll.includes(pl)) return 50 - lenPenalty;
  if (pl.length >= 3) {
    const s = subsequence(pl, ll);
    if (s >= 0) return Math.round(20 + 10 * s) - lenPenalty;
  }
  return -1;
}

/** Higher score sorts first; two decimals of the score are kept so small tie-breakers survive. */
export function sortTextFor(score: number): string {
  const v = Math.max(0, Math.min(9999999, 9999999 - Math.round(score * 100)));
  return v.toString().padStart(7, '0');
}

const EPOCH = Date.UTC(2026, 0, 1);
const HALF_LIFE_MS = 14 * 24 * 3600 * 1000;

/**
 * MRU/frequency usage store. Each accepted item adds 2^((now − epoch)/halfLife), so the stored value is a
 * frequency that decays with age without storing timestamps (fits `Record<string, number>`).
 */
export class UsageStore {
  private map: Record<string, number>;
  private readonly now: () => number;
  constructor(initial?: Record<string, number>, now: () => number = () => Date.now()) {
    this.map = { ...(initial ?? {}) };
    this.now = now;
  }
  set(record: Record<string, number> | undefined): void { this.map = { ...(record ?? {}) }; }
  toRecord(): Record<string, number> { return { ...this.map }; }
  private scale(): number { return Math.pow(2, (this.now() - EPOCH) / HALF_LIFE_MS); }
  record(key: string): void {
    this.map[key] = (this.map[key] ?? 0) + this.scale();
    const keys = Object.keys(this.map);
    if (keys.length > 2000) {
      keys.sort((a, b) => this.map[a] - this.map[b]);
      for (const k of keys.slice(0, keys.length - 1500)) delete this.map[k];
    }
  }
  /** 0..15 */
  boost(key: string | undefined): number {
    if (!key) return 0;
    const v = this.map[key];
    if (!v) return 0;
    const decayed = v / this.scale();
    return Math.min(15, Math.round(6 * Math.log2(1 + decayed)));
  }
}

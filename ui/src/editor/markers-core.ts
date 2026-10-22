// Conversion of soft (intel), server (POST /sql/diagnostics) and external diagnostics into Monaco marker data.
// Pure: severities are passed in so this module has no Monaco import.
import type { ServerDiagnostic } from '../api/types';
import type { Diagnostic } from '../intel';

export const MARKER_OWNERS = { soft: 'dbstudio-semantic', server: 'dbstudio-syntax', external: 'dbstudio-external' } as const;

export interface MarkerSeverities { error: number; warning: number; info: number }

export interface MarkerLike {
  startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number;
  severity: number; message: string; code?: string; source?: string;
}

export function softMarkers(diags: Diagnostic[], sev: MarkerSeverities): MarkerLike[] {
  return diags.map((d) => ({
    startLineNumber: d.line, startColumn: d.col,
    endLineNumber: d.endLine, endColumn: d.endLine === d.line && d.endCol <= d.col ? d.col + 1 : d.endCol,
    severity: sev[d.severity], message: d.message, code: d.code, source: 'Rowlit',
  }));
}

/**
 * Server/external diagnostics carry 1-based document positions. An empty range is widened to the word at that
 * position (via `wordEnd`) or one character.
 */
export function serverMarkers(diags: ServerDiagnostic[], sev: MarkerSeverities, source: string, wordEnd?: (line: number, col: number) => number | null): MarkerLike[] {
  return diags.map((d) => {
    let endLine = d.endLine || d.line;
    let endCol = d.endCol || d.col;
    if (endLine < d.line || (endLine === d.line && endCol <= d.col)) {
      endLine = d.line;
      endCol = wordEnd?.(d.line, d.col) ?? d.col + 1;
      if (endCol <= d.col) endCol = d.col + 1;
    }
    return {
      startLineNumber: Math.max(1, d.line), startColumn: Math.max(1, d.col), endLineNumber: endLine, endColumn: endCol,
      severity: sev[d.severity], message: d.message, code: d.code ?? undefined, source,
    };
  });
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions), case-insensitive. */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/**
 * Closest known identifier to a misspelt `name` ("Custmers" → "Customers"), or null when nothing is close enough
 * (at most 1 edit for short names, about one per four characters otherwise). Exact (case-insensitive) matches are
 * not suggestions.
 */
export function suggestIdentifier(name: string, candidates: readonly string[]): string | null {
  const n = name.trim();
  if (n.length < 2) return null;
  const max = Math.max(1, Math.floor(n.length / 4));
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (Math.abs(c.length - n.length) > max) continue;
    if (c.toLowerCase() === n.toLowerCase()) return null;
    const d = editDistance(n, c);
    if (d <= max && (d < bestD || (d === bestD && best !== null && c.length < best.length))) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export interface QuickFix {
  title: string;
  /** The marker the fix belongs to (Monaco code action diagnostics). */
  marker: MarkerLike;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
}

/** Marker codes of unknown objects (intel soft diagnostics) and the kind of name they are about. */
const UNKNOWN_CODES: Record<string, 'table' | 'column'> = { 'unknown-table': 'table', 'unknown-column': 'column' };

/**
 * "Did you mean …?" quick fixes for unknown-table / unknown-column markers: `wordAt` reads the marked text,
 * `candidates` lists the known names of that kind. The same suggestion the Messages pane shows for the error.
 */
export function didYouMeanFixes(
  markers: readonly MarkerLike[],
  wordAt: (m: MarkerLike) => string,
  candidates: (kind: 'table' | 'column') => readonly string[],
): QuickFix[] {
  const out: QuickFix[] = [];
  for (const m of markers) {
    const kind = m.code ? UNKNOWN_CODES[m.code] : undefined;
    if (!kind) continue;
    const word = wordAt(m).replace(/^[[\]"`]+|[[\]"`]+$/g, '');
    const s = suggestIdentifier(word, candidates(kind));
    if (!s) continue;
    out.push({
      title: `Did you mean ${s}? Replace “${word}”`,
      marker: m,
      range: { startLineNumber: m.startLineNumber, startColumn: m.startColumn, endLineNumber: m.endLineNumber, endColumn: m.endColumn },
      text: s,
    });
  }
  return out;
}

/** Debounce + supersede helper for server diagnostics: only the latest request's result is applied. */
export class LatestRequest<T> {
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delay: number;
  constructor(delay: number) { this.delay = delay; }
  schedule(run: () => Promise<T>, apply: (value: T) => void): void {
    if (this.timer) clearTimeout(this.timer);
    const my = ++this.seq;
    this.timer = setTimeout(() => {
      this.timer = null;
      run().then((v) => { if (my === this.seq) apply(v); }, () => { /* stale or failed: ignore */ });
    }, this.delay);
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.seq++;
  }
}

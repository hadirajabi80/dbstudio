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
    severity: sev[d.severity], message: d.message, code: d.code, source: 'DbStudio',
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

// Section of an object tab asked for by a command ("Show dependencies" opens the tab on its Dependencies section).
// The object tab consumes the request; `seq` makes a repeated request for the same section distinct.
import { create } from 'zustand';

export type ObjectSectionId = 'ddl' | 'columns' | 'indexes' | 'fks' | 'refs' | 'params' | 'deps';

/** Find in database: put the cursor on this text in the DDL, on the occurrence nearest to `line`. */
export interface DdlReveal {
  text: string;
  /** 1-based line of the match in the server's definition (the DDL shown may start a few lines earlier or later). */
  line: number | null;
  matchCase: boolean;
}

interface SectionRequest {
  section: ObjectSectionId;
  seq: number;
  reveal?: DdlReveal;
}

interface SectionRequests {
  requests: Record<string, SectionRequest>;
}

let seq = 0;

export const useObjectSectionRequests = create<SectionRequests>(() => ({ requests: {} }));

export function requestObjectSection(tabId: string, section: ObjectSectionId, reveal?: DdlReveal): void {
  useObjectSectionRequests.setState((s) => ({ requests: { ...s.requests, [tabId]: { section, seq: ++seq, ...(reveal ? { reveal } : {}) } } }));
}

/**
 * Where to put the cursor for a reveal: the occurrence of `text` whose line is nearest to `line` (case-insensitive when
 * the search was). 1-based line and columns; null when the text does not occur.
 */
export function findReveal(doc: string, r: DdlReveal): { line: number; col: number; endCol: number } | null {
  if (!r.text) return null;
  const lines = doc.split('\n');
  const needle = r.matchCase ? r.text : r.text.toLowerCase();
  let best: { line: number; col: number; endCol: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const hay = r.matchCase ? lines[i] : lines[i].toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    const cand = { line: i + 1, col: at + 1, endCol: at + 1 + r.text.length };
    if (!best || (r.line !== null && Math.abs(cand.line - r.line) < Math.abs(best.line - r.line))) best = cand;
    if (r.line === null) break;
  }
  return best;
}

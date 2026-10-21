// What to run for Ctrl+Enter / F5 (pure, unit-tested).
import type { Intel } from '../intel';
import type { RunLabel, SqlBatch } from '../api/types';

export interface RunTarget {
  label: RunLabel;
  batches: SqlBatch[];
  text: string;
  /** Document offsets of the run range (flash highlight). */
  range: [number, number];
}

/**
 * - `statement`: the selection if there is one, else the statement at the cursor.
 * - `selection`: the selection (falls back to the statement at the cursor).
 * - `script`: the selection if there is one, else the whole document.
 *
 * `ignoreSelection` resolves as if nothing were selected (Ctrl+S in an "Edit:" console saves the whole document).
 */
export function resolveRunTarget(
  intel: Intel, uri: string, label: RunLabel, cursor: number, selection: [number, number] | null, opts: { ignoreSelection?: boolean } = {},
): RunTarget | null {
  const text = intel.getText(uri);
  const sel = !opts.ignoreSelection && selection && selection[1] > selection[0] && text.slice(selection[0], selection[1]).trim() ? selection : null;
  if (sel) {
    const batches = intel.batchesFor(uri, sel);
    if (!batches.length) return null;
    return { label: 'selection', batches, text: text.slice(sel[0], sel[1]), range: sel };
  }
  if (label === 'script') {
    if (!text.trim()) return null;
    const batches = intel.batchesFor(uri);
    if (!batches.length) return null;
    return { label: 'script', batches, text, range: [0, text.length] };
  }
  const st = intel.statementAt(uri, cursor);
  if (!st) return null;
  if (st.skipOnRun) return { label: 'statement', batches: [], text: st.text, range: [st.start, st.end] };
  return {
    label: 'statement',
    batches: [{ sql: st.execText ?? st.text, line: st.line, col: st.col }],
    text: st.text,
    range: [st.start, st.end],
  };
}

// Editor actions of WP-H: format document / selection with cursor preservation, Ctrl+J snippet picker, explain.
import * as monaco from './monaco';
import type { Dialect, ExplainMode, FormatOptions } from '../api/types';
import { formatRange, formatSql, mapOffset, type FormatWarning } from '../format';
import type { ModelBinding } from './registry';
import { resolveRunTarget } from './run-target';
import { getEditorConfig, type ExplainTarget } from './config';

export const FORMAT_MARKER_OWNER = 'dbstudio.format';

function warningMarkers(model: monaco.editor.ITextModel, warnings: FormatWarning[]): monaco.editor.IMarkerData[] {
  return warnings.map((w) => {
    const line = Math.min(Math.max(1, w.line), model.getLineCount());
    return {
      severity: monaco.MarkerSeverity.Warning, message: w.message, source: 'formatter', code: 'FORMAT_SKIPPED',
      startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line),
    };
  });
}

function apply(ed: monaco.editor.IStandaloneCodeEditor, range: monaco.Range, text: string, cursorOffset: number | null): void {
  const model = ed.getModel()!;
  ed.pushUndoStop();
  ed.executeEdits('dbstudio.format', [{ range, text, forceMoveMarkers: true }]);
  ed.pushUndoStop();
  if (cursorOffset !== null) {
    const pos = model.getPositionAt(cursorOffset);
    ed.setPosition(pos);
    ed.revealPositionInCenterIfOutsideViewport(pos);
  }
}

/** Format the whole document. Returns the warnings (statements left unformatted). */
export function formatDocument(ed: monaco.editor.IStandaloneCodeEditor, dialect: Dialect, opts: Partial<FormatOptions> | null): FormatWarning[] {
  const model = ed.getModel();
  if (!model || ed.getOption(monaco.editor.EditorOption.readOnly)) return [];
  const text = model.getValue();
  const r = formatSql(text, dialect, opts);
  monaco.editor.setModelMarkers(model, FORMAT_MARKER_OWNER, []);
  if (r.text !== text) {
    const pos = ed.getPosition();
    const cursor = pos ? mapOffset(r, model.getOffsetAt(pos)) : null;
    apply(ed, model.getFullModelRange(), r.text, cursor);
  }
  monaco.editor.setModelMarkers(model, FORMAT_MARKER_OWNER, warningMarkers(model, r.warnings));
  return r.warnings;
}

/** Format the statements intersecting the selection (or the statement at the cursor). */
export function formatSelection(ed: monaco.editor.IStandaloneCodeEditor, dialect: Dialect, opts: Partial<FormatOptions> | null): FormatWarning[] {
  const model = ed.getModel();
  const sel = ed.getSelection();
  if (!model || !sel || ed.getOption(monaco.editor.EditorOption.readOnly)) return [];
  const text = model.getValue();
  const r = formatRange(text, dialect, [model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition())], opts);
  if (!r) return [];
  const a = model.getPositionAt(r.range[0]), z = model.getPositionAt(r.range[1]);
  const range = new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column);
  if (model.getValueInRange(range) !== r.text) {
    const pos = ed.getPosition();
    let cursor: number | null = null;
    if (pos) {
      const off = model.getOffsetAt(pos);
      cursor = off >= r.range[0] && off <= r.range[1] ? mapOffset({ text: text.slice(0, r.range[0]) + r.text, warnings: [], mapping: r.mapping }, off) : null;
    }
    apply(ed, range, r.text, cursor);
  }
  const shift = (w: FormatWarning) => ({ ...w, line: w.line + a.lineNumber - 1 });
  monaco.editor.setModelMarkers(model, FORMAT_MARKER_OWNER, warningMarkers(model, r.warnings.map(shift)));
  return r.warnings;
}

/** Ctrl+J: open the suggest widget with snippets only. */
export function openSnippetPicker(ed: monaco.editor.IStandaloneCodeEditor, b: ModelBinding | undefined): void {
  if (!b || ed.getOption(monaco.editor.EditorOption.readOnly)) return;
  b.snippetPicker = true;
  ed.focus();
  ed.trigger('dbstudio', 'editor.action.triggerSuggest', {});
  // a request that never reaches the provider (no model, widget already open) must not leave the flag set
  setTimeout(() => { b.snippetPicker = false; }, 500);
}

/** The statement (or selection) to explain, or null when the cursor is on nothing. */
export function explainTarget(ed: monaco.editor.IStandaloneCodeEditor, b: ModelBinding, mode: ExplainMode): ExplainTarget | null {
  const model = ed.getModel();
  if (!model) return null;
  const sel = ed.getSelection();
  const pos = ed.getPosition();
  const cursor = pos ? model.getOffsetAt(pos) : 0;
  const selection: [number, number] | null = sel && !sel.isEmpty() ? [model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition())] : null;
  const t = resolveRunTarget(b.intel, b.uri, 'statement', cursor, selection);
  if (!t || !t.batches.length) return null;
  return { tabId: b.tabId ?? '', dialect: b.dialect ?? b.intel.dialect, mode, batch: t.batches[0] };
}

/** Run explain through the editor's `onExplain` prop or the app-wide handler. Returns false when nothing ran. */
export function runExplain(ed: monaco.editor.IStandaloneCodeEditor, b: ModelBinding | undefined, mode: ExplainMode, handler?: ((t: ExplainTarget) => void) | null): boolean {
  if (!b) return false;
  const t = explainTarget(ed, b, mode);
  const h = handler ?? getEditorConfig().explain;
  if (!t || !h) return false;
  dismissEditorPopups(ed);
  h(t);
  return true;
}

/**
 * Close the suggest list and the parameter hints before a run or explain (styles-r1-05): left open, they cover the
 * editor and the results, and the next Enter or Tab would accept a suggestion.
 */
export function dismissEditorPopups(ed: Pick<monaco.editor.ICodeEditor, 'trigger'>): void {
  ed.trigger('run', 'hideSuggestWidget', null);
  ed.trigger('run', 'closeParameterHints', null);
}

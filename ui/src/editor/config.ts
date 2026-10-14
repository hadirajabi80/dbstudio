// App-wide editor configuration that is not part of Settings.editor: formatter options, user snippets and the
// explain handler. editor/commands.ts keeps it in sync with the settings store; SqlEditor props override it.
import type { Dialect, ExplainMode, FormatOptions, Snippet, SqlBatch } from '../api/types';

export interface ExplainTarget {
  tabId: string;
  dialect: Dialect;
  mode: ExplainMode;
  /** The statement (or selection) to explain, with its document position. */
  batch: SqlBatch;
}

export interface EditorConfig {
  format: Partial<FormatOptions> | null;
  snippets: readonly Snippet[];
  /** Explain the statement at the cursor (wired by the app: POST /sessions/{sid}/explain + plan tab). */
  explain: ((t: ExplainTarget) => void) | null;
}

const G = globalThis as unknown as { __dbstudioEditorConfig?: { cfg: EditorConfig; listeners: Set<() => void> } };
const state = (G.__dbstudioEditorConfig ??= { cfg: { format: null, snippets: [], explain: null }, listeners: new Set() });

export function getEditorConfig(): EditorConfig {
  return state.cfg;
}

export function setEditorConfig(patch: Partial<EditorConfig>): void {
  state.cfg = { ...state.cfg, ...patch };
  for (const l of state.listeners) l();
}

export function onEditorConfigChange(fn: () => void): () => void {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

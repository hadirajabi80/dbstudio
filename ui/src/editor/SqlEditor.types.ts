// Contract between the app shell (WP-C) and the IntelliSense editor (WP-D).
// WP-D implements `SqlEditor` in ./SqlEditor.tsx with exactly these props and handle.

import type {
  CatalogSnapshot, CatalogObject, Dialect, ObjectRef, RunLabel, ServerDiagnostic, Settings, SqlBatch,
} from '../api/types';

export interface SqlEditorProps {
  /** Stable id of the editor tab; used as the model URI. */
  tabId: string;
  dialect: Dialect;
  /** Latest catalog for the tab's connection/database, or null while loading / disconnected. */
  catalog: CatalogSnapshot | null;
  value: string;
  onChange: (value: string) => void;
  /**
   * User asked to run. The editor resolves what to run (statement at cursor, selection, or whole script),
   * splits it into batches with document line/col, and highlights the range briefly.
   */
  onRun: (label: RunLabel, batches: SqlBatch[]) => void;
  /** Esc while running. */
  onCancel?: () => void;
  /** F12 / Ctrl+click on a catalog object. */
  onOpenObject?: (ref: ObjectRef) => void;
  /**
   * Hard syntax diagnostics from the engine (POST /sql/diagnostics). The editor debounces (400 ms) and
   * discards stale responses. Omit to disable.
   */
  requestServerDiagnostics?: (sql: string) => Promise<ServerDiagnostic[]>;
  /** Oracle: resolve an unknown identifier as a PUBLIC synonym (lazy). Returns the target object or null. */
  resolvePublicSynonym?: (name: string) => Promise<CatalogObject | null>;
  /** Called when completion needs a schema that is not loaded yet (user typed `schema.`). */
  requestSchema?: (schema: string) => void;
  /** Extra markers pushed by the app (e.g. errors from the last execution, Oracle ALL_ERRORS). Lines are document lines. */
  externalDiagnostics?: ServerDiagnostic[];
  readOnly?: boolean;
  theme: 'light' | 'dark';
  settings: Settings['editor'];
  /** Persisted completion-usage stats (MRU). The editor calls onUsageChange to persist updates. */
  usage?: Record<string, number>;
  onUsageChange?: (usage: Record<string, number>) => void;
  /** Cursor moved: 1-based line/col, for the status bar. */
  onCursorChange?: (line: number, col: number) => void;
}

export interface SqlEditorHandle {
  focus(): void;
  /** Same resolution the editor uses for Ctrl+Enter. Null when the document is empty. */
  getRunTarget(label: RunLabel): { batches: SqlBatch[]; text: string } | null;
  insertText(text: string): void;
  revealLine(line: number, col?: number): void;
  getValue(): string;
}

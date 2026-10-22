// Imperative handle of each mounted grid, so keyboard commands (PLAN-M1.5 section 3 registry) can act on the
// grid that has focus without prop drilling.

export interface GridController {
  key: string;
  editable: boolean;
  openFilter(column?: string): void;
  /** Quick-filter menu for the focused cell (Ctrl+Alt+F). */
  quickFilterCell(): void;
  clearFilter(): void;
  applyServerFilter?(): void;
  /** Save the pending edits (directly; the SQL preview only when settings.grid.showSqlBeforeSave is on). */
  submit?(): void;
  /** Open the SQL preview of the pending edits. */
  previewChanges?(): void;
  /** Copy the SQL of the pending edits. */
  copyChangesSql?(): void;
  undo?(): void;
  redo?(): void;
  setNull?(): void;
  insertRow?(): void;
  deleteRows?(): void;
  revertAll?(): void;
  toggleRecordView?(): void;
  loadMore?(): void;
  refresh?(): void;
  hasPending?(): boolean;
  /** Commit an open in-place editor like Enter does (before submit / dialogs). */
  commitEdit?(): Promise<void>;
  /** Open the in-place editor on the focused cell (F2 / context menu). */
  editCell?(): void;
  /** Copy the selection (or every visible row when nothing / `all` is selected) in a format. */
  copyAs?(format: import('../../lib/serialize').CopyFormat, all?: boolean): void;
  /** Export the whole result (engine-side when possible). */
  exportAs?(format: import('./clientExport').FileFormat): void;
  /** Client-side export of the visible rows (filter, sort and committed edits applied; full values fetched). */
  exportVisible?(format: import('./clientExport').FileFormat, o: { baseName: string; note?: string | null }): Promise<void>;
  toggleValueViewer?(): void;
  clearSort?(): void;
  hasSort?(): boolean;
  copyColumnNames?(): void;
  /**
   * Focus the grid (its canvas / focused cell), keeping the selection. False when the grid is not rendered yet or is
   * hidden (a host can retry).
   */
  focus?(): boolean;
}

/**
 * Focus the grid registered under `key` (filter bar closed, tab opened, …). Returns false when there is no such grid
 * or it cannot take focus yet.
 */
export function focusGrid(key: string): boolean {
  const c = controllers.get(key);
  return !!c?.focus && c.focus();
}

const controllers = new Map<string, GridController>();
let active: string | null = null;
const listeners = new Set<() => void>();

export function registerGridController(c: GridController): () => void {
  controllers.set(c.key, c);
  return () => {
    if (controllers.get(c.key) === c) controllers.delete(c.key);
    if (active === c.key) setActiveGridKey(null);
  };
}

export function setActiveGridKey(key: string | null): void {
  if (active === key) return;
  active = key;
  for (const l of [...listeners]) l();
}

export function activeGridController(): GridController | undefined {
  return active ? controllers.get(active) : undefined;
}

export function gridController(key: string): GridController | undefined {
  return controllers.get(key);
}

export function onActiveGridChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

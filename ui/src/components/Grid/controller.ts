// Imperative handle of each mounted grid, so keyboard commands (PLAN-M1.5 section 3 registry) can act on the
// grid that has focus without prop drilling.

export interface GridController {
  key: string;
  editable: boolean;
  openFilter(column?: string): void;
  /** Quick-filter menu for the focused cell (Ctrl+Shift+F). */
  quickFilterCell(): void;
  clearFilter(): void;
  applyServerFilter?(): void;
  submit?(): void;
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

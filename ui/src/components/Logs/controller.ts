// The mounted logs views register a controller per tab; the `logs.*` commands act on the active tab's controller.
// Eager and framework-free (commands.ts imports it).
import type { LogExportFormat } from '../../api/types';
import { useTabs } from '../../store/tabs';
import type { LevelChip, LogsSub } from './open';

export interface LogsController {
  tabId: string;
  connectionId: string;
  sub(): LogsSub;
  setSub(sub: LogsSub): void;
  levelOn(level: LevelChip): boolean;
  toggleLevel(level: LevelChip): void;
  canTail(): boolean;
  tailing(): boolean;
  toggleTail(): void;
  canPause(): boolean;
  togglePause(): void;
  clear(): void;
  focusSearch(): void;
  hasSelection(): boolean;
  copySelected(): void;
  expandSelected(): void;
  canLoadOlder(): boolean;
  loadOlder(): void;
  refresh(): void;
  toggleWrap(): void;
  canExport(): boolean;
  exportAs(format: LogExportFormat): void;
  /** Activity sub-view. */
  canKill(): boolean;
  kill(): void;
  canCancel(): boolean;
  cancelQuery(): void;
  canOpenStatement(): boolean;
  openStatement(): void;
  toggleOnlyActive(): void;
  /** The privilege statement of the current empty state / hint, if any. */
  grant(): string | null;
  copyGrant(): void;
}

const controllers = new Map<string, LogsController>();

export function setLogsController(tabId: string, ctl: LogsController | null): void {
  if (ctl) controllers.set(tabId, ctl);
  else controllers.delete(tabId);
}

export function logsController(tabId: string): LogsController | undefined {
  return controllers.get(tabId);
}

/** Controller of the active tab when it is a logs tab (or of `args.tabId`). */
export function activeLogsController(args?: unknown): LogsController | undefined {
  const fromArgs = args && typeof args === 'object' ? (args as { tabId?: unknown }).tabId : undefined;
  const id = typeof fromArgs === 'string' && fromArgs ? fromArgs : useTabs.getState().activeId;
  return id ? controllers.get(id) : undefined;
}

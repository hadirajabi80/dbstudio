// Opening the "Logs & activity" tab (a `view` tab registered as 'logs'; docs/PLAN-M2.md 8.2). Eager module: keep it
// tiny (the view itself is a lazy chunk).
import { ENGINE_LOG_CID } from '../../api/client.m2';
import { getConnection } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';

export const LOGS_VIEW = 'logs';

export type LogsSub = 'logs' | 'activity';
/** Level chips; `fatal` is grouped with `error`, `unknown` is always shown. */
export type LevelChip = 'debug' | 'info' | 'warn' | 'error';
export const LEVEL_CHIPS: readonly LevelChip[] = ['debug', 'info', 'warn', 'error'];
export type FromPreset = '15m' | '1h' | '24h' | '7d' | 'custom';
export type ActivityMode = 'sessions' | 'locks';

/** Serialisable tab state (persisted with the workspace; no stream ids — streams are re-created on mount). */
export interface LogsTabState {
  /** Connection id or ENGINE_LOG_CID. */
  connectionId: string;
  sub: LogsSub;
  sourceId: string | null;
  levels: LevelChip[];
  from: FromPreset;
  /** ISO datetimes of the custom range (`to: null` = now). */
  fromCustom: string | null;
  to: string | null;
  search: string;
  /** SQL Server error log file index (0 = current). */
  archive: number;
  wrap: boolean;
  tail: boolean;
  onlyActive: boolean;
  activityMode: ActivityMode;
}

export const DEFAULT_LEVELS: LevelChip[] = ['info', 'warn', 'error'];

export function defaultLogsState(connectionId: string): LogsTabState {
  return {
    connectionId, sub: 'logs', sourceId: null, levels: [...DEFAULT_LEVELS], from: '1h', fromCustom: null, to: null, search: '',
    archive: 0, wrap: false, tail: false, onlyActive: false, activityMode: 'sessions',
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** Tolerant read of a persisted state (older or hand-edited workspaces). */
export function normalizeLogsState(raw: unknown, fallbackCid: string | null): LogsTabState {
  const r = isObj(raw) ? raw : {};
  const cid = typeof r.connectionId === 'string' && r.connectionId ? r.connectionId : fallbackCid ?? ENGINE_LOG_CID;
  const d = defaultLogsState(cid);
  const levels = Array.isArray(r.levels) ? (r.levels.filter((l) => LEVEL_CHIPS.includes(l as LevelChip)) as LevelChip[]) : d.levels;
  const from = ['15m', '1h', '24h', '7d', 'custom'].includes(r.from as string) ? (r.from as FromPreset) : d.from;
  return {
    connectionId: cid,
    sub: r.sub === 'activity' ? 'activity' : 'logs',
    sourceId: typeof r.sourceId === 'string' ? r.sourceId : null,
    levels,
    from,
    fromCustom: typeof r.fromCustom === 'string' ? r.fromCustom : null,
    to: typeof r.to === 'string' ? r.to : null,
    search: typeof r.search === 'string' ? r.search : '',
    archive: typeof r.archive === 'number' && r.archive >= 0 ? Math.floor(r.archive) : 0,
    wrap: r.wrap === true,
    tail: r.tail === true,
    onlyActive: r.onlyActive === true,
    activityMode: r.activityMode === 'locks' ? 'locks' : 'sessions',
  };
}

export function logsTabKey(connectionId: string): string {
  return `${connectionId}:logs:`;
}

export function logsTitle(connectionId: string): string {
  if (connectionId === ENGINE_LOG_CID) return 'Logs & activity — Rowlit engine';
  return `Logs & activity — ${getConnection(connectionId)?.name ?? connectionId}`;
}

export interface OpenLogsOptions {
  sub?: LogsSub;
  sourceId?: string;
}

/** Opens (or activates) the logs tab of a connection; `sub` / `sourceId` switch an already open tab. */
export function openLogs(connectionId: string, opts: OpenLogsOptions = {}): string {
  const key = logsTabKey(connectionId);
  const existing = useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === LOGS_VIEW && t.key === key);
  const base = existing ? normalizeLogsState(existing.state, connectionId) : defaultLogsState(connectionId);
  const patch: Partial<LogsTabState> = {};
  if (opts.sub) patch.sub = opts.sub;
  if (opts.sourceId) {
    patch.sourceId = opts.sourceId;
    if (!opts.sub) patch.sub = 'logs';
  }
  const changed = !existing || Object.keys(patch).length > 0;
  return useTabs.getState().openView({
    view: LOGS_VIEW,
    title: logsTitle(connectionId),
    connectionId: connectionId === ENGINE_LOG_CID ? null : connectionId,
    state: changed ? { ...base, ...patch } : undefined,
    key,
  });
}

// Opening Redis tabs (docs/PLAN-M2.md 2.5): one tab per (connection, view); the browser tab is keyed per database,
// so re-opening activates the existing tab. Views: browser, workbench, cli, pubsub, slowlog, info, analysis.
import type { RedisKeyType } from '../../api/types';
import { getConnection } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';

export const REDIS_VIEWS = ['redis.browser', 'redis.workbench', 'redis.cli', 'redis.pubsub', 'redis.slowlog', 'redis.info', 'redis.analysis'] as const;
export type RedisView = (typeof REDIS_VIEWS)[number];

export const VIEW_TITLE: Record<RedisView, string> = {
  'redis.browser': 'Browser', 'redis.workbench': 'Workbench', 'redis.cli': 'CLI', 'redis.pubsub': 'Pub/Sub',
  'redis.slowlog': 'Slowlog', 'redis.info': 'Info', 'redis.analysis': 'Analysis',
};

export const VIEW_ICON: Record<RedisView, string> = {
  'redis.browser': 'Boxes', 'redis.workbench': 'SquareTerminal', 'redis.cli': 'SquareChevronRight', 'redis.pubsub': 'Radio',
  'redis.slowlog': 'Clock', 'redis.info': 'Gauge', 'redis.analysis': 'ChartBar',
};

export interface BrowserState {
  db: number;
  pattern: string;
  type: RedisKeyType | 'all';
  tree: boolean;
  selected: string | null;
}

export interface WorkbenchState { db: number; text: string }
export interface CliState { db: number }
export interface PubSubState { channels: string[]; patterns: string[] }
export interface InfoState { monitor?: boolean }
export interface AnalysisState { db: number }

export function profileDb(cid: string): number {
  const db = Number(getConnection(cid)?.props.db ?? 0);
  return getConnection(cid)?.props.mode === 'cluster' || !Number.isInteger(db) ? 0 : db;
}

export function viewKey(cid: string, view: RedisView, db?: number): string {
  return view === 'redis.browser' ? `${cid}:${view}:${db ?? 0}` : `${cid}:${view}:`;
}

function connName(cid: string): string {
  return getConnection(cid)?.name ?? 'Redis';
}

/** Opens (or activates) a Redis view; `state` patches the existing tab state. Returns the tab id. */
export function openRedisView(cid: string, view: RedisView, state: Record<string, unknown> = {}): string {
  const db = typeof state.db === 'number' ? state.db : profileDb(cid);
  const key = viewKey(cid, view, db);
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.key === key);
  const defaults: Record<RedisView, Record<string, unknown>> = {
    'redis.browser': { db, pattern: '', type: 'all', tree: true, selected: null } satisfies BrowserState,
    'redis.workbench': { db, text: '' } satisfies WorkbenchState,
    'redis.cli': { db } satisfies CliState,
    'redis.pubsub': { channels: [], patterns: [] } satisfies PubSubState,
    'redis.slowlog': {},
    'redis.info': {},
    'redis.analysis': { db } satisfies AnalysisState,
  };
  const prev = (existing?.state ?? defaults[view]) as Record<string, unknown>;
  const title = view === 'redis.browser' ? `${connName(cid)} · db${db}` : `${connName(cid)} · ${VIEW_TITLE[view]}`;
  return tabs.openView({ view, title, connectionId: cid, database: null, state: { ...prev, ...state }, key });
}

export function openBrowser(cid: string, patch: Partial<BrowserState> = {}): string {
  return openRedisView(cid, 'redis.browser', patch);
}

export function openKey(cid: string, db: number, key: string): string {
  return openBrowser(cid, { db, selected: key });
}

export function isRedisView(t: { kind: string; view?: string } | undefined): t is ViewTab {
  return !!t && t.kind === 'view' && typeof t.view === 'string' && t.view.startsWith('redis.');
}

export function activeRedisTab(): ViewTab | null {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return isRedisView(t) ? t : null;
}

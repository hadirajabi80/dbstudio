// Snowflake commands and tab views (plan-batch3 WP-SF), auto-loaded by commands/index.ts as their own lazy chunk:
//   snowflake.session     the session chips of a console: warehouse, role, database, schema (USE … on the tab's session);
//   snowflake.warehouses  SHOW WAREHOUSES with resume / suspend;
//   snowflake.objects     stages, streams, tasks, pipes, file formats, dynamic tables, alerts of a schema with their DDL;
//   snowflake.history     INFORMATION_SCHEMA.QUERY_HISTORY with status, duration, bytes scanned; open in a console.
// The views are one lazy chunk (./views). Commands act on the explorer's connection target or the active tab.
// They are also entries of the explorer's connection menu (extendContextMenu, shown for Snowflake connections only).
import { createElement, lazy, Suspense } from 'react';
import { extendContextMenu } from '../../commands/menuModel';
import { registerDesignerOptionsPanel } from '../../designer/table/optionsPanels';
import { registerCommands, type Command } from '../../commands/registry';
import { isConnectionTarget } from '../../commands/types';
import { getConnection } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';
import { registerTabView, type TabViewProps } from '../layout/tabViews';

export const SF_VIEWS = {
  session: 'snowflake.session',
  warehouses: 'snowflake.warehouses',
  objects: 'snowflake.objects',
  history: 'snowflake.history',
} as const;

type SfView = (typeof SF_VIEWS)[keyof typeof SF_VIEWS];

const isSnowflake = (cid: string | null | undefined): cid is string => !!cid && getConnection(cid)?.providerId === 'snowflake';

/** Connection of the command: an explorer connection target, else the active tab's connection. */
export function sfConnectionOf(args?: unknown): string | null {
  if (isConnectionTarget(args)) return isSnowflake(args.connectionId) ? args.connectionId : null;
  const s = useTabs.getState();
  const tab = s.tabs.find((t) => t.id === s.activeId);
  const cid = tab && 'connectionId' in tab ? tab.connectionId : null;
  return isSnowflake(cid) ? cid : null;
}

/** The console the session view acts on: the active console, else the last Snowflake console of the connection. */
function consoleOf(cid: string): string | null {
  const s = useTabs.getState();
  const active = s.tabs.find((t) => t.id === s.activeId);
  if (active?.kind === 'console' && active.connectionId === cid) return active.id;
  const any = [...s.tabs].reverse().find((t) => t.kind === 'console' && t.connectionId === cid);
  return any?.id ?? null;
}

export interface SfViewState {
  /** snowflake.session: the console whose session the chips change. */
  consoleId?: string | null;
  /** snowflake.objects: kind, database and schema shown. */
  kind?: string;
  database?: string | null;
  schema?: string | null;
}

const TITLES: Record<SfView, string> = {
  'snowflake.session': 'Session',
  'snowflake.warehouses': 'Warehouses',
  'snowflake.objects': 'Objects',
  'snowflake.history': 'Query history',
};

export function openSfView(cid: string, view: SfView, state: SfViewState = {}): string {
  const key = `${cid}:${view}`;
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === view && t.key === key);
  const merged = existing ? { ...(existing.state as object), ...state } : state;
  const name = getConnection(cid)?.name ?? 'Snowflake';
  return tabs.openView({ view, title: `${name} · ${TITLES[view]}`, connectionId: cid, database: null, state: merged, key });
}

const when = (args?: unknown) => !!sfConnectionOf(args);

export const SNOWFLAKE_COMMANDS: Command[] = [
  {
    id: 'snowflake.session',
    title: 'Snowflake: Session (warehouse, role, database, schema)…',
    category: 'Database',
    when: (args) => when(args),
    run: (args) => {
      const cid = sfConnectionOf(args);
      if (cid) openSfView(cid, SF_VIEWS.session, { consoleId: consoleOf(cid) });
    },
  },
  {
    id: 'snowflake.warehouses',
    title: 'Snowflake: Warehouses',
    category: 'Database',
    when: (args) => when(args),
    run: (args) => {
      const cid = sfConnectionOf(args);
      if (cid) openSfView(cid, SF_VIEWS.warehouses);
    },
  },
  {
    id: 'snowflake.objects',
    title: 'Snowflake: Stages, streams, tasks, pipes…',
    category: 'Database',
    when: (args) => when(args),
    run: (args) => {
      const cid = sfConnectionOf(args);
      if (cid) openSfView(cid, SF_VIEWS.objects);
    },
  },
  {
    id: 'snowflake.history',
    title: 'Snowflake: Query history',
    category: 'Database',
    when: (args) => when(args),
    run: (args) => {
      const cid = sfConnectionOf(args);
      if (cid) openSfView(cid, SF_VIEWS.history);
    },
  },
];

const LazyViews = lazy(() => import('./views'));

function SnowflakeTab(p: TabViewProps) {
  return createElement(Suspense, { fallback: null }, createElement(LazyViews, p));
}

const ICONS: Record<SfView, string> = {
  'snowflake.session': 'SlidersHorizontal',
  'snowflake.warehouses': 'Server',
  'snowflake.objects': 'Boxes',
  'snowflake.history': 'History',
};

export function registerSnowflakeCommands(): void {
  registerCommands(SNOWFLAKE_COMMANDS);
  // the table designer's options row (TRANSIENT, retention, change tracking)
  registerDesignerOptionsPanel('snowflake', lazy(() => import('./TableOptions')));
  // the connection menu of Snowflake connections (the commands' `when` needs a Snowflake connection target)
  extendContextMenu('explorer.connection', [
    { command: 'snowflake.session', optional: true, hideDisabled: true, label: 'Session (warehouse, role, database, schema)…' },
    { command: 'snowflake.warehouses', optional: true, hideDisabled: true, label: 'Warehouses' },
    { command: 'snowflake.objects', optional: true, hideDisabled: true, label: 'Stages, streams, tasks, pipes…' },
    { command: 'snowflake.history', optional: true, hideDisabled: true, label: 'Query history' },
  ]);
  for (const view of Object.values(SF_VIEWS)) registerTabView(view, { component: SnowflakeTab, icon: ICONS[view] });
}

// Cassandra / ScyllaDB (plan-batch3 WP-CS): view ids, tab states, openers and the targets the Cassandra commands act
// on. Part of the lazy commands chunk (components/Cassandra/commands.ts); the views themselves are a separate chunk.
import { isConnectionTarget, isContainerTarget, isObjectTarget, type ObjectTarget } from '../../commands/types';
import { getConnection } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useTabs, type ConsoleTab, type Tab, type ViewTab } from '../../store/tabs';
import { useExplorer } from '../Explorer/explorerStore';

export const CASSANDRA_VIEWS = {
  session: 'cassandra.session',
  trace: 'cassandra.trace',
  cluster: 'cassandra.cluster',
  table: 'cassandra.table',
} as const;

/** `cassandra.session`: the settings of one console's session. */
export interface SessionViewState {
  /** The console tab whose session the view edits (its session is created on demand). */
  consoleTabId: string | null;
  /** A session without a console (fallback when `consoleTabId` is null). */
  sessionId?: string | null;
  /** Field to focus when the tab opens ("Set consistency level…"). */
  focus?: 'consistency' | null;
}

/** `cassandra.trace`: one traced request, plus the recent traces of the console's session. */
export interface TraceViewState {
  traceId: string | null;
  consoleTabId?: string | null;
  sessionId?: string | null;
}

/** `cassandra.cluster`: nodes / clients sub-tab. */
export interface ClusterViewState {
  tab?: 'nodes' | 'clients';
}

/** `cassandra.table`: keys, options, indexes, views and size estimate of a table or materialized view. */
export interface TableViewState {
  keyspace: string;
  name: string;
}

export const CASSANDRA_PROVIDER_ID = 'cassandra';

/** Settings of a session changed outside its settings tab (Toggle tracing): an open settings / trace tab reloads. */
export const SETTINGS_CHANGED = 'rowlit:cassandra-settings-changed';

export function settingsChanged(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED, { detail: { sessionId } }));
}

/** Subscribe to settingsChanged() of one session. */
export function onSettingsChanged(sessionId: string, fn: () => void): () => void {
  const h = (e: Event) => {
    if ((e as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) fn();
  };
  window.addEventListener(SETTINGS_CHANGED, h);
  return () => window.removeEventListener(SETTINGS_CHANGED, h);
}

export function isCassandraConnection(cid: string | null | undefined): boolean {
  return !!cid && getConnection(cid)?.providerId === CASSANDRA_PROVIDER_ID;
}

function activeTab(): Tab | undefined {
  const s = useTabs.getState();
  return s.tabs.find((t) => t.id === s.activeId);
}

function consoleById(id: string | null | undefined): ConsoleTab | null {
  if (!id) return null;
  const t = useTabs.getState().tabs.find((x) => x.id === id);
  return t?.kind === 'console' ? t : null;
}

/** The console of a Cassandra settings / trace tab. */
export function consoleOfView(tab: ViewTab): ConsoleTab | null {
  if (tab.view !== CASSANDRA_VIEWS.session && tab.view !== CASSANDRA_VIEWS.trace) return null;
  return consoleById((tab.state as { consoleTabId?: string | null } | null)?.consoleTabId);
}

/**
 * The console the console commands act on: the active console when it is on a Cassandra connection, or the console of
 * the active "Console settings" / "Trace" tab.
 */
export function cassandraConsole(): ConsoleTab | null {
  const t = activeTab();
  if (!t) return null;
  const c = t.kind === 'console' ? t : t.kind === 'view' ? consoleOfView(t) : null;
  return c && isCassandraConnection(c.connectionId) ? c : null;
}

/** The console's engine session id (created like the first run of the console would, when it has none yet). */
export async function consoleSessionId(t: ConsoleTab): Promise<string> {
  const cur = useSessions.getState().forTab(t.id);
  if (cur && cur.state !== 'closed' && cur.connectionId === t.connectionId) return cur.sessionId;
  if (!t.connectionId) throw new Error('The console has no connection.');
  const s = await useSessions.getState().ensure(t.id, t.connectionId, t.database, t.txMode);
  return s.sessionId;
}

/**
 * The Cassandra connection of a command: a connection / object / container target (explorer context menu), else the
 * active tab's connection, else the explorer selection.
 */
export function cassandraConnectionOf(args?: unknown): string | null {
  if (isConnectionTarget(args) || isObjectTarget(args) || isContainerTarget(args)) {
    return isCassandraConnection(args.connectionId) ? args.connectionId : null;
  }
  const t = activeTab();
  const fromTab = t?.kind === 'console' || t?.kind === 'view' || t?.kind === 'object' ? t.connectionId : null;
  if (isCassandraConnection(fromTab)) return fromTab;
  const sel = useExplorer.getState().selectedTarget;
  return sel && 'connectionId' in sel && isCassandraConnection(sel.connectionId) ? sel.connectionId : null;
}

const TABLE_TYPES = new Set(['table', 'mview']);

/** A Cassandra table / materialized view: the target, else the active object tab, else the explorer selection. */
export function cassandraTableOf(args?: unknown): { cid: string; keyspace: string; name: string } | null {
  const of = (t: ObjectTarget | null | undefined) => {
    // keyspaces are the schema level (no database level): the ref's schema, else the console/tab keyspace
    const keyspace = t ? t.ref.schema ?? t.ref.database ?? t.database : null;
    return t && keyspace && isCassandraConnection(t.connectionId) && TABLE_TYPES.has(t.ref.type) ? { cid: t.connectionId, keyspace, name: t.ref.name } : null;
  };
  if (isObjectTarget(args)) return of(args);
  const t = activeTab();
  if (t?.kind === 'object') return of({ kind: 'object', connectionId: t.connectionId, database: t.database, ref: t.ref });
  if (t?.kind === 'view' && t.view === CASSANDRA_VIEWS.table && t.connectionId) {
    const s = t.state as TableViewState;
    return { cid: t.connectionId, keyspace: s.keyspace, name: s.name };
  }
  const sel = useExplorer.getState().selectedTarget;
  return isObjectTarget(sel) ? of(sel) : null;
}

// ---- openers

const connName = (cid: string | null | undefined) => (cid ? getConnection(cid)?.name ?? cid : '');

export function openSessionSettings(t: ConsoleTab, focus: SessionViewState['focus'] = null): string {
  const state: SessionViewState = { consoleTabId: t.id, focus };
  return useTabs.getState().openView({
    view: CASSANDRA_VIEWS.session, title: `Console settings: ${t.title}`, connectionId: t.connectionId, database: t.database,
    state, key: `${CASSANDRA_VIEWS.session}:${t.id}`,
  });
}

export function openTrace(cid: string, traceId: string | null, from: { consoleTabId?: string | null; sessionId?: string | null } = {}): string {
  const state: TraceViewState = { traceId, consoleTabId: from.consoleTabId ?? null, sessionId: from.sessionId ?? null };
  return useTabs.getState().openView({
    view: CASSANDRA_VIEWS.trace, title: `Trace: ${connName(cid)}`, connectionId: cid, state,
    // one trace tab per console (it switches between the console's traces); a trace opened without a console has its own
    key: `${CASSANDRA_VIEWS.trace}:${cid}:${from.consoleTabId ?? traceId ?? ''}`,
  });
}

export function openCluster(cid: string, tab: ClusterViewState['tab'] = 'nodes'): string {
  const state: ClusterViewState = { tab };
  return useTabs.getState().openView({
    view: CASSANDRA_VIEWS.cluster, title: `Cluster: ${connName(cid)}`, connectionId: cid, state, key: `${CASSANDRA_VIEWS.cluster}:${cid}`,
  });
}

export function openTableInfo(cid: string, keyspace: string, name: string): string {
  const state: TableViewState = { keyspace, name };
  return useTabs.getState().openView({
    view: CASSANDRA_VIEWS.table, title: `Table info: ${keyspace}.${name}`, connectionId: cid, database: keyspace, state,
    key: `${CASSANDRA_VIEWS.table}:${cid}:${keyspace}.${name}`,
  });
}

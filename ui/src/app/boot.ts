import { API_PREFIX, configureClient, errorMessage, getClientConfig } from '../api/client';
import type { SessionInfo } from '../api/types';
import { engineSocket } from '../api/ws';
import { hasCommand, runCommand } from '../commands/registry';
import { pluralize } from '../components/common/text';
import { getPlatform } from '../platform';
import { isDetachedWindow } from '../platform/windows';
import { useCatalog } from '../store/catalog';
import { providerKind, useConnections } from '../store/connections';
import { useHistory } from '../store/history';
import { useResults } from '../store/results';
import { useSessions } from '../store/sessions';
import { useSettings } from '../store/settings';
import { useSourceClients } from '../store/sourceClients';
import { useTabs, type WorkspaceData } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import { preloadCatalog } from './actions';
import { bootDetachedTabs, liveDetachedTabs, wireMainWindowTabs } from './detach';
import { MULTIRUN_VIEW, targetTabId, type MultiRunState } from './multiRun';
import { restoreZoom } from './zoom';

let wired = false;

/**
 * Tab key that should own an engine session after a reload: SessionInfo.tabId is the `source.tabId` of its last run.
 * Consoles adopt sessions on their own connection; a multi-run tab adopts one session per target connection.
 */
export function sessionTabKey(s: SessionInfo): string | null {
  if (!s.tabId) return null;
  const tab = useTabs.getState().tabs.find((t) => t.id === s.tabId);
  if (!tab) return null;
  if (tab.kind === 'view' && tab.view === MULTIRUN_VIEW) {
    const st = tab.state as MultiRunState | null;
    return st?.targets.some((t) => t.connectionId === s.connectionId) ? targetTabId(tab.id, s.connectionId) : null;
  }
  return tab.connectionId === s.connectionId ? tab.id : null;
}

let orphanNotified = false;

/**
 * GET /sessions, then re-attach sessions to the open tabs they belong to (so open transactions stay visible after a
 * reload or a reconnect) and announce the rest once: they are listed in the Connections panel with Close /
 * Roll back & close.
 */
export async function reattachSessions(notify = true): Promise<void> {
  await useSessions.getState().refreshAll();
  const adopted = useSessions.getState().adopt(sessionTabKey);
  const { sessions } = useSessions.getState();
  for (const sid of adopted) {
    const s = sessions[sid];
    const tab = useTabs.getState().tabs.find((t) => t.id === s?.tabId);
    // The session's transaction mode wins (an open manual transaction must show its Commit / Roll back buttons).
    if (s && tab?.kind === 'console' && tab.txMode !== s.txMode) useTabs.getState().setTxMode(tab.id, s.txMode);
  }
  const orphans = useSessions.getState().orphans();
  if (!notify || orphanNotified || orphans.length === 0) return;
  orphanNotified = true;
  const tx = orphans.filter((s) => s.txOpen).length;
  toast('warning', `${pluralize(orphans.length, 'unused session')} from an earlier window ${orphans.length === 1 ? 'is' : 'are'} still open`,
    tx ? `${pluralize(tx, 'session')} with an uncommitted transaction. Close or roll them back in Connections.` : 'They count against the session limit. Close them in Connections.',
    { label: 'Show', run: () => useUi.getState().showDock('connections') });
}

/**
 * Browser mode: a closed or reloaded page cannot run async cleanup, so the sessions of its tabs are released with
 * keepalive requests (the fetch form of sendBeacon, which cannot send DELETE or the Authorization header). Sessions
 * with an open transaction are kept: the reloaded page adopts them, or they appear as unused sessions.
 */
function releaseSessionsOnPageHide(): void {
  window.addEventListener('pagehide', () => {
    // A detached window (desktop) that closes takes its consoles' sessions with it, like a browser page.
    if (getPlatform().kind !== 'browser' && !isDetachedWindow()) return;
    const cfg = getClientConfig();
    if (!cfg) return;
    const { sessions, byTab } = useSessions.getState();
    for (const sid of new Set(Object.values(byTab))) {
      const s = sessions[sid];
      if (!s || s.txOpen) continue;
      try {
        void fetch(`${cfg.baseUrl}${API_PREFIX}/sessions/${encodeURIComponent(sid)}?force=true`, {
          method: 'DELETE', keepalive: true, headers: { Authorization: `Bearer ${cfg.token}` },
        }).catch(() => undefined);
      } catch {
        /* the page is going away */
      }
    }
  });
  // Back/forward cache: the page comes back without the sessions released above.
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) void reattachSessions(false);
  });
}

/** Route engine events into the stores. Idempotent. */
export function wireSocket(): void {
  if (wired) return;
  wired = true;
  let wasOpen = false;
  engineSocket.onStatus((s) => {
    useUi.getState().setWsStatus(s);
    // Reconnected (engine still up): the session list may have changed meanwhile.
    if (s === 'open' && wasOpen) void reattachSessions(false);
    if (s === 'open') wasOpen = true;
    // M2: Redis/MongoDB/Kafka clients the engine holds (Connections panel, activity dots, status bar).
    if (s === 'open') void useSourceClients.getState().refresh();
  });
  engineSocket.onAny((ev) => {
    if (ev.type.startsWith('exec.')) useResults.getState().ingest(ev);
  });
  engineSocket.on('exec.done', (ev) => {
    useSessions.getState().applyDone(ev);
    useHistory.getState().reloadSoon();
    announceDone(ev.executionId, ev.status, ev.elapsedMs);
    if (ev.status === 'ok' && !useSettings.getState().settings.ui.firstRunAt && useSettings.getState().loaded) {
      useSettings.getState().update({ ui: { firstRunAt: new Date().toISOString() } });
    }
  });
  engineSocket.on('session.changed', (ev) => {
    useSessions.getState().applyChanged(ev);
    // Engine-wide counts (status bar, dock badge) come from GET /sessions.
    useSessions.getState().refreshSoon(400);
  });
  engineSocket.on('catalog.changed', (ev) => useCatalog.getState().applyChanged(ev));
  engineSocket.on('export.done', (ev) => {
    if (ev.status === 'ok') toast('success', `Exported ${pluralize(ev.rows, 'row')}`, ev.path);
    else toast('error', 'Export failed', ev.error ?? undefined);
  });
  engineSocket.on('source.client', (ev) => useSourceClients.getState().apply(ev.connectionId, ev.state));
  engineSocket.on('engine.log', (ev) => {
    if (ev.level === 'error') toast('error', ev.message, undefined, openEngineLogAction());
  });
}

/** "Open engine log" on engine error toasts (M2-L: the Logs tab of the engine, cid `engine`). */
export function openEngineLogAction(): { label: string; run: () => void } | undefined {
  if (!hasCommand('logs.openEngineLog')) return undefined;
  return { label: 'Open engine log', run: () => void runCommand('logs.openEngineLog') };
}

/** aria-live announcement for the active tab's run ("12 rows, 15 ms" / "Query failed"). */
function announceDone(executionId: string, status: string, elapsedMs: number) {
  const r = useResults.getState();
  const exec = Object.values(r.executions).find((e) => e.executionId === executionId);
  if (!exec || exec.tabId !== useTabs.getState().activeId) return;
  const rows = exec.resultSets.reduce((n, s) => n + s.rowCount, 0);
  const text =
    status === 'ok'
      ? exec.resultSets.length
        ? `${pluralize(rows, 'row')}, ${elapsedMs} ms`
        : `Done${exec.rowsAffected ? `, ${pluralize(exec.rowsAffected, 'row')} affected` : ''}, ${elapsedMs} ms`
      : status === 'cancelled' ? 'Query cancelled' : 'Query failed';
  useUi.getState().announce(text);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function startWorkspaceAutosave(): void {
  useTabs.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.activeId === prev.activeId && s.groups === prev.groups && s.layout === prev.layout && s.detached === prev.detached) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void getPlatform().saveWorkspace(useTabs.getState().serialize());
    }, 800);
  });
  window.addEventListener('beforeunload', () => {
    void getPlatform().saveWorkspace(useTabs.getState().serialize());
  });
}

/** Engine connection info, the socket and the restart handler. False when the engine cannot be reached. */
async function connectEngine(): Promise<boolean> {
  const platform = getPlatform();
  wireSocket();
  try {
    const info = await platform.getEngineInfo();
    configureClient(info);
    engineSocket.connect(info);
  } catch (e) {
    useUi.getState().setEngineError(`Cannot get engine connection info: ${errorMessage(e)}`);
    return false;
  }
  platform.onEngineRestarted((info) => {
    configureClient(info);
    engineSocket.connect(info);
    // Sessions died with the engine; tabs recreate them lazily on the next run.
    useSessions.setState({ sessions: {}, byTab: {} });
    // M2: source clients and streams died too; live views get stream.state{ended, reason: 'engine-restarted'}.
    useSourceClients.getState().reset();
    const streams = engineSocket.endAllStreams('engine-restarted');
    toast('warning', 'The engine was restarted',
      `Open transactions were lost; sessions are recreated on the next run.${streams ? ` ${pluralize(streams, 'live view')} stopped.` : ''}`,
      openEngineLogAction());
  });
  return true;
}

/** Settings and connections; the engine error banner when the engine cannot be reached. Returns the error. */
async function loadBasics(): Promise<string | null> {
  await Promise.all([useSettings.getState().load(), useConnections.getState().load()]);
  restoreZoom();
  const connErr = useConnections.getState().error;
  useUi.getState().setEngineError(connErr ? `Cannot reach the DbStudio engine: ${connErr}` : null);
  return connErr;
}

/** Catalogs of the tabs' connections, one request per connection and database. */
function preloadTabCatalogs(): void {
  const seen = new Set<string>();
  for (const t of useTabs.getState().tabs) {
    if (!t.connectionId) continue;
    const k = `${t.connectionId}|${t.database ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    void preloadCatalog(t.connectionId, t.database);
  }
}

export async function boot(): Promise<void> {
  const platform = getPlatform();
  if (!(await connectEngine())) return;
  const connErr = await loadBasics();

  try {
    // Tabs open in detached windows right now stay there (this window was reloaded); the others come back here.
    const live = await liveDetachedTabs();
    const ws = (await platform.loadWorkspace()) as WorkspaceData | null;
    if (ws) useTabs.getState().restore(ws, { liveDetached: live });
    else if (live.length) useTabs.getState().setDetached(live);
  } catch (e) {
    console.warn('[boot] workspace restore failed', e);
  }
  wireMainWindowTabs();
  const ids = new Set(useConnections.getState().connections.map((c) => c.id));
  // Drop object tabs of deleted connections; keep consoles but unbind them.
  for (const t of useTabs.getState().tabs) {
    if (t.connectionId && !ids.has(t.connectionId)) {
      if (t.kind === 'object') useTabs.getState().close(t.id);
      else useTabs.getState().setConnection(t.id, null);
    }
  }
  // M2: the first console goes to a relational connection (Redis/MongoDB/Kafka have no consoles).
  const firstSql = useConnections.getState().connections.find((c) => providerKind(c.providerId) === 'relational');
  if (useTabs.getState().tabs.length === 0 && firstSql) {
    useTabs.getState().newConsole({ connectionId: firstSql.id });
  }
  preloadTabCatalogs();
  // Sessions of the previous page/renderer: adopt them by tab id, list the rest as unused (logic-08).
  if (!connErr) await reattachSessions(true);
  releaseSessionsOnPageHide();
  startWorkspaceAutosave();
  // History loads when its panel mounts (and after each run); no request here.
}

/**
 * Boot of a detached window (desktop "Open in new window"): the same engine, settings and connections, but only the
 * tabs the main process handed over, no workspace autosave (main keeps the tabs) and the side panel hidden.
 * Sessions of the main window are not adopted here.
 */
export async function bootDetached(): Promise<void> {
  // Not persisted: the main window's layout stays as it is.
  useUi.setState({ explorerVisible: false, historyVisible: false });
  if (!(await connectEngine())) return;
  await loadBasics();
  await bootDetachedTabs();
  preloadTabCatalogs();
  releaseSessionsOnPageHide();
}

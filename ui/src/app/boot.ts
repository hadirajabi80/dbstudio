import { API_PREFIX, configureClient, errorMessage, getClientConfig } from '../api/client';
import type { SessionInfo } from '../api/types';
import { engineSocket } from '../api/ws';
import { pluralize } from '../components/common/text';
import { getPlatform } from '../platform';
import { useCatalog } from '../store/catalog';
import { useConnections } from '../store/connections';
import { useHistory } from '../store/history';
import { useResults } from '../store/results';
import { useSessions } from '../store/sessions';
import { useSettings } from '../store/settings';
import { useTabs, type WorkspaceData } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import { preloadCatalog } from './actions';
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
    if (getPlatform().kind !== 'browser') return;
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
  engineSocket.on('engine.log', (ev) => {
    if (ev.level === 'error') toast('error', ev.message);
  });
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
    if (s.tabs === prev.tabs && s.activeId === prev.activeId) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void getPlatform().saveWorkspace(useTabs.getState().serialize());
    }, 800);
  });
  window.addEventListener('beforeunload', () => {
    void getPlatform().saveWorkspace(useTabs.getState().serialize());
  });
}

export async function boot(): Promise<void> {
  const platform = getPlatform();
  wireSocket();
  try {
    const info = await platform.getEngineInfo();
    configureClient(info);
    engineSocket.connect(info);
  } catch (e) {
    useUi.getState().setEngineError(`Cannot get engine connection info: ${errorMessage(e)}`);
    return;
  }
  platform.onEngineRestarted((info) => {
    configureClient(info);
    engineSocket.connect(info);
    // Sessions died with the engine; tabs recreate them lazily on the next run.
    useSessions.setState({ sessions: {}, byTab: {} });
    toast('warning', 'The engine was restarted', 'Open transactions were lost; sessions are recreated on the next run.');
  });

  await Promise.all([useSettings.getState().load(), useConnections.getState().load()]);
  restoreZoom();
  const connErr = useConnections.getState().error;
  useUi.getState().setEngineError(connErr ? `Cannot reach the DbStudio engine: ${connErr}` : null);

  try {
    const ws = (await platform.loadWorkspace()) as WorkspaceData | null;
    if (ws) useTabs.getState().restore(ws);
  } catch (e) {
    console.warn('[boot] workspace restore failed', e);
  }
  const ids = new Set(useConnections.getState().connections.map((c) => c.id));
  // Drop object tabs of deleted connections; keep consoles but unbind them.
  for (const t of useTabs.getState().tabs) {
    if (t.connectionId && !ids.has(t.connectionId)) {
      if (t.kind === 'object') useTabs.getState().close(t.id);
      else useTabs.getState().setConnection(t.id, null);
    }
  }
  if (useTabs.getState().tabs.length === 0 && ids.size > 0) {
    useTabs.getState().newConsole({ connectionId: useConnections.getState().connections[0].id });
  }
  const seen = new Set<string>();
  for (const t of useTabs.getState().tabs) {
    if (!t.connectionId) continue;
    const k = `${t.connectionId}|${t.database ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    void preloadCatalog(t.connectionId, t.database);
  }
  // Sessions of the previous page/renderer: adopt them by tab id, list the rest as unused (logic-08).
  if (!connErr) await reattachSessions(true);
  releaseSessionsOnPageHide();
  startWorkspaceAutosave();
  // History loads when its panel mounts (and after each run); no request here.
}

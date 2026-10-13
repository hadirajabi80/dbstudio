import { configureClient, errorMessage } from '../api/client';
import { engineSocket } from '../api/ws';
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

let wired = false;

/** Route engine events into the stores. Idempotent. */
export function wireSocket(): void {
  if (wired) return;
  wired = true;
  engineSocket.onStatus((s) => useUi.getState().setWsStatus(s));
  engineSocket.onAny((ev) => {
    if (ev.type.startsWith('exec.')) useResults.getState().ingest(ev);
  });
  engineSocket.on('exec.done', (ev) => {
    useSessions.getState().applyDone(ev);
    useHistory.getState().reloadSoon();
  });
  engineSocket.on('session.changed', (ev) => useSessions.getState().applyChanged(ev));
  engineSocket.on('catalog.changed', (ev) => useCatalog.getState().applyChanged(ev));
  engineSocket.on('export.done', (ev) => {
    if (ev.status === 'ok') toast('success', `Exported ${ev.rows.toLocaleString()} rows`, ev.path);
    else toast('error', 'Export failed', ev.error ?? undefined);
  });
  engineSocket.on('engine.log', (ev) => {
    if (ev.level === 'error') toast('error', ev.message);
  });
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
  startWorkspaceAutosave();
  void useHistory.getState().load();
}

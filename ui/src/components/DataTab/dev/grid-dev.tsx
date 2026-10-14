// WP-G playground (dev only): the console result grid and a Data tab against a running engine, without the shell.
// http://localhost:5174/src/components/DataTab/dev/grid-dev.html?theme=dark&view=data&table=Customers
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, configureClient } from '../../../api/client';
import { engineSocket } from '../../../api/ws';
import { wireSocket } from '../../../app/boot';
import { useCatalog } from '../../../store/catalog';
import { useConnections } from '../../../store/connections';
import { useResults } from '../../../store/results';
import { createExecution } from '../../../store/resultsReducer';
import { useSessions } from '../../../store/sessions';
import { useSettings } from '../../../store/settings';
import { useTabs, type ViewTab } from '../../../store/tabs';
import '../../../theme/tokens.css';
import '../../../theme/app.css';
import { ConfirmDialog } from '../../common/ConfirmDialog';
import { MenuHost } from '../../common/Menu';
import { Toasts } from '../../common/Toasts';
import { ParamsDialogHost } from '../../ParamsDialog/ParamsDialog';
import { ResultsPane } from '../../ResultsPane/ResultsPane';
import { DataTabView } from '../DataTabView';

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;
const env = import.meta.env as Record<string, string | undefined>;
const info = { baseUrl: env.VITE_ENGINE_URL || 'http://127.0.0.1:5151', token: env.VITE_ENGINE_TOKEN || 'dev-token' };

async function boot(): Promise<{ connectionId: string }> {
  configureClient(info);
  wireSocket();
  engineSocket.connect(info);
  // Headless screenshot runs never close their sessions: start clean (dev playground only).
  for (const s of await api.listSessions()) await api.closeSession(s.sessionId, true).catch(() => undefined);
  await Promise.all([useSettings.getState().load(), useConnections.getState().load()]);
  const conn = useConnections.getState().connections.find((c) => c.providerId === 'sqlite') ?? useConnections.getState().connections[0];
  await useCatalog.getState().loadDatabases(conn.id);
  await useCatalog.getState().ensureDefault(conn.id, 'main');
  return { connectionId: conn.id };
}

async function runConsole(tabId: string, connectionId: string, sql: string) {
  const localId = `dev${Date.now()}`;
  useTabs.getState().newConsole({ connectionId, title: 'dev' });
  useResults.getState().begin(createExecution({ localId, tabId, connectionId, sessionId: null, label: 'statement', batches: [{ sql, line: 1, col: 1 }], maxRows: 10000 }));
  const s = await useSessions.getState().ensure(tabId, connectionId, null, 'auto');
  const r = await api.execute(s.sessionId, { batches: [{ sql, line: 1, col: 1 }], maxRows: 10000, stopOnError: true, label: 'statement' });
  useResults.getState().attach(localId, r.executionId);
}

let started = false;

function Dev() {
  const [cid, setCid] = useState<string | null>(null);
  const view = q.get('view') ?? 'results';
  const table = q.get('table') ?? 'Customers';
  useEffect(() => {
    if (started) return; // StrictMode runs effects twice
    started = true;
    void boot().then(async ({ connectionId }) => {
      setCid(connectionId);
      if (view === 'results') await runConsole('devtab', connectionId, q.get('sql') ?? `SELECT * FROM ${table}`);
    });
  }, []);
  if (!cid) return <div style={{ padding: 20 }}>Connecting…</div>;
  const tab: ViewTab = { kind: 'view', id: 'devdata', title: table, view: 'data', connectionId: cid, database: null, state: { schema: 'main', name: table, type: 'table' } };
  return (
    <div className="app" style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'data' ? <DataTabView tab={tab} theme={theme} visible /> : <ResultsPane tabId="devtab" dialect="sqlite" theme={theme} />}
      </div>
      <MenuHost />
      <ConfirmDialog />
      <ParamsDialogHost />
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Dev /></StrictMode>);

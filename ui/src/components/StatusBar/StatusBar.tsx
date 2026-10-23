import { Activity, Keyboard, LoaderCircle, Lock, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { runCommand } from '../../commands/registry';
import { displayShortcut } from '../../commands/keys';
import { formatDuration } from '../../lib/format';
import { useConnection } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useCatalog } from '../../store/catalog';
import { useSourceClients } from '../../store/sourceClients';
import { activityCounts, useSessions, useTabSession } from '../../store/sessions';
import { pluralize } from '../common/text';
import { useActiveTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { connColorName } from '../../theme/connColors';
import { ColorDot } from '../common/ConnectionBadge';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { UpdateChip } from './UpdateChip';

const WS_LABEL: Record<string, string> = {
  idle: 'Engine: idle', connecting: 'Engine: connecting…', open: 'Engine connected', reconnecting: 'Engine: reconnecting…',
  unauthorized: 'Engine: unauthorized', closed: 'Engine: disconnected',
};

const START = { line: 1, col: 1 };

export function StatusBar() {
  const tab = useActiveTab();
  const conn = useConnection(tab?.connectionId);
  const session = useTabSession(tab?.id);
  const exec = useTabExecution(tab?.kind === 'console' ? tab.id : null);
  // Per tab: switching tabs shows that tab's own position (1:1 until its editor reports one).
  const tabCursor = useUi((s) => (tab?.kind === 'console' ? s.cursors[tab.id] : undefined));
  const cursor = tab?.kind === 'console' ? tabCursor ?? START : null;
  const ws = useUi((s) => s.wsStatus);
  const sessions = useSessions((s) => s.sessions);
  const catalogConns = useCatalog((s) => s.conns);
  const running = isRunning(exec);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  // Engine-wide (GET /sessions, refreshed on session.changed) and the explorer's definition of "connected":
  // a connection with an open session or a loaded catalog.
  const counts = useMemo(() => activityCounts(sessions, catalogConns), [sessions, catalogConns]);
  // M2: open Redis/MongoDB/Kafka clients (GET /sources/clients, source.client events).
  const clients = useSourceClients((s) => Object.keys(s.clients).length);
  const orphans = useMemo(() => useSessions.getState().orphans().length, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const tx = session ? (session.txMode === 'manual' ? (session.txOpen ? 'Manual tx · pending' : 'Manual tx') : 'Auto-commit') : tab?.kind === 'console' ? (tab.txMode === 'manual' ? 'Manual tx' : 'Auto-commit') : null;
  const server = session?.serverInfo;
  const database = session?.database ?? (tab?.kind === 'console' ? tab.database : null);

  return (
    <footer className="statusbar" aria-label="Status bar" data-region="status">
      <span className={`sb-item sb-ws ws-${ws}`} title={WS_LABEL[ws]} role="img" aria-label={WS_LABEL[ws]}>
        {ws === 'open' ? <Wifi size={12} /> : <WifiOff size={12} />}
      </span>
      <button
        className="sb-item sb-button"
        onClick={() => runCommand('connections.showActive')}
        title={`Connected: an open session or a loaded catalog. Show active connections${orphans ? ` (${pluralize(orphans, 'unused session')})` : ''}`}
      >
        <Activity size={12} />
        {pluralize(counts.connections, 'connection')} · {pluralize(counts.sessions, 'session')}
        {clients > 0 && <> · {pluralize(clients, 'client')}</>}
        {orphans > 0 && <span className="sb-warn-dot" aria-label={pluralize(orphans, 'unused session')} />}
      </button>
      {conn ? (
        <button className="sb-item sb-button" title={`${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''} — change connection (${displayShortcut('Mod+Shift+K')})`} onClick={() => runCommand('connections.change')}>
          <ProviderLogo providerId={conn.providerId} size={14} />
          <ColorDot color={conn.color} size={8} />
          {conn.name}
          {conn.readOnly && <Lock size={11} aria-label="Read-only" />}
          {database && <span className="muted">/ {database}</span>}
        </button>
      ) : tab?.kind === 'console' ? (
        <span className="sb-item muted">No connection</span>
      ) : null}
      {server && (
        <span className="sb-item muted" title={server.version}>
          {server.productVersion ? `${shortVersion(server.version)} ${server.productVersion}` : shortVersion(server.version)}
        </span>
      )}
      {tx && <span className={`sb-item${session?.txOpen ? ' sb-warn' : ''}`}>{tx}</span>}
      <div className="flex-1" />
      {exec && (
        <span className="sb-item tabular">
          {running ? (
            <>
              <LoaderCircle size={11} className="spin" /> {formatDuration(now - exec.startedAt)}
            </>
          ) : (
            <span className="muted">
              {exec.status} · {formatDuration(exec.elapsedMs ?? 0)}
            </span>
          )}
        </span>
      )}
      {tab?.kind === 'console' && cursor && <span className="sb-item muted tabular">Ln {cursor.line}, Col {cursor.col}</span>}
      {tab?.kind === 'console' && <span className="sb-item muted">{dialectName(conn?.providerId)}</span>}
      <UpdateChip />
      <button className="sb-item sb-button" onClick={() => runCommand('view.shortcuts')} title={`Keyboard shortcuts (${displayShortcut('F1')})`} aria-label="Keyboard shortcuts">
        <Keyboard size={12} />
      </button>
    </footer>
  );
}

function shortVersion(v: string): string {
  const first = v.split('\n')[0];
  const m = /^(Microsoft SQL Server \d+|Oracle Database \d+\w*|SQLite)/i.exec(first);
  return m ? m[1] : first.slice(0, 40);
}

/** Language of a provider's consoles (by provider id). Batch 3: MySQL/MariaDB share the mysql dialect, Cassandra speaks CQL. */
const DIALECT_NAME: Record<string, string> = {
  sqlserver: 'T-SQL', oracle: 'PL/SQL', sqlite: 'SQLite', postgresql: 'PostgreSQL',
  mysql: 'MySQL', mariadb: 'MariaDB', clickhouse: 'ClickHouse', snowflake: 'Snowflake', cassandra: 'CQL',
};

function dialectName(p?: string): string {
  return (p && DIALECT_NAME[p]) || 'SQL';
}

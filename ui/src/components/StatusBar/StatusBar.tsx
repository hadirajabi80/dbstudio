import { Activity, Keyboard, LoaderCircle, Lock, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { runCommand } from '../../commands/registry';
import { displayShortcut } from '../../commands/keys';
import { formatDuration } from '../../lib/format';
import { useConnection } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useSessions, useTabSession } from '../../store/sessions';
import { useActiveTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { connColorName } from '../../theme/connColors';
import { ColorDot } from '../common/ConnectionBadge';

const WS_LABEL: Record<string, string> = {
  idle: 'Engine: idle', connecting: 'Engine: connecting…', open: 'Engine connected', reconnecting: 'Engine: reconnecting…',
  unauthorized: 'Engine: unauthorized', closed: 'Engine: disconnected',
};

export function StatusBar() {
  const tab = useActiveTab();
  const conn = useConnection(tab?.connectionId);
  const session = useTabSession(tab?.id);
  const exec = useTabExecution(tab?.kind === 'console' ? tab.id : null);
  const cursor = useUi((s) => s.cursor);
  const ws = useUi((s) => s.wsStatus);
  const sessions = useSessions((s) => s.sessions);
  const running = isRunning(exec);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const { nConn, nSess } = useMemo(() => {
    const list = Object.values(sessions);
    return { nConn: new Set(list.map((s) => s.connectionId)).size, nSess: list.length };
  }, [sessions]);

  const tx = session ? (session.txMode === 'manual' ? (session.txOpen ? 'Manual tx · pending' : 'Manual tx') : 'Auto-commit') : tab?.kind === 'console' ? (tab.txMode === 'manual' ? 'Manual tx' : 'Auto-commit') : null;
  const server = session?.serverInfo;
  const database = session?.database ?? (tab?.kind === 'console' ? tab.database : null);

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className={`sb-item sb-ws ws-${ws}`} title={WS_LABEL[ws]} role="img" aria-label={WS_LABEL[ws]}>
        {ws === 'open' ? <Wifi size={12} /> : <WifiOff size={12} />}
      </span>
      <button className="sb-item sb-button" onClick={() => runCommand('connections.showActive')} title="Show active connections">
        <Activity size={12} />
        {nConn} connection{nConn === 1 ? '' : 's'} · {nSess} session{nSess === 1 ? '' : 's'}
      </button>
      {conn ? (
        <button className="sb-item sb-button" title={`${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''} — change connection (${displayShortcut('Mod+Shift+K')})`} onClick={() => runCommand('connections.change')}>
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

function dialectName(p?: string): string {
  return p === 'sqlserver' ? 'T-SQL' : p === 'oracle' ? 'PL/SQL' : p === 'sqlite' ? 'SQLite' : 'SQL';
}

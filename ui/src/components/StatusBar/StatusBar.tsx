import { LoaderCircle, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { useConnection } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useTabSession } from '../../store/sessions';
import { useActiveTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
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
  const running = isRunning(exec);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const tx = session ? (session.txMode === 'manual' ? (session.txOpen ? 'Manual tx · pending' : 'Manual tx') : 'Auto-commit') : tab?.kind === 'console' ? (tab.txMode === 'manual' ? 'Manual tx' : 'Auto-commit') : null;
  const server = session?.serverInfo;

  return (
    <div className="statusbar" role="status">
      <span className={`sb-item sb-ws ws-${ws}`} title={WS_LABEL[ws]}>
        {ws === 'open' ? <Wifi size={12} /> : <WifiOff size={12} />}
      </span>
      {conn ? (
        <span className="sb-item" title={conn.name}>
          <ColorDot color={conn.color} size={8} />
          {conn.name}
          {(session?.database || (tab?.kind === 'console' && tab.database)) && <span className="muted">/ {session?.database ?? (tab?.kind === 'console' ? tab.database : '')}</span>}
        </span>
      ) : (
        <span className="sb-item muted">No connection</span>
      )}
      {server && (
        <span className="sb-item muted" title={server.version}>
          {server.productVersion ? `${shortVersion(server.version)} ${server.productVersion}` : shortVersion(server.version)}
        </span>
      )}
      {tx && <span className={`sb-item${session?.txOpen ? ' sb-warn' : ''}`}>{tx}</span>}
      <div className="flex-1" />
      {exec && (
        <span className="sb-item">
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
      {tab?.kind === 'console' && cursor && <span className="sb-item muted">Ln {cursor.line}, Col {cursor.col}</span>}
      {tab?.kind === 'console' && <span className="sb-item muted">{dialectName(conn?.providerId)}</span>}
    </div>
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

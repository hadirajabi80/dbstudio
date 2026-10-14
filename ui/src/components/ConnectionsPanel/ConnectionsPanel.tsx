import { Activity, CircleStop, Lock, LoaderCircle, RefreshCw, SquareTerminal, Unplug, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo } from '../../api/types';
import { runCommand } from '../../commands/registry';
import { commandView, useCommandContext } from '../../commands/useCommands';
import { formatDuration } from '../../lib/format';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import { connColorCss, connColorName } from '../../theme/connColors';
import { showContextMenu } from '../common/Menu';
import { ProviderIcon } from '../common/icons';
import { EmptyState } from '../EmptyState/EmptyState';
import { contextMenu } from '../layout/commandMenu';

/** Active connections (1.5): open sessions grouped by connection, state, elapsed time, Cancel / Disconnect. */
export function ConnectionsPanel() {
  useCommandContext();
  const sessions = useSessions((s) => s.sessions);
  const byTab = useSessions((s) => s.byTab);
  const connections = useConnections((s) => s.connections);
  const catalogConns = useCatalog((s) => s.conns);
  const tabs = useTabs((s) => s.tabs);
  const executions = useResults((s) => s.executions);
  const resultsByTab = useResults((s) => s.byTab);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useSessions.getState().refreshAll();
    const t = setInterval(() => void useSessions.getState().refreshAll(), 5000);
    return () => clearInterval(t);
  }, []);
  const anyRunning = Object.values(sessions).some((s) => s.state === 'executing');
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [anyRunning]);

  const tabOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const [tab, sid] of Object.entries(byTab)) m.set(sid, tab);
    return m;
  }, [byTab]);

  const groups = useMemo(() => {
    const ids = new Set<string>([...Object.values(sessions).map((s) => s.connectionId), ...Object.keys(catalogConns)]);
    return [...ids]
      .map((cid) => ({ conn: connections.find((c) => c.id === cid), cid, list: Object.values(sessions).filter((s) => s.connectionId === cid) }))
      .filter((g) => g.conn)
      .sort((a, b) => a.conn!.name.localeCompare(b.conn!.name));
  }, [sessions, catalogConns, connections]);

  const total = Object.keys(sessions).length;
  const disconnectAll = commandView('connections.disconnectAll');

  return (
    <div className="dock-panel connections-panel" aria-label="Active connections">
      <div className="panel-header">
        <span className="panel-title">Active connections</span>
        <span className="panel-count">{groups.length} · {total} session{total === 1 ? '' : 's'}</span>
        <div className="panel-actions">
          <button className="icon-btn" title="Refresh" aria-label="Refresh sessions" onClick={() => void useSessions.getState().refreshAll()}>
            <RefreshCw size={14} />
          </button>
          <button className="icon-btn" title={disconnectAll.tooltip} aria-label="Disconnect all" disabled={!disconnectAll.enabled} onClick={disconnectAll.run}>
            <Unplug size={14} />
          </button>
        </div>
      </div>
      {groups.length === 0 ? (
        <EmptyState
          icon={<Activity size={28} strokeWidth={1.5} />}
          title="No active connections"
          hint="Consoles open a session the first time they run a statement."
          action={{ command: 'file.newConsole' }}
          compact
        />
      ) : (
        <div className="sessions-list" role="list">
          {groups.map(({ conn, cid, list }) => (
            <section key={cid} className="session-group" role="listitem" style={{ ['--conn-color' as string]: connColorCss(conn!.color) }}>
              <div className="session-group-header" title={connColorName(conn!.color) ?? undefined}>
                <ProviderIcon providerId={conn!.providerId} color={conn!.color} size={16} />
                <span className="session-conn-name">{conn!.name}</span>
                {conn!.readOnly && <Lock size={12} aria-label="Read-only" />}
                <span className="muted">{list.length ? `${list.length} session${list.length === 1 ? '' : 's'}` : 'catalog only'}</span>
                <div className="flex-1" />
                <button className="icon-btn xs" title="Disconnect" aria-label={`Disconnect ${conn!.name}`} onClick={() => runCommand('connections.disconnect', { kind: 'connection', connectionId: cid })}>
                  <Unplug size={13} />
                </button>
              </div>
              {list.map((s) => (
                <SessionRow
                  key={s.sessionId}
                  s={s}
                  tabTitle={tabs.find((t) => t.id === tabOf.get(s.sessionId))?.title ?? s.label ?? (s.tabId ? 'closed tab' : 'Background')}
                  tabId={tabOf.get(s.sessionId)}
                  startedAt={(() => {
                    const tab = tabOf.get(s.sessionId);
                    const e = tab ? executions[resultsByTab[tab]] : undefined;
                    if (isRunning(e)) return e!.startedAt;
                    return s.executingSince ? Date.parse(s.executingSince) : null;
                  })()}
                  now={now}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, tabTitle, tabId, startedAt, now }: { s: SessionInfo; tabTitle: string; tabId?: string; startedAt: number | null; now: number }) {
  const executing = s.state === 'executing' || startedAt !== null;
  const state = executing ? 'executing' : s.txOpen ? 'tx open' : s.state;
  const args = { sessionId: s.sessionId };
  const cancel = commandView('sessions.cancel', args);
  return (
    <div
      className={`session-row state-${state.replace(' ', '-')}`}
      onContextMenu={(e) => showContextMenu(e, contextMenu('connections.session', args))}
    >
      <SquareTerminal size={14} strokeWidth={1.5} className="muted" />
      <button className="link-btn session-tab" disabled={!tabId} onClick={() => tabId && useTabs.getState().activate(tabId)} title={tabId ? 'Show this console' : undefined}>
        {tabTitle}
      </button>
      {s.database && <span className="muted session-db">{s.database}</span>}
      <div className="flex-1" />
      <span className={`state-badge state-${state.replace(' ', '-')}`}>
        {executing && <LoaderCircle size={11} className="spin" aria-hidden="true" />}
        {state}
        {executing && startedAt !== null && <span className="tabular"> {formatDuration(Math.max(0, now - startedAt))}</span>}
      </span>
      {executing && (
        <button className="icon-btn xs danger" title="Cancel running query" aria-label="Cancel" disabled={!cancel.enabled && s.state !== 'executing'} onClick={cancel.run}>
          <CircleStop size={13} />
        </button>
      )}
      <button className="icon-btn xs" title="Close session" aria-label="Close session" onClick={() => runCommand('sessions.disconnect', args)}>
        <X size={13} />
      </button>
    </div>
  );
}

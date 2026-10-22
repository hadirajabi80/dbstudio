import { Activity, AppWindow, Cable, CircleStop, Lock, LoaderCircle, RefreshCw, SquareTerminal, TriangleAlert, Unplug, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo } from '../../api/types';
import { hasCommand, runCommand } from '../../commands/registry';
import { commandView, useCommandContext } from '../../commands/useCommands';
import { formatDuration } from '../../lib/format';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { isForeignSession, useSessions } from '../../store/sessions';
import { useSourceClients } from '../../store/sourceClients';
import { useTabs } from '../../store/tabs';
import { connColorCss, connColorName } from '../../theme/connColors';
import { showContextMenu } from '../common/Menu';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { pluralize } from '../common/text';
import { EmptyState } from '../EmptyState/EmptyState';
import { contextMenu } from '../layout/commandMenu';

/** M2-L: "Activity" opens the Logs & activity tab of the connection on its Activity view (SQLite has no activity). */
function ActivityButton({ connectionId, name, providerId }: { connectionId: string; name: string; providerId: string }) {
  if (providerId === 'sqlite' || !hasCommand('view.logs')) return null;
  return (
    <button
      className="icon-btn xs"
      title="Activity"
      aria-label={`Activity of ${name}`}
      onClick={() => runCommand('view.logs', { connectionId, sub: 'activity' })}
    >
      <Activity size={13} />
    </button>
  );
}

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
  // M2: long-lived Redis/MongoDB/Kafka clients (one per connection, no sessions).
  const sourceClients = useSourceClients((s) => s.clients);

  useEffect(() => {
    void useSessions.getState().refreshAll();
    void useSourceClients.getState().refresh();
    const t = setInterval(() => {
      void useSessions.getState().refreshAll();
      void useSourceClients.getState().refresh();
    }, 5000);
    return () => clearInterval(t);
  }, []);
  const clients = useMemo(
    () => Object.values(sourceClients)
      .map((c) => ({ info: c, conn: connections.find((x) => x.id === c.connectionId) }))
      .sort((a, b) => (a.conn?.name ?? a.info.connectionId).localeCompare(b.conn?.name ?? b.info.connectionId)),
    [sourceClients, connections],
  );
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

  // Sessions no open tab owns. Left over from a reload or a crash (the engine reports their window gone): listed
  // apart, with Close / Roll back & close. Used by another live window: listed read-only (logic-r1-03).
  const { orphans, foreign } = useMemo(() => {
    const free = Object.values(sessions).filter((s) => !tabOf.has(s.sessionId) && s.state !== 'closed');
    return { orphans: free.filter((s) => !isForeignSession(s)), foreign: free.filter(isForeignSession) };
  }, [sessions, tabOf]);

  const groups = useMemo(() => {
    // "Connected" = a session of this window or a loaded catalog, as for the explorer dot and the status bar
    // (connectionActivity / activityCounts). Groups list the sessions of open tabs; unused ones are listed apart, and
    // another window's sessions only in their own group below: they never make this window connected (logic-r2-01).
    const ready = Object.entries(catalogConns).filter(([, c]) => c.status === 'ready').map(([cid]) => cid);
    const ids = new Set<string>([...Object.values(sessions).filter((s) => tabOf.has(s.sessionId)).map((s) => s.connectionId), ...ready]);
    return [...ids]
      .map((cid) => ({ conn: connections.find((c) => c.id === cid), cid, list: Object.values(sessions).filter((s) => s.connectionId === cid && tabOf.has(s.sessionId)) }))
      .filter((g) => g.conn)
      .sort((a, b) => a.conn!.name.localeCompare(b.conn!.name));
  }, [sessions, catalogConns, connections, tabOf]);

  // This window's sessions (its tabs' and the unused ones it may close); another window's have their own count.
  const total = Object.values(sessions).filter((s) => s.state !== 'closed' && !isForeignSession(s)).length;
  const disconnectAll = commandView('connections.disconnectAll');
  const closeOrphans = commandView('sessions.closeOrphans');

  return (
    <div className="dock-panel connections-panel" aria-label="Active connections">
      <div className="panel-header">
        <span className="panel-title">Active connections</span>
        <span className="panel-count">{groups.length} · {pluralize(total, 'session')}{clients.length ? ` · ${pluralize(clients.length, 'client')}` : ''}</span>
        <div className="panel-actions">
          <button className="icon-btn" title="Refresh" aria-label="Refresh sessions" onClick={() => void useSessions.getState().refreshAll()}>
            <RefreshCw size={14} />
          </button>
          <button className="icon-btn" title={disconnectAll.tooltip} aria-label="Disconnect all" disabled={!disconnectAll.enabled} onClick={disconnectAll.run}>
            <Unplug size={14} />
          </button>
        </div>
      </div>
      {orphans.length > 0 && (
        <section className="session-group orphan-group" aria-label="Unused sessions">
          <div className="session-group-header">
            <TriangleAlert size={14} className="text-warning" aria-hidden="true" />
            <span className="session-conn-name">Unused sessions</span>
            <span className="muted">{pluralize(orphans.length, 'session')} from an earlier window</span>
            <div className="flex-1" />
            <button className="btn btn-xs" title={closeOrphans.tooltip} disabled={!closeOrphans.enabled} onClick={closeOrphans.run}>
              Close all
            </button>
          </div>
          {orphans.map((s) => (
            <OrphanRow key={s.sessionId} s={s} connName={connections.find((c) => c.id === s.connectionId)?.name ?? 'deleted connection'} />
          ))}
        </section>
      )}
      {foreign.length > 0 && (
        <section className="session-group foreign-group" aria-label="In use by another window">
          <div className="session-group-header" title="Sessions of another Rowlit window that is still open. Close or commit them there.">
            <AppWindow size={14} className="muted" aria-hidden="true" />
            <span className="session-conn-name">In use by another window</span>
            <span className="muted">{pluralize(foreign.length, 'session')}</span>
          </div>
          {foreign.map((s) => (
            <ForeignRow key={s.sessionId} s={s} connName={connections.find((c) => c.id === s.connectionId)?.name ?? 'deleted connection'} />
          ))}
        </section>
      )}
      {clients.length > 0 && (
        <section className="session-group clients-group" aria-label="Clients">
          <div className="session-group-header" title="Redis, MongoDB and Kafka connections keep one shared client each; it closes after the idle timeout.">
            <Cable size={14} className="muted" aria-hidden="true" />
            <span className="session-conn-name">Clients</span>
            <span className="muted">{pluralize(clients.length, 'client')}</span>
          </div>
          {clients.map(({ info, conn }) => (
            <div key={info.connectionId} className="session-row client-row" style={{ ['--conn-color' as string]: connColorCss(conn?.color ?? null) }}>
              {conn ? <ProviderLogo providerId={conn.providerId} color={conn.color} size={14} /> : <Cable size={14} className="muted" />}
              <span className="session-tab">{conn?.name ?? info.connectionId}</span>
              <span className="muted session-db" title={info.server?.version ?? undefined}>{info.server?.version ?? ''}</span>
              <div className="flex-1" />
              <span className={`state-badge state-${info.state}`}>{info.state}</span>
              {conn && <ActivityButton connectionId={info.connectionId} name={conn.name} providerId={conn.providerId} />}
              <button
                className="icon-btn xs"
                title="Disconnect"
                aria-label={`Disconnect ${conn?.name ?? info.connectionId}`}
                onClick={() => runCommand('connections.disconnect', { kind: 'connection', connectionId: info.connectionId })}
              >
                <Unplug size={13} />
              </button>
            </div>
          ))}
        </section>
      )}
      {groups.length === 0 && orphans.length === 0 && foreign.length === 0 && clients.length === 0 ? (
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
                <ProviderLogo providerId={conn!.providerId} color={conn!.color} size={16} />
                <span className="session-conn-name">{conn!.name}</span>
                {conn!.readOnly && <Lock size={12} aria-label="Read-only" />}
                <span className="muted">{list.length ? pluralize(list.length, 'session') : 'catalog loaded'}</span>
                <div className="flex-1" />
                <ActivityButton connectionId={cid} name={conn!.name} providerId={conn!.providerId} />
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

/** A session no tab owns: Close (no transaction) or Roll back & close (open transaction). */
function OrphanRow({ s, connName }: { s: SessionInfo; connName: string }) {
  const args = { sessionId: s.sessionId };
  return (
    <div className={`session-row orphan${s.txOpen ? ' state-tx-open' : ''}`} onContextMenu={(e) => showContextMenu(e, contextMenu('connections.orphan', args))}>
      <SquareTerminal size={14} strokeWidth={1.5} className="muted" />
      <span className="session-tab" title={s.label ?? undefined}>{s.label ?? 'Session'}</span>
      <span className="muted session-db">{connName}{s.database ? ` · ${s.database}` : ''}</span>
      <div className="flex-1" />
      {s.txOpen && <span className="state-badge state-tx-open">tx open</span>}
      {s.txOpen ? (
        <button className="btn btn-xs btn-danger-outline" onClick={() => runCommand('sessions.rollbackClose', args)}>Roll back &amp; close</button>
      ) : (
        <button className="btn btn-xs" onClick={() => runCommand('sessions.disconnect', args)}>Close</button>
      )}
    </div>
  );
}

/** A session of another live window: shown for the session count, never closed or adopted from here. */
function ForeignRow({ s, connName }: { s: SessionInfo; connName: string }) {
  const state = s.state === 'executing' ? 'executing' : s.txOpen ? 'tx open' : null;
  return (
    <div className="session-row foreign" aria-readonly="true">
      <SquareTerminal size={14} strokeWidth={1.5} className="muted" />
      <span className="session-tab" title={s.label ?? undefined}>{s.label ?? 'Session'}</span>
      <span className="muted session-db">{connName}{s.database ? ` · ${s.database}` : ''}</span>
      <div className="flex-1" />
      {state && <span className={`state-badge state-${state.replace(' ', '-')}`}>{state}</span>}
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
        <button className="icon-btn xs danger" title={cancel.title} aria-label={cancel.title} disabled={!cancel.enabled && s.state !== 'executing'} onClick={cancel.run}>
          <CircleStop size={13} />
        </button>
      )}
      <button className="icon-btn xs" title="Close session" aria-label="Close session" onClick={() => runCommand('sessions.disconnect', args)}>
        <X size={13} />
      </button>
    </div>
  );
}

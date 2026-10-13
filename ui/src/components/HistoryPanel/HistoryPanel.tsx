import { CircleAlert, CircleCheck, CircleSlash, Copy, Pin, PinOff, RefreshCw, Search, SquareTerminal, Trash, X } from 'lucide-react';
import { useEffect, useMemo, type MouseEvent } from 'react';
import type { HistoryEntry } from '../../api/types';
import { copyText, insertIntoActiveEditor, reopenSql } from '../../app/actions';
import { formatDuration } from '../../lib/format';
import { useConnections } from '../../store/connections';
import { useHistory } from '../../store/history';
import { toast, useUi } from '../../store/ui';
import { showContextMenu } from '../common/Menu';
import { ColorDot } from '../common/ConnectionBadge';

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Query history (engine FTS) with search, re-open, insert, pin. */
export function HistoryPanel() {
  const { entries, query, loading, error, connectionFilter } = useHistory();
  const h = useHistory.getState;
  const connections = useConnections((s) => s.connections);
  const byId = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const toggle = useUi((s) => s.toggle);

  useEffect(() => {
    void h().load();
  }, [h]);

  const menu = (e: MouseEvent, x: HistoryEntry) =>
    showContextMenu(e, [
      { label: 'Open in new console', onClick: () => reopenSql(x.sql, x.connectionId, x.database) },
      { label: 'Insert into current editor', onClick: () => insertIntoActiveEditor(x.sql) },
      { label: 'Copy SQL', onClick: () => void copyText(x.sql) },
      { label: x.pinned ? 'Unpin' : 'Pin', onClick: () => void h().togglePin(x.id).catch(() => toast('error', 'Pin failed')) },
      { separator: true },
      { label: 'Delete', danger: true, onClick: () => void h().remove(x.id).catch(() => toast('error', 'Delete failed')) },
    ]);

  return (
    <div className="history" aria-label="Query history">
      <div className="panel-header">
        <span className="panel-title">History</span>
        <div className="panel-actions">
          <button className="icon-btn" title="Reload" onClick={() => void h().load()}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
          <button
            className="icon-btn"
            title="Clear unpinned history"
            onClick={async () => {
              const ok = await useUi.getState().askConfirm({ title: 'Clear history', message: 'Delete all history entries (pinned entries are kept when the engine supports it)?', confirmLabel: 'Clear', danger: true });
              if (ok) void h().clear();
            }}
          >
            <Trash size={14} />
          </button>
          <button className="icon-btn" title="Close" aria-label="Close history" onClick={() => toggle('historyVisible')}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="history-filters">
        <div className="search-box">
          <Search size={13} />
          <input className="input sm borderless" placeholder="Search SQL" aria-label="Search history" value={query} onChange={(e) => h().setQuery(e.target.value)} />
        </div>
        <select className="input sm" aria-label="Connection filter" value={connectionFilter ?? ''} onChange={(e) => h().setConnectionFilter(e.target.value || null)}>
          <option value="">All connections</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="history-error">{error}</div>}
      <div className="history-list">
        {entries.length === 0 && !loading && <div className="history-empty">{query ? 'No matches' : 'No queries yet'}</div>}
        {entries.map((x) => {
          const c = byId.get(x.connectionId);
          const StatusIcon = x.status === 'ok' ? CircleCheck : x.status === 'error' ? CircleAlert : CircleSlash;
          return (
            <div
              key={x.id}
              className={`history-item${x.pinned ? ' pinned' : ''}`}
              onDoubleClick={() => reopenSql(x.sql, x.connectionId, x.database)}
              onContextMenu={(e) => menu(e, x)}
              title="Double-click to open in a new console"
            >
              <div className="history-meta">
                <StatusIcon size={12} className={`status-${x.status}`} />
                <ColorDot color={c?.color} size={7} />
                <span className="history-conn">{c?.name ?? 'deleted connection'}</span>
                {x.database && <span className="muted">· {x.database}</span>}
                <div className="flex-1" />
                <span className="muted">{formatDuration(x.durationMs)}</span>
                <span className="muted">{when(x.startedAt)}</span>
              </div>
              <pre className="history-sql">{x.sql.length > 600 ? `${x.sql.slice(0, 600)}…` : x.sql}</pre>
              {x.error && <div className="history-err">{x.error}</div>}
              <div className="history-actions">
                {x.resultRows !== null && <span className="muted">{x.resultRows} rows</span>}
                {x.rowsAffected !== null && x.rowsAffected > 0 && <span className="muted">{x.rowsAffected} affected</span>}
                <div className="flex-1" />
                <button className="icon-btn xs" title="Open in new console" onClick={() => reopenSql(x.sql, x.connectionId, x.database)}>
                  <SquareTerminal size={12} />
                </button>
                <button className="icon-btn xs" title="Copy SQL" onClick={() => void copyText(x.sql)}>
                  <Copy size={12} />
                </button>
                <button className={`icon-btn xs${x.pinned ? ' on' : ''}`} title={x.pinned ? 'Unpin' : 'Pin'} onClick={() => void h().togglePin(x.id).catch(() => toast('error', 'Pin failed'))}>
                  {x.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

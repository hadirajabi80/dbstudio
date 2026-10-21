import {
  CalendarRange, ChevronDown, CircleAlert, CircleCheck, CircleSlash, Copy, FileClock, Pin, PinOff, RefreshCw, Search,
  SquareTerminal, Trash, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, HistoryStatus } from '../../api/types';
import { copyText, reopenSql } from '../../app/actions';
import { displayShortcut } from '../../commands/keys';
import { runCommand } from '../../commands/registry';
import { formatDuration } from '../../lib/format';
import { useConnections } from '../../store/connections';
import { activeFilterCount, useHistory, type HistoryWhen } from '../../store/history';
import { toast } from '../../store/ui';
import { showContextMenu, showMenuBelow, type MenuItem } from '../common/Menu';
import { ColorDot } from '../common/ConnectionBadge';
import { pluralize } from '../common/text';
import { EmptyState } from '../EmptyState/EmptyState';
import { contextMenu } from '../layout/commandMenu';

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL: Record<HistoryStatus, string> = { ok: 'Succeeded', error: 'Failed', cancelled: 'Cancelled' };
/** Focus requests already acted on (remounting the panel when switching dock tabs must not steal focus again). */
let consumedFocus = 0;

const WHEN_LABEL: Record<HistoryWhen, string> = { any: 'Any time', today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom range' };

/** Query history (engine FTS) with filter chips: Connection, Status, When, Only pinned (1.1.3). */
export function HistoryPanel() {
  const entries = useHistory((s) => s.entries);
  const query = useHistory((s) => s.query);
  const loading = useHistory((s) => s.loading);
  const error = useHistory((s) => s.error);
  const filters = useHistory((s) => s.filters);
  const focusSeq = useHistory((s) => s.focusSeq);
  const h = useHistory.getState;
  const connections = useConnections((s) => s.connections);
  const byId = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const searchRef = useRef<HTMLInputElement>(null);
  const [showRange, setShowRange] = useState(filters.when === 'custom');

  useEffect(() => {
    void h().load();
  }, [h]);
  useEffect(() => {
    if (focusSeq && focusSeq !== consumedFocus) {
      consumedFocus = focusSeq;
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [focusSeq]);

  const nFilters = activeFilterCount(filters);
  const connLabel = filters.connections.length === 0 ? 'Connection' : filters.connections.length === 1 ? byId.get(filters.connections[0])?.name ?? '1 connection' : `${filters.connections.length} connections`;
  const statusLabel = filters.statuses.length === 0 ? 'Status' : filters.statuses.map((s) => STATUS_LABEL[s]).join(', ');

  const connMenu = (el: HTMLElement) => {
    const items: MenuItem[] = connections.map((c) => ({
      label: c.name,
      icon: <ColorDot color={c.color} size={8} />,
      checked: filters.connections.includes(c.id),
      keepOpen: true,
      onClick: () => {
        const cur = useHistory.getState().filters.connections;
        h().setFilters({ connections: cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id] });
      },
    }));
    if (filters.connections.length) items.push({ separator: true }, { label: 'All connections', onClick: () => h().setFilters({ connections: [] }) });
    showMenuBelow(el, items);
  };
  const statusMenu = (el: HTMLElement) => {
    const items: MenuItem[] = (['ok', 'error', 'cancelled'] as HistoryStatus[]).map((s) => ({
      label: STATUS_LABEL[s],
      checked: filters.statuses.includes(s),
      keepOpen: true,
      onClick: () => {
        const cur = useHistory.getState().filters.statuses;
        h().setFilters({ statuses: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
      },
    }));
    showMenuBelow(el, items);
  };
  const whenMenu = (el: HTMLElement) =>
    showMenuBelow(el, (Object.keys(WHEN_LABEL) as HistoryWhen[]).map((w) => ({
      label: WHEN_LABEL[w],
      checked: filters.when === w,
      onClick: () => {
        setShowRange(w === 'custom');
        h().setFilters({ when: w });
      },
    })));

  return (
    <div className="history dock-panel" aria-label="Query history" data-command-scope="history">
      <div className="history-filters">
        <div className="search-box">
          <Search size={14} strokeWidth={1.5} />
          <input
            ref={searchRef}
            className="input borderless"
            placeholder={`Search SQL (${displayShortcut('Mod+F')})`}
            aria-label="Search history"
            value={query}
            onChange={(e) => h().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                h().setQuery('');
              }
            }}
          />
          {query && (
            <button className="icon-btn xs" aria-label="Clear search" onClick={() => h().setQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="chip-row" role="group" aria-label="History filters">
          <button className={`chip chip-menu${filters.connections.length ? ' on' : ''}`} aria-haspopup="menu" onClick={(e) => connMenu(e.currentTarget)}>
            {connLabel} <ChevronDown size={12} />
          </button>
          <button className={`chip chip-menu${filters.statuses.length ? ' on' : ''}`} aria-haspopup="menu" onClick={(e) => statusMenu(e.currentTarget)}>
            {statusLabel} <ChevronDown size={12} />
          </button>
          <button className={`chip chip-menu${filters.when !== 'any' ? ' on' : ''}`} aria-haspopup="menu" onClick={(e) => whenMenu(e.currentTarget)}>
            {filters.when === 'any' ? 'When' : WHEN_LABEL[filters.when]} <ChevronDown size={12} />
          </button>
          <button className={`chip${filters.pinnedOnly ? ' on' : ''}`} aria-pressed={filters.pinnedOnly} onClick={() => h().setFilters({ pinnedOnly: !filters.pinnedOnly })}>
            <Pin size={12} strokeWidth={1.75} /> Only pinned
          </button>
          {nFilters > 0 && (
            <button className="chip chip-clear" onClick={() => h().clearFilters()}>
              Clear
            </button>
          )}
        </div>
        {showRange && filters.when === 'custom' && (
          <div className="history-range">
            <CalendarRange size={14} strokeWidth={1.5} className="muted" />
            <input type="date" className="input sm" aria-label="From date" value={filters.from ?? ''} onChange={(e) => h().setFilters({ from: e.target.value || null })} />
            <span className="muted">to</span>
            <input type="date" className="input sm" aria-label="To date" value={filters.to ?? ''} onChange={(e) => h().setFilters({ to: e.target.value || null })} />
          </div>
        )}
      </div>
      {/* Search first in the DOM (Tab, F6 and screen readers reach it first); the header stays on top visually. */}
      <div className="panel-header" style={{ order: -1 }}>
        <span className="panel-title">History</span>
        <div className="panel-actions">
          <button className="icon-btn" title="Reload" aria-label="Reload history" onClick={() => void h().load()}>
            <RefreshCw size={16} strokeWidth={1.5} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-btn" title="Clear unpinned history…" aria-label="Clear history" onClick={() => runCommand('history.clear')}>
            <Trash size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {error && <div className="history-error" role="alert">{error}</div>}
      <div className="history-list" role="list">
        {entries.length === 0 && !loading && (
          nFilters > 0 || query ? (
            <EmptyState compact icon={<Search size={24} strokeWidth={1.25} />} title="No queries match" action={{ label: 'Clear filters', onClick: () => h().clearFilters() }} />
          ) : (
            <EmptyState compact icon={<FileClock size={28} strokeWidth={1.25} />} title="Queries you run appear here" hint={<>Run a statement with {displayShortcut('Mod+Enter')}.</>} />
          )
        )}
        {entries.map((x) => (
          <HistoryItem key={x.id} x={x} connName={byId.get(x.connectionId)?.name} connColor={byId.get(x.connectionId)?.color ?? null} />
        ))}
      </div>
    </div>
  );
}

function HistoryItem({ x, connName, connColor }: { x: HistoryEntry; connName?: string; connColor: string | null }) {
  const StatusIcon = x.status === 'ok' ? CircleCheck : x.status === 'error' ? CircleAlert : CircleSlash;
  const pin = () => void useHistory.getState().togglePin(x.id).catch(() => toast('error', 'Pin failed'));
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={`history-item${x.pinned ? ' pinned' : ''}`}
      onDoubleClick={() => reopenSql(x.sql, x.connectionId, x.database)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') reopenSql(x.sql, x.connectionId, x.database);
        else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showContextMenu({ clientX: r.left + 24, clientY: r.top + 24 }, contextMenu('history.entry', x));
        }
      }}
      onContextMenu={(e) => showContextMenu(e, contextMenu('history.entry', x))}
      title="Double-click or Enter to open in a new console"
    >
      <div className="history-meta">
        <StatusIcon size={14} strokeWidth={1.75} className={`status-${x.status}`} aria-label={STATUS_LABEL[x.status]} />
        <ColorDot color={connColor} size={7} />
        <span className="history-conn" title={[connName, x.database].filter(Boolean).join(' · ')}>
          {connName ? <span dir="auto">{connName}</span> : 'deleted connection'}
          {x.database && <span className="muted"> · <span dir="auto">{x.database}</span></span>}
        </span>
        {x.label !== 'statement' && x.label !== 'script' && x.label !== 'selection' && <span className="pill pill-muted">{x.label}</span>}
        <div className="flex-1" />
        <span className="muted">{when(x.startedAt)}</span>
      </div>
      <pre className="history-sql">{x.sql.length > 600 ? `${x.sql.slice(0, 600)}…` : x.sql}</pre>
      {x.error && <div className="history-err" dir="auto">{x.error}</div>}
      <div className="history-actions">
        <span className="muted tabular">{formatDuration(x.durationMs)}</span>
        {x.resultRows !== null && <span className="muted">{pluralize(x.resultRows, 'row')}</span>}
        {x.rowsAffected !== null && x.rowsAffected > 0 && <span className="muted">{pluralize(x.rowsAffected, 'row')} affected</span>}
        <div className="flex-1" />
        <button className="icon-btn xs" title="Open in new console" aria-label="Open in new console" tabIndex={-1} onClick={() => reopenSql(x.sql, x.connectionId, x.database)}>
          <SquareTerminal size={13} />
        </button>
        <button className="icon-btn xs" title="Copy SQL" aria-label="Copy SQL" tabIndex={-1} onClick={() => void copyText(x.sql)}>
          <Copy size={13} />
        </button>
        <button className={`icon-btn xs${x.pinned ? ' on' : ''}`} title={x.pinned ? 'Unpin' : 'Pin'} aria-label={x.pinned ? 'Unpin' : 'Pin'} tabIndex={-1} onClick={pin}>
          {x.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      </div>
    </div>
  );
}

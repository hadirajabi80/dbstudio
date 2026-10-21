// Activity sub-view (docs/PLAN-M2.md 8.2): `activity.poll` snapshots (2 s) in a windowed grid with summary tiles,
// blocking chain indicators, "Only active", Sessions / Locks, search, Kill… (typed confirmation), PostgreSQL Cancel
// query, Open statement in console. Polling stops while the tab or the window is hidden.
import { Activity, Hourglass, Lock, OctagonAlert, Play, RefreshCw, Search, Timer } from 'lucide-react';
import {
  useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode,
} from 'react';
import { api, ApiError } from '../../api/client';
import type { ActivityPollItem, ActivityRow, StreamEvent } from '../../api/types';
import { engineSocket } from '../../api/ws';
import { newConsole } from '../../app/actions';
import type { ContextEntry } from '../../commands/menuModel';
import { getCommand, runCommand } from '../../commands/registry';
import { isRelational } from '../../store/connections';
import { toast } from '../../store/ui';
import { showContextMenu } from '../common/Menu';
import { CommandButton } from '../layout/CommandButton';
import { commandMenuItems } from '../layout/commandMenu';
import { withShortcut } from '../Shortcuts/Kbd';
import { KillDialog } from './KillDialog';
import {
  activityColumns, activitySummary, blockers, blockingChain, canCancelRow, cellValue, filterActivity, fmtCount, formatDuration,
  formatTime, isIdle, killStatement, type ActivityColumn, type KillMode, type LogSourceInfoEx,
} from './model';
import type { ActivityMode, LogsTabState } from './open';
import { PrivilegeState, InlineError } from './parts';

export const ACTIVITY_INTERVAL_MS = 2000;
const ROW_H = 26;
const FALLBACK_VIEW_H = 520;

export interface ActivityHandle {
  selected(): ActivityRow | null;
  canKill(): boolean;
  kill(): void;
  canCancel(): boolean;
  cancel(): void;
  canOpenStatement(): boolean;
  openStatement(): void;
  focusSearch(): void;
  refresh(): void;
  grant(): string | null;
}

export interface ActivityViewProps {
  cid: string;
  providerId: string | undefined;
  connectionName: string;
  readOnly: boolean;
  /** The connection's `kind: 'activity'` source; null = not offered. */
  source: LogSourceInfoEx | null;
  sourcesLoading: boolean;
  sourcesError: string | null;
  onRetrySources(): void;
  visible: boolean;
  onlyActive: boolean;
  mode: ActivityMode;
  onPatch(p: Partial<LogsTabState>): void;
  handleRef: MutableRefObject<ActivityHandle | null>;
}

const ROW_MENU: ContextEntry[] = [
  { command: 'logs.activity.openStatement' }, { command: 'logs.activity.cancel', hideDisabled: true }, 'separator', { command: 'logs.activity.kill' },
];

function useDocumentVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

function Tile({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className={`activity-tile${tone ? ` tone-${tone}` : ''}`} role="group" aria-label={label}>
      <span className="activity-tile-icon" aria-hidden="true">{icon}</span>
      <span className="activity-tile-text">
        <span className="activity-tile-value tabular">{value}</span>
        <span className="activity-tile-label">{label}</span>
        {detail && <span className="activity-tile-detail" title={detail}>{detail}</span>}
      </span>
    </div>
  );
}

type SortState = { key: ActivityColumn['key']; dir: 1 | -1 } | null;

function sortValue(r: ActivityRow, k: ActivityColumn['key']): number | string {
  if (k === 'duration') return r.durationMs ?? -1;
  if (k === 'cpu') return r.cpu ?? -1;
  if (k === 'reads') return r.reads ?? -1;
  if (k === 'count') return Number(r.fields?.count ?? -1);
  const v = cellValue(r, k);
  return /^\d+$/.test(v) ? Number(v) : v.toLowerCase();
}

export function ActivityView(p: ActivityViewProps) {
  const { cid, source, visible, readOnly, providerId } = p;
  const docVisible = useDocumentVisible();
  const [snap, setSnap] = useState<ActivityPollItem | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [kill, setKill] = useState<{ row: ActivityRow; mode: KillMode } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const gridId = useId().replace(/:/g, '');
  const available = !!source?.available;
  const active = visible && docVisible && available;

  useEffect(() => {
    if (!active) {
      setPolling(false);
      return;
    }
    let cancelled = false;
    let sid: string | null = null;
    let off = () => {};
    setStreamErr(null);
    const onEvent = (ev: StreamEvent) => {
      if (ev.type === 'stream.data') {
        const last = ev.items[ev.items.length - 1] as ActivityPollItem | undefined;
        if (last && Array.isArray(last.sessions)) setSnap(last);
      } else if (ev.state === 'error' || ev.state === 'ended') {
        off();
        sid = null;
        setPolling(false);
        setStreamErr(ev.state === 'error' ? ev.reason ?? 'Polling failed' : `Polling stopped (${ev.reason ?? 'ended'})`);
      }
    };
    api.openStream({ kind: 'activity.poll', connectionId: cid, params: { intervalMs: ACTIVITY_INTERVAL_MS } }).then(
      ({ streamId }) => {
        if (cancelled) {
          void api.closeStream(streamId).catch(() => {});
          return;
        }
        sid = streamId;
        off = engineSocket.onStream(streamId, onEvent);
        setPolling(true);
      },
      (e: unknown) => {
        if (!cancelled) setStreamErr(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
      off();
      if (sid) void api.closeStream(sid).catch(() => {});
      sid = null;
    };
  }, [active, cid, epoch]);

  const rows = useMemo(() => snap?.sessions ?? [], [snap]);
  const hasLocks = useMemo(() => rows.some((r) => r.kind === 'lock'), [rows]);
  const mode: ActivityMode = p.mode === 'locks' && hasLocks ? 'locks' : 'sessions';
  const summary = useMemo(() => activitySummary(rows), [rows]);
  const block = useMemo(() => blockers(rows), [rows]);
  const columns = useMemo(() => activityColumns(rows.filter((r) => (mode === 'locks') === (r.kind === 'lock')), providerId, mode), [rows, providerId, mode]);
  const shown = useMemo(() => {
    const list = filterActivity(rows, { mode, onlyActive: p.onlyActive, search });
    if (!sort) return list;
    return [...list].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, mode, p.onlyActive, search, sort]);
  const selected = useMemo(() => shown.find((r) => r.id === selectedId) ?? null, [shown, selectedId]);

  const canKill = !!selected && selected.canKill && selected.kind !== 'lock' && !readOnly;
  const canCancel = !readOnly && canCancelRow(selected, providerId);
  const canOpen = !!selected?.text && isRelational(cid);

  const openKill = useCallback((m: KillMode) => {
    if (!selected) return;
    setKill({ row: selected, mode: m });
  }, [selected]);

  const live = useRef({ selected, canKill, canCancel, canOpen, openKill });
  live.current = { selected, canKill, canCancel, canOpen, openKill };
  const grant = source && !source.available ? source.needs ?? null : null;
  const grantRef = useRef(grant);
  grantRef.current = grant;

  useEffect(() => {
    p.handleRef.current = {
      selected: () => live.current.selected,
      canKill: () => live.current.canKill,
      kill: () => live.current.canKill && live.current.openKill('terminate'),
      canCancel: () => live.current.canCancel,
      cancel: () => live.current.canCancel && live.current.openKill('cancel'),
      canOpenStatement: () => live.current.canOpen,
      openStatement: () => {
        const r = live.current.selected;
        if (!r?.text || !live.current.canOpen) return;
        const db = providerId === 'sqlserver' || providerId === 'postgresql' ? r.database ?? null : null;
        newConsole(cid, db, r.text);
      },
      focusSearch: () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      refresh: () => {
        if (!source) p.onRetrySources();
        setEpoch((e) => e + 1);
      },
      grant: () => grantRef.current,
    };
    return () => {
      p.handleRef.current = null;
    };
  }, [cid, providerId, source]);

  const doKill = async () => {
    if (!kill) return;
    try {
      const r = await api.logs.kill(cid, { id: kill.row.id, kind: kill.row.kind, ...(providerId === 'postgresql' || kill.mode === 'cancel' ? { mode: kill.mode } : {}) });
      setKill(null);
      toast(r.killed ? 'success' : 'warning', r.message ?? (r.killed ? `${kill.row.id} was ${kill.mode === 'cancel' ? 'cancelled' : 'killed'}` : `${kill.row.id} was not killed`));
      if (r.killed && kill.mode === 'terminate' && snap) setSnap({ ...snap, sessions: snap.sessions.filter((s) => s.id !== kill.row.id) });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'READ_ONLY') throw new Error(`${p.connectionName} is read-only: ${e.message}`);
      throw e instanceof Error ? e : new Error(String(e));
    }
  };

  // ---------------------------------------------------------------- empty / privilege states
  if (!source) {
    if (p.sourcesLoading) return <div className="logs-center muted" role="status">Loading…</div>;
    if (p.sourcesError) return <InlineError title="Could not read the activity sources" message={p.sourcesError} onRetry={p.onRetrySources} />;
    return (
      <div className="logs-center">
        <div className="empty-state compact">
          <div className="empty-state-icon" aria-hidden="true"><Activity size={22} /></div>
          <div className="empty-state-title">Activity is not available for this connection</div>
          <div className="empty-state-hint">Sessions, locks and running operations are listed for SQL Server, Oracle, PostgreSQL, Redis, MongoDB and Kafka connections.</div>
        </div>
      </div>
    );
  }
  if (!source.available) {
    return <PrivilegeState what="Activity" reason={source.reason} needs={source.needs} onRetry={p.onRetrySources} />;
  }

  // ---------------------------------------------------------------- grid
  const n = shown.length;
  const viewH = gridRef.current?.clientHeight || FALLBACK_VIEW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const end = Math.min(n, Math.ceil((scrollTop + viewH) / ROW_H) + 6);
  const selIndex = selected ? shown.indexOf(selected) : -1;
  const template = columns.map((c) => `${c.width}px`).join(' ');

  const selectIndex = (i: number) => {
    if (!n) return;
    const j = Math.max(0, Math.min(n - 1, i));
    setSelectedId(shown[j].id);
    const el = gridRef.current;
    if (el) {
      const top = j * ROW_H;
      const h = el.clientHeight || FALLBACK_VIEW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H * 2 > el.scrollTop + h) el.scrollTop = top + ROW_H * 2 - h;
      setScrollTop(el.scrollTop);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 2);
    const cur = selIndex;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': selectIndex(cur + 1); break;
      case 'ArrowUp': selectIndex(cur < 0 ? n - 1 : cur - 1); break;
      case 'PageDown': selectIndex(cur + page); break;
      case 'PageUp': selectIndex(cur - page); break;
      case 'Home': selectIndex(0); break;
      case 'End': selectIndex(n - 1); break;
      case 'Enter': if (canOpen) runCommand('logs.activity.openStatement'); break;
      case 'Delete': if (canKill) runCommand('logs.activity.kill'); break;
      case 'ContextMenu': {
        const r = gridRef.current?.getBoundingClientRect();
        if (r) showContextMenu({ clientX: r.left + 40, clientY: r.top + (selIndex + 1) * ROW_H - (gridRef.current?.scrollTop ?? 0) + ROW_H }, commandMenuItems(ROW_MENU));
        break;
      }
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const toggleSort = (k: ActivityColumn['key']) => setSort((s) => (s?.key === k ? (s.dir === 1 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 }));
  const longest = summary.longest;
  const killReason = readOnly && selected?.canKill ? `${p.connectionName} is read-only` : null;

  const cell = (r: ActivityRow, c: ActivityColumn): ReactNode => {
    const v = cellValue(r, c.key);
    if (c.key === 'blockedBy' && r.blockedBy) {
      const chain = blockingChain(rows, r.id);
      return (
        <span className="activity-blocked" title={`Blocking chain: ${[r.id, ...chain].join(' ← ')}`}>
          ↳ blocked by <strong className="mono">{r.blockedBy}</strong>
        </span>
      );
    }
    if (c.key === 'id') {
      const n2 = rows.filter((x) => x.blockedBy === r.id && x.kind !== 'lock').length;
      return (
        <>
          <span className="mono">{v}</span>
          {n2 > 0 && <span className="pill pill-warning activity-blocking" title={`Blocks ${n2} ${n2 === 1 ? 'session' : 'sessions'}`}>blocks {n2}</span>}
        </>
      );
    }
    if (c.key === 'state') return <span className={`activity-state${isIdle(r) ? ' idle' : ''}`}>{v}</span>;
    return v;
  };

  return (
    <div className="activity-view">
      <div className="activity-tiles">
        <Tile icon={<Activity size={16} />} label="Sessions" value={fmtCount(summary.sessions)} />
        <Tile icon={<Play size={16} />} label="Running" value={fmtCount(summary.running)} />
        <Tile icon={<OctagonAlert size={16} />} label="Blocked" value={fmtCount(summary.blocked)} tone={summary.blocked ? 'danger' : undefined} detail={block.head.size ? `head blocker ${[...block.head].join(', ')}` : undefined} />
        <Tile icon={<Hourglass size={16} />} label="Longest running" value={longest?.durationMs != null ? formatDuration(longest.durationMs) : '—'} detail={longest ? `${longest.id}${longest.command ? ` · ${longest.command}` : ''}` : undefined} tone={(longest?.durationMs ?? 0) > 60_000 ? 'warn' : undefined} />
      </div>
      <div className="activity-toolbar toolbar">
        {hasLocks && (
          <div className="segmented" role="group" aria-label="Rows">
            <button type="button" className={mode === 'sessions' ? 'on' : undefined} aria-pressed={mode === 'sessions'} onClick={() => p.onPatch({ activityMode: 'sessions' })}>Sessions</button>
            <button type="button" className={mode === 'locks' ? 'on' : undefined} aria-pressed={mode === 'locks'} onClick={() => p.onPatch({ activityMode: 'locks' })}>
              <Lock size={12} /> Locks
            </button>
          </div>
        )}
        <button
          type="button"
          className={`chip${p.onlyActive ? ' on' : ''}`}
          aria-pressed={p.onlyActive}
          title={getCommand('logs.activity.onlyActive')?.title}
          onClick={() => runCommand('logs.activity.onlyActive')}
          disabled={mode === 'locks'}
        >
          Only active
        </button>
        <div className="search-box logs-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            className="input"
            placeholder="Filter sessions…"
            aria-label="Filter sessions"
            title={withShortcut('Filter sessions', getCommand('logs.search')?.shortcut)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                setSearch('');
              }
            }}
          />
        </div>
        <span className="flex-1" />
        <CommandButton command="logs.activity.openStatement" label="Open in console" variant="btn" className="btn-xs" />
        {(providerId === 'postgresql' || shown.some((r) => r.fields?.cancelStatement)) && <CommandButton command="logs.activity.cancel" label="Cancel query" variant="btn" className="btn-xs" />}
        <CommandButton command="logs.activity.kill" label="Kill…" variant="btn" className="btn-xs logs-danger" disabledReason={killReason} />
      </div>
      {streamErr && <InlineError title="Activity polling failed" message={streamErr} onRetry={() => setEpoch((e) => e + 1)} compact />}
      <div
        ref={gridRef}
        className="activity-grid"
        role="grid"
        aria-label={`Activity of ${p.connectionName}`}
        aria-rowcount={n + 1}
        aria-colcount={columns.length}
        aria-activedescendant={selected ? `${gridId}-a${selIndex}` : undefined}
        tabIndex={0}
        data-primary-focus
        data-command-scope="logsActivity"
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !selected && n) setSelectedId(shown[0].id);
        }}
      >
        <div className="activity-head" role="row" aria-rowindex={1} style={{ gridTemplateColumns: template }}>
          {columns.map((c) => (
            <div
              key={c.key}
              role="columnheader"
              className={`activity-th${c.numeric ? ' num' : ''}`}
              aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
              onClick={() => toggleSort(c.key)}
              title={`Sort by ${c.title}`}
            >
              {c.title}
              {sort?.key === c.key && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
            </div>
          ))}
        </div>
        <div className="activity-body" style={{ height: n * ROW_H }}>
          {shown.slice(start, end).map((r, k) => {
            const i = start + k;
            const sel = r.id === selectedId;
            return (
              <div
                key={r.id}
                id={`${gridId}-a${i}`}
                role="row"
                aria-rowindex={i + 2}
                aria-selected={sel}
                className={`activity-row${sel ? ' selected' : ''}${block.all.has(r.id) ? ' is-blocker' : ''}${block.head.has(r.id) ? ' is-head-blocker' : ''}${r.blockedBy ? ' is-blocked' : ''}${isIdle(r) ? ' idle' : ''}`}
                style={{ top: i * ROW_H, gridTemplateColumns: template }}
                onMouseDown={() => setSelectedId(r.id)}
                onDoubleClick={() => canOpen && runCommand('logs.activity.openStatement')}
                onContextMenu={(e) => {
                  setSelectedId(r.id);
                  // let React apply the selection before the menu evaluates `when`
                  const pos = { clientX: e.clientX, clientY: e.clientY };
                  e.preventDefault();
                  setTimeout(() => showContextMenu(pos, commandMenuItems(ROW_MENU)), 0);
                }}
              >
                {columns.map((c) => (
                  <div key={c.key} role="gridcell" className={`activity-td${c.numeric ? ' num tabular' : ''}${c.key === 'text' ? ' mono' : ''}`} title={c.key === 'text' ? r.text : undefined}>
                    {cell(r, c)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {n === 0 && (
          <div className="activity-empty muted" role="status">
            {snap ? (rows.length ? 'No sessions match the filter.' : 'No sessions.') : polling ? 'Waiting for the first snapshot…' : 'Not polling.'}
          </div>
        )}
      </div>
      <div className="logs-status" role="status" aria-live="off">
        <span>
          {fmtCount(n)} shown{rows.length !== n ? ` of ${fmtCount(mode === 'locks' ? rows.filter((r) => r.kind === 'lock').length : summary.sessions)}` : ''}
        </span>
        <span className="logs-status-sep">·</span>
        <span className={polling ? 'logs-live' : undefined}>
          <Timer size={12} aria-hidden="true" /> {polling ? `polling every ${ACTIVITY_INTERVAL_MS / 1000} s` : !visible || !docVisible ? 'paused while hidden' : 'not polling'}
        </span>
        {snap && (
          <>
            <span className="logs-status-sep">·</span>
            <span>updated {formatTime(snap.ts)}</span>
          </>
        )}
        <span className="flex-1" />
        <button type="button" className="btn btn-xs btn-ghost" onClick={() => setEpoch((e) => e + 1)} title="Restart polling">
          <RefreshCw size={12} /> Restart
        </button>
      </div>
      {kill && (
        <KillDialog
          row={kill.row}
          mode={kill.mode}
          statement={killStatement(kill.row, kill.mode, providerId)}
          connectionName={p.connectionName}
          onConfirm={doKill}
          onClose={() => setKill(null)}
        />
      )}
    </div>
  );
}

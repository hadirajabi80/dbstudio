// "Logs & activity" tab (docs/PLAN-M2.md 8.2; lazy chunk). Logs: server log sources of the connection plus the engine
// log, level / time / search filters, range queries with "Load older", live tail (stream `logs.tail`) into a capped
// buffer, export (engine for ranges, client-side for the tail buffer). Activity: see ActivityView.tsx.
//
// Keys: the root is `data-command-scope="logs"` (Mod+F search), the list `logsList` (Space pause, Enter expand,
// Mod+C copy). F5 (refresh) and Mod+L (clear) are handled here directly because app-wide bindings own those keys
// (run.script, explain.estimated) and a scoped command may not shadow them.
import { Activity, Download, Radio, RefreshCw, ScrollText, Search, WrapText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client';
import { ENGINE_LOG_CID } from '../../api/client.m2';
import type { JobDoneEvent, LogEntry, LogExportFormat, LogExportResult, LogQuery, StreamEvent } from '../../api/types';
import { engineSocket } from '../../api/ws';
import { copyText } from '../../app/actions';
import { getCommand, runCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import { getPlatform } from '../../platform';
import { useConnection } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { showMenuBelow } from '../common/Menu';
import { Select } from '../common/Select';
import { CommandButton } from '../layout/CommandButton';
import { commandMenuItems } from '../layout/commandMenu';
import type { TabViewProps } from '../layout/tabViews';
import { withShortcut } from '../Shortcuts/Kbd';
import { ActivityView, type ActivityHandle } from './ActivityView';
import { setLogsController, type LogsController } from './controller';
import { LogList } from './LogList';
import {
  archiveOptions, entryMatches, entryText, expandLevels, EXPORT_MIME, exportFileName, fmtCount, formatEntries, fromLocalInput, makeMatcher,
  mergeSources, needsOf, parseConfigSet, parseProfilingHint, PRESET_LABELS, serverQuery, TailBuffer, timeRange, toLocalInput, type LogSourceInfoEx, type UiSource,
} from './model';
import { LEVEL_CHIPS, normalizeLogsState, type FromPreset, type LevelChip, type LogsTabState } from './open';
import { Banner, InlineError, PrivilegeState } from './parts';
import './logs.css';

export const QUERY_LIMIT = 1000;
export const EXPORT_LIMIT = 5000;
const SEARCH_DEBOUNCE_MS = 250;
const RENDER_THROTTLE_MS = 60;

type LoadStatus = 'idle' | 'loading' | 'ok' | 'error' | 'privilege';
interface LoadState {
  status: LoadStatus;
  key: string | null;
  message?: string | null;
  needs?: string | null;
  hasMore: boolean;
  truncated: boolean;
  loadingOlder?: boolean;
}

type TailStatus = 'off' | 'opening' | 'open' | 'paused' | 'ended' | 'error';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Keys the view handles itself (see the header comment). */
export const LOCAL_KEYS = { refresh: 'F5', clear: 'Mod+L' } as const;
const LEVEL_NAMES: Record<LevelChip, string> = { debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error' };

/** A toggle button bound to a command (title + shortcut from the registry). */
function CmdToggle({ command, pressed, className, children, disabled, shortcut }: {
  command: string;
  /** Omitted: a plain command button (no aria-pressed). */
  pressed?: boolean;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  /** Shortcut handled by the view itself (not declared on the command), shown in the tooltip. */
  shortcut?: string;
}) {
  const v = commandView(command);
  return (
    <button
      type="button"
      className={`${className ?? 'chip'}${pressed ? ' on' : ''}`}
      aria-pressed={pressed}
      title={shortcut ? withShortcut(v.title, shortcut) : v.tooltip}
      disabled={disabled || !v.enabled}
      data-command={command}
      onClick={v.run}
    >
      {children}
    </button>
  );
}

export function LogsView({ tab, visible }: TabViewProps) {
  const st = useMemo(() => normalizeLogsState(tab.state, tab.connectionId), [tab.state, tab.connectionId]);
  const cid = st.connectionId;
  const isEngineTab = cid === ENGINE_LOG_CID;
  const conn = useConnection(isEngineTab ? null : cid);
  const providerId = conn?.providerId;
  const readOnly = !!conn?.readOnly;
  const connName = isEngineTab ? 'Rowlit engine' : conn?.name ?? cid;

  const patch = useCallback((p: Partial<LogsTabState>) => {
    const cur = useTabs.getState().tabs.find((t) => t.id === tab.id);
    if (!cur || cur.kind !== 'view') return;
    useTabs.getState().updateView(tab.id, { state: { ...normalizeLogsState(cur.state, cur.connectionId), ...p } });
  }, [tab.id]);

  // ---------------------------------------------------------------- sources
  const [srcs, setSrcs] = useState<{ loaded: boolean; loading: boolean; conn: LogSourceInfoEx[] | null; engine: LogSourceInfoEx[] | null; connError: string | null }>(
    { loaded: false, loading: true, conn: null, engine: null, connError: null },
  );
  const [srcEpoch, setSrcEpoch] = useState(0);
  useEffect(() => {
    let off = false;
    setSrcs((s) => ({ ...s, loading: true }));
    // A re-fetch (retry, refresh, after applying a hint) bypasses the engine's five-minute source cache.
    const refresh = srcEpoch > 0;
    void Promise.allSettled([isEngineTab ? Promise.resolve([]) : api.logs.sources(cid, refresh), api.logs.sources(ENGINE_LOG_CID, refresh)]).then(([a, b]) => {
      if (off) return;
      setSrcs({
        loaded: true, loading: false,
        conn: a.status === 'fulfilled' ? (a.value as LogSourceInfoEx[]) : null,
        engine: b.status === 'fulfilled' ? (b.value as LogSourceInfoEx[]) : null,
        connError: a.status === 'rejected' ? errMsg(a.reason) : null,
      });
    });
    return () => {
      off = true;
    };
  }, [cid, isEngineTab, srcEpoch]);
  const merged = useMemo(() => mergeSources(cid, srcs.conn, srcs.engine), [cid, srcs.conn, srcs.engine]);
  const source: UiSource | null = srcs.loaded
    ? merged.logs.find((s) => s.info.id === st.sourceId) ?? merged.logs.find((s) => s.info.available) ?? merged.logs[0] ?? null
    : null;
  const info = source?.info ?? null;
  const srcKey = source ? `${source.cid}|${source.info.id}` : null;
  const canTail = !!info?.supportsTail && !!info.available;
  const liveOnly = !!info && !info.supportsRange;
  const tailOn = st.tail && canTail;
  const archives = archiveOptions(info);

  // ---------------------------------------------------------------- buffer + rendering
  const buf = useRef(new TailBuffer());
  const [ver, bump] = useReducer((x: number) => x + 1, 0);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRender = useCallback(() => {
    if (renderTimer.current) return;
    renderTimer.current = setTimeout(() => {
      renderTimer.current = null;
      bump();
    }, RENDER_THROTTLE_MS);
  }, []);
  useEffect(() => () => {
    if (renderTimer.current) clearTimeout(renderTimer.current);
  }, []);

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [follow, setFollow] = useState(true);
  const listEl = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ---------------------------------------------------------------- search (debounced)
  const [searchText, setSearchText] = useState(st.search);
  useEffect(() => setSearchText(st.search), [st.search]);
  useEffect(() => {
    if (searchText === st.search) return;
    const t = setTimeout(() => patch({ search: searchText }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchText, st.search, patch]);
  const matcher = useMemo(() => makeMatcher(st.search), [st.search]);

  // ---------------------------------------------------------------- range query
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: 'idle', key: null, hasMore: false, truncated: false });
  const levelsKey = [...st.levels].sort().join(',');
  const q = tailOn ? undefined : serverQuery(st.search);
  const loadKey = source
    ? JSON.stringify(liveOnly ? [srcKey, refreshEpoch, info?.available] : [srcKey, st.archive, levelsKey, st.from, st.fromCustom, tailOn ? null : st.to, q ?? null, tailOn, refreshEpoch, info?.available])
    : null;

  const buildQuery = useCallback((limit: number, before?: number): LogQuery => {
    const range = timeRange(st.from, Date.now(), st.fromCustom, tailOn ? null : st.to);
    return {
      sourceId: info?.id ?? '', limit, levels: expandLevels(st.levels), ...range,
      ...(q ? { q } : {}), ...(before != null ? { before } : {}), ...(archives.length && st.archive ? { archive: st.archive } : {}),
    };
  }, [st.from, st.fromCustom, st.to, st.levels, st.archive, tailOn, info?.id, q, archives.length]);
  const buildQueryRef = useRef(buildQuery);
  buildQueryRef.current = buildQuery;

  const lastSrcKey = useRef<string | null>(null);
  useEffect(() => {
    if (!loadKey || !source) return;
    const s = source;
    const changedSource = lastSrcKey.current !== srcKey;
    lastSrcKey.current = srcKey;
    if (changedSource) {
      setSelectedSeq(null);
      setExpanded(new Set());
    }
    if (!s.info.available) {
      buf.current.clear();
      setLoad({ status: 'privilege', key: loadKey, message: s.info.reason ?? null, needs: s.info.needs ?? null, hasMore: false, truncated: false });
      bump();
      return;
    }
    if (!s.info.supportsRange) {
      if (changedSource) buf.current.clear();
      setLoad({ status: 'ok', key: loadKey, hasMore: false, truncated: false });
      bump();
      return;
    }
    const ctl = new AbortController();
    setLoad((l) => ({ ...l, status: 'loading', key: null }));
    api.logs.query(s.cid, buildQueryRef.current(QUERY_LIMIT), ctl.signal).then(
      (r) => {
        if (ctl.signal.aborted) return;
        buf.current.replace(r.entries);
        setFollow(true);
        setLoad({ status: 'ok', key: loadKey, hasMore: r.hasMore, truncated: r.truncated });
        bump();
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        buf.current.clear();
        if (e instanceof ApiError && e.code === 'PRIVILEGE') {
          setLoad({ status: 'privilege', key: loadKey, message: e.message, needs: needsOf(e.detail) ?? s.info.needs ?? null, hasMore: false, truncated: false });
        } else {
          setLoad({ status: 'error', key: loadKey, message: errMsg(e), hasMore: false, truncated: false });
        }
        bump();
      },
    );
    return () => ctl.abort();
    // buildQuery is encoded in loadKey
  }, [loadKey]);

  const ready = load.key === loadKey && load.status === 'ok';

  // ---------------------------------------------------------------- tail stream
  const [tailEpoch, setTailEpoch] = useState(0);
  const [tail, setTail] = useState<{ status: TailStatus; reason: string | null }>({ status: 'off', reason: null });
  const stream = useRef<{ id: string; paused: boolean } | null>(null);
  const droppedBase = useRef(0);
  const droppedCur = useRef(0);
  /** The engine pushed its MONITOR auto-stop marker (`fields.autoStopped`) before ending the stream. */
  const autoStopSeen = useRef(false);
  /** The next open is an Extend (MONITOR: another 10 minutes). */
  const extending = useRef(false);
  const tailKey = ready && tailOn && source ? JSON.stringify([loadKey, levelsKey, tailEpoch]) : null;

  useEffect(() => {
    if (!tailKey || !source) return;
    const s = source;
    let cancelled = false;
    let off = () => {};
    const settle = () => {
      droppedBase.current += droppedCur.current;
      droppedCur.current = 0;
    };
    setTail({ status: 'opening', reason: null });
    setFollow(true);
    autoStopSeen.current = false;
    const extend = extending.current;
    extending.current = false;
    const onEvent = (ev: StreamEvent) => {
      if (ev.type === 'stream.data') {
        const items = ev.items as LogEntry[];
        if (items.some((i) => i.fields?.autoStopped === 'true')) autoStopSeen.current = true;
        buf.current.push(items);
        scheduleRender();
        return;
      }
      if (typeof ev.dropped === 'number') droppedCur.current = Math.max(droppedCur.current, ev.dropped);
      if (ev.state === 'ended' || ev.state === 'error') {
        off();
        stream.current = null;
        settle();
      } else if (stream.current) {
        stream.current.paused = ev.state === 'paused';
      }
      setTail({ status: ev.state, reason: ev.reason });
      bump();
    };
    // `after` resumes right after the newest entry the view holds (no gap after the initial query).
    const after = buf.current.entries.length ? buf.current.entries[buf.current.entries.length - 1].seq : null;
    const params: Record<string, unknown> = { sourceId: s.info.id, levels: expandLevels(st.levels) };
    if (after != null) params.after = after;
    if (extend) params.maxMinutes = 10;
    api.openStream({ kind: 'logs.tail', connectionId: s.cid, params }).then(
      ({ streamId }) => {
        if (cancelled) {
          void api.closeStream(streamId).catch(() => {});
          return;
        }
        stream.current = { id: streamId, paused: false };
        off = engineSocket.onStream(streamId, onEvent);
        setTail({ status: 'open', reason: null });
      },
      (e: unknown) => {
        if (!cancelled) setTail({ status: 'error', reason: errMsg(e) });
      },
    );
    return () => {
      cancelled = true;
      off();
      const cur = stream.current;
      stream.current = null;
      if (cur) void api.closeStream(cur.id).catch(() => {});
      settle();
      setTail({ status: 'off', reason: null });
    };
  }, [tailKey]);

  const tailing = tail.status === 'open' || tail.status === 'opening' || tail.status === 'paused';
  const autoStopped = tail.status === 'ended' && (autoStopSeen.current || /auto-stop/i.test(tail.reason ?? ''));
  const extendTail = () => {
    extending.current = true;
    setTailEpoch((e) => e + 1);
  };

  // ---------------------------------------------------------------- derived
  const shown = useMemo(() => {
    void ver;
    return buf.current.entries.filter((e) => entryMatches(e, st.levels, matcher));
  }, [ver, st.levels, matcher]);
  const dropped = droppedBase.current + droppedCur.current;
  const evicted = buf.current.evicted;
  const selectedEntry = useMemo(() => (selectedSeq == null ? null : shown.find((e) => e.seq === selectedSeq) ?? null), [shown, selectedSeq]);
  const hint = info && info.available && info.reason ? info : null;
  const logsGrant = load.status === 'privilege' && load.key === loadKey ? load.needs ?? null : hint?.needs ?? null;

  // ---------------------------------------------------------------- actions
  const activity = useRef<ActivityHandle | null>(null);

  const clear = useCallback(() => {
    buf.current.clear();
    droppedBase.current = 0;
    droppedCur.current = 0;
    setSelectedSeq(null);
    setExpanded(new Set());
    setLoad((l) => ({ ...l, hasMore: false }));
    bump();
  }, []);

  const togglePause = useCallback(() => {
    const s = stream.current;
    if (!s) return;
    const next = !s.paused;
    s.paused = next;
    setTail({ status: next ? 'paused' : 'open', reason: null });
    if (!next) setFollow(true);
    void (next ? api.pauseStream(s.id) : api.resumeStream(s.id)).catch((e: unknown) => toast('error', next ? 'Could not pause the tail' : 'Could not resume the tail', errMsg(e)));
  }, []);

  const loadOlder = useCallback(async () => {
    if (!source || !load.hasMore || load.loadingOlder) return;
    const before = buf.current.oldestSeq();
    if (before == null) return;
    setLoad((l) => ({ ...l, loadingOlder: true }));
    try {
      const r = await api.logs.query(source.cid, buildQuery(QUERY_LIMIT, before));
      const taken = buf.current.prepend(r.entries);
      setLoad((l) => ({ ...l, loadingOlder: false, hasMore: r.hasMore || taken < r.entries.length, truncated: l.truncated || r.truncated }));
      setFollow(false);
      bump();
    } catch (e) {
      setLoad((l) => ({ ...l, loadingOlder: false }));
      toast('error', 'Could not load older entries', errMsg(e));
    }
  }, [source, load.hasMore, load.loadingOlder, buildQuery]);

  const watchJob = (jobId: string) => {
    toast('info', 'Exporting log…');
    const off = engineSocket.onJob(jobId, (ev) => {
      if (ev.type !== 'job.done') return;
      off();
      const d = ev as JobDoneEvent;
      if (d.status === 'ok') {
        const res = (d.result ?? {}) as Partial<LogExportResult>;
        toast('success', `Exported ${fmtCount(res.entries ?? 0)} log entries`, res.path ?? undefined);
      } else if (d.status === 'error') toast('error', 'Log export failed', d.error ?? undefined);
    });
  };

  const exportAs = useCallback(async (format: LogExportFormat) => {
    if (!info || !source) return;
    const name = exportFileName(info.id, format);
    const filters = [{ name: format.toUpperCase(), extensions: [format] }];
    const platform = getPlatform();
    // The tail buffer (and live-only sources) are exported from what the view holds.
    if (tailOn || liveOnly) {
      const saved = await platform.saveFile({ suggestedName: name, content: formatEntries(shown, format), mime: EXPORT_MIME[format], filters });
      if (saved) toast('success', `Exported ${fmtCount(shown.length)} log entries`, saved);
      return;
    }
    try {
      const body = { ...buildQuery(EXPORT_LIMIT), format, path: null as string | null };
      if (platform.hasFileSystem) {
        const path = await platform.showSaveDialog({ title: 'Export log', defaultPath: name, filters });
        if (!path) return;
        body.path = path;
      }
      const r = await api.logs.export(source.cid, body);
      if ('jobId' in r) watchJob(r.jobId);
      else {
        const saved = await platform.saveFile({ suggestedName: r.filename ?? name, content: r.blob, mime: EXPORT_MIME[format], filters });
        if (saved) toast('success', `Exported ${r.filename ?? name}`);
      }
    } catch (e) {
      toast('error', 'Log export failed', errMsg(e));
    }
  }, [info, source, tailOn, liveOnly, shown, buildQuery]);

  const toggleExpand = useCallback((seq: number) => {
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(seq)) n.delete(seq);
      else n.add(seq);
      return n;
    });
  }, []);

  const refresh = useCallback(() => {
    if (st.sub === 'activity') {
      activity.current?.refresh();
      return;
    }
    if (load.status === 'privilege' || !srcs.conn) setSrcEpoch((e) => e + 1);
    setRefreshEpoch((e) => e + 1);
  }, [st.sub, load.status, srcs.conn]);

  const applyConfigHint = async () => {
    const set = parseConfigSet(hint?.needs);
    if (!set) return;
    try {
      await api.redis.setConfig(cid, set);
      toast('success', `${set.name} set to ${set.value}`);
      setSrcEpoch((e) => e + 1);
      setRefreshEpoch((e) => e + 1);
    } catch (e) {
      toast('error', `Could not set ${set.name}`, errMsg(e));
    }
  };

  const applyProfilingHint = async () => {
    const p = parseProfilingHint(info?.id, hint?.needs);
    if (!p) return;
    try {
      await api.mongo.setProfiling(cid, p.db, { level: p.level, slowms: p.slowms });
      toast('success', `Profiling of ${p.db} set to level ${p.level} (slowms ${p.slowms})`);
      setSrcEpoch((e) => e + 1);
      setRefreshEpoch((e) => e + 1);
    } catch (e) {
      toast('error', `Could not change the profiling level of ${p.db}`, errMsg(e));
    }
  };

  // ---------------------------------------------------------------- controller (commands)
  const live = useRef({
    st, canTail, tailOn, tailing, selectedEntry, load, info, logsGrant, clear, togglePause, loadOlder, exportAs, toggleExpand, refresh, patch,
  });
  live.current = { st, canTail, tailOn, tailing, selectedEntry, load, info, logsGrant, clear, togglePause, loadOlder, exportAs, toggleExpand, refresh, patch };

  useEffect(() => {
    const L = () => live.current;
    const ctl: LogsController = {
      tabId: tab.id,
      connectionId: cid,
      sub: () => L().st.sub,
      setSub: (sub) => L().patch({ sub }),
      levelOn: (l) => L().st.levels.includes(l),
      toggleLevel: (l) => {
        const cur = L().st.levels;
        L().patch({ levels: cur.includes(l) ? cur.filter((x) => x !== l) : LEVEL_CHIPS.filter((x) => x === l || cur.includes(x)) });
      },
      canTail: () => L().canTail,
      tailing: () => L().tailOn,
      toggleTail: () => L().canTail && L().patch({ tail: !L().st.tail }),
      canPause: () => L().tailing,
      togglePause: () => L().togglePause(),
      clear: () => L().clear(),
      focusSearch: () => {
        if (L().st.sub === 'activity') activity.current?.focusSearch();
        else {
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      },
      hasSelection: () => !!L().selectedEntry,
      copySelected: () => {
        const e = L().selectedEntry;
        if (e) void copyText(entryText(e), 'Log entry copied');
      },
      expandSelected: () => {
        const e = L().selectedEntry;
        if (e) L().toggleExpand(e.seq);
      },
      canLoadOlder: () => L().load.status === 'ok' && L().load.hasMore && !L().load.loadingOlder,
      loadOlder: () => void L().loadOlder(),
      refresh: () => L().refresh(),
      toggleWrap: () => L().patch({ wrap: !L().st.wrap }),
      canExport: () => !!L().info?.available && L().load.status !== 'privilege',
      exportAs: (f) => void L().exportAs(f),
      canKill: () => !!activity.current?.canKill(),
      kill: () => activity.current?.kill(),
      canCancel: () => !!activity.current?.canCancel(),
      cancelQuery: () => activity.current?.cancel(),
      canOpenStatement: () => !!activity.current?.canOpenStatement(),
      openStatement: () => activity.current?.openStatement(),
      toggleOnlyActive: () => L().patch({ onlyActive: !L().st.onlyActive }),
      grant: () => (L().st.sub === 'activity' ? activity.current?.grant() ?? null : L().logsGrant),
      copyGrant: () => {
        const g = L().st.sub === 'activity' ? activity.current?.grant() ?? null : L().logsGrant;
        if (g) void copyText(g, 'Statement copied — send it to your DBA');
      },
    };
    setLogsController(tab.id, ctl);
    return () => setLogsController(tab.id, null);
  }, [tab.id, cid]);

  // F5 / Mod+L: see the header comment.
  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F5' && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      runCommand('logs.refresh');
    } else if (mod && !e.altKey && !e.shiftKey && (e.key === 'l' || e.key === 'L') && st.sub === 'logs') {
      e.preventDefault();
      e.stopPropagation();
      runCommand('logs.clear');
    }
  };

  // ---------------------------------------------------------------- render
  const sourceOptions = merged.logs.map((s) => ({
    value: s.info.id,
    label: s.info.title,
    group: s.cid === ENGINE_LOG_CID ? 'Rowlit' : connName,
    hint: !s.info.available ? 'no access' : !s.info.supportsRange ? 'live' : undefined,
  }));
  const activityAvailable = !isEngineTab;

  const statusText = (() => {
    const parts: string[] = [];
    const total = buf.current.size;
    parts.push(shown.length === total ? `${fmtCount(total)} ${total === 1 ? 'entry' : 'entries'}` : `${fmtCount(shown.length)} of ${fmtCount(total)} entries`);
    if (tail.status === 'opening') parts.push('starting tail…');
    else if (tail.status === 'open') parts.push('tailing');
    else if (tail.status === 'paused') parts.push('paused');
    else if (tail.status === 'ended') parts.push(`tail ended${tail.reason ? ` (${tail.reason})` : ''}`);
    else if (tail.status === 'error') parts.push('tail failed');
    if (tailOn || dropped || evicted) {
      parts.push(`${fmtCount(dropped)} dropped`);
      parts.push(`${fmtCount(evicted)} evicted`);
    }
    if (matcher.regex) parts.push('regex');
    return parts.join(' · ');
  })();

  const exportMenu = (el: HTMLElement) => showMenuBelow(el, commandMenuItems([{ command: 'logs.export.txt' }, { command: 'logs.export.csv' }, { command: 'logs.export.json' }]));
  const exportView = commandView('logs.export.txt');

  const logsBody = () => {
    if (!srcs.loaded) return <div className="logs-center muted" role="status">Loading log sources…</div>;
    if (!source) return <InlineError title="No log sources" message="This connection offers no log sources." onRetry={() => setSrcEpoch((e) => e + 1)} />;
    if (load.status === 'privilege' && load.key === loadKey) {
      return <PrivilegeState what={info?.title ?? 'This log'} reason={load.message} needs={load.needs} onRetry={() => { setSrcEpoch((e) => e + 1); setRefreshEpoch((e) => e + 1); }} />;
    }
    if (load.status === 'error' && load.key === loadKey) {
      return <InlineError title={`Could not read ${info?.title ?? 'the log'}`} message={load.message ?? 'Unknown error'} onRetry={() => setRefreshEpoch((e) => e + 1)} />;
    }
    const empty = load.status === 'loading'
      ? <span className="muted" role="status">Loading…</span>
      : liveOnly && !tailOn
        ? <span className="muted">This source is live only. Start the tail to see new entries.</span>
        : tailing && !buf.current.size
          ? <span className="muted">Waiting for new entries…</span>
          : <span className="muted">No entries match the filters.</span>;
    return (
      <LogList
        entries={shown}
        selectedSeq={selectedSeq}
        onSelect={setSelectedSeq}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        wrap={st.wrap}
        pattern={matcher.pattern}
        follow={follow}
        onFollowChange={setFollow}
        tailing={tailing}
        onCopy={(e) => void copyText(entryText(e), 'Log entry copied')}
        onEscape={() => {
          if (searchText || st.search) {
            setSearchText('');
            patch({ search: '' });
          }
        }}
        label={`${info?.title ?? 'Log'} entries`}
        empty={empty}
        listRef={(el) => {
          listEl.current = el;
        }}
      />
    );
  };

  return (
    <div className="logs-view" data-command-scope="logs" onKeyDown={onRootKeyDown} aria-label={`Logs and activity of ${connName}`} role="region">
      <div className="logs-header">
        <span className="logs-title">
          <ScrollText size={16} aria-hidden="true" />
          <span>Logs &amp; activity</span>
          <span className="logs-conn" title={connName}>{connName}</span>
        </span>
        <div className="segmented" role="group" aria-label="View">
          <CmdToggle command="logs.showLogs" pressed={st.sub === 'logs'} className="seg-btn">
            <ScrollText size={12} aria-hidden="true" /> Logs
          </CmdToggle>
          <CmdToggle command="logs.showActivity" pressed={st.sub === 'activity'} className="seg-btn" disabled={!activityAvailable}>
            <Activity size={12} aria-hidden="true" /> Activity
          </CmdToggle>
        </div>
        {st.sub === 'logs' && (
          <>
            <label className="logs-field">
              <span className="tb-label">Source</span>
              <Select
                size="sm"
                aria-label="Log source"
                value={info?.id ?? null}
                options={sourceOptions}
                placeholder={srcs.loaded ? 'No sources' : 'Loading…'}
                disabled={!srcs.loaded || !sourceOptions.length}
                onChange={(id) => {
                  const s = merged.logs.find((x) => x.info.id === id);
                  patch({ sourceId: id, archive: 0, ...(s && !s.info.supportsRange && s.info.available ? { tail: true } : {}) });
                }}
              />
            </label>
            {archives.length > 0 && (
              <label className="logs-field">
                <span className="tb-label">Archive</span>
                <Select size="sm" aria-label="Log archive" value={st.archive} options={archives} onChange={(v) => patch({ archive: v })} />
              </label>
            )}
          </>
        )}
        <span className="flex-1" />
        <CmdToggle command="logs.refresh" className="icon-btn" shortcut={LOCAL_KEYS.refresh}>
          <RefreshCw size={16} aria-hidden="true" />
          <span className="sr-only">Refresh</span>
        </CmdToggle>
      </div>

      {st.sub === 'logs' ? (
        <>
          <div className="logs-filters" role="toolbar" aria-label="Log filters">
            <div className="chip-row" role="group" aria-label="Levels">
              {LEVEL_CHIPS.map((l) => (
                <CmdToggle key={l} command={`logs.level.${l}`} pressed={st.levels.includes(l)} className={`chip logs-level-chip lvl-${l}`}>
                  <span className={`logs-dot lvl-${l}`} aria-hidden="true" />
                  {LEVEL_NAMES[l]}
                </CmdToggle>
              ))}
            </div>
            {!liveOnly && (
              <>
                <label className="logs-field">
                  <span className="tb-label">From</span>
                  <Select<FromPreset>
                    size="sm"
                    aria-label="From"
                    value={st.from}
                    options={(Object.keys(PRESET_LABELS) as FromPreset[]).map((k) => ({ value: k, label: PRESET_LABELS[k] }))}
                    onChange={(v) => patch(v === 'custom' ? { from: v, fromCustom: st.fromCustom ?? new Date(Date.now() - 3_600_000).toISOString() } : { from: v })}
                  />
                </label>
                {st.from === 'custom' && (
                  <input
                    type="datetime-local"
                    className="input logs-date"
                    aria-label="From date and time"
                    value={toLocalInput(st.fromCustom)}
                    onChange={(e) => patch({ fromCustom: fromLocalInput(e.target.value) })}
                  />
                )}
                <label className="logs-field">
                  <span className="tb-label">To</span>
                  <Select
                    size="sm"
                    aria-label="To"
                    value={st.to ? 'custom' : 'now'}
                    disabled={tailOn}
                    options={[{ value: 'now', label: 'Now' }, { value: 'custom', label: 'Custom…' }]}
                    onChange={(v) => patch({ to: v === 'now' ? null : new Date().toISOString() })}
                  />
                </label>
                {st.to && !tailOn && (
                  <input
                    type="datetime-local"
                    className="input logs-date"
                    aria-label="To date and time"
                    value={toLocalInput(st.to)}
                    onChange={(e) => patch({ to: fromLocalInput(e.target.value) })}
                  />
                )}
              </>
            )}
            <div className="search-box logs-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                className="input"
                dir="auto"
                placeholder="Search (text or regex)…"
                aria-label="Search log entries"
                title={withShortcut('Search log entries: text or regular expression, case-insensitive', getCommand('logs.search')?.shortcut)}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchText) {
                    e.stopPropagation();
                    setSearchText('');
                    patch({ search: '' });
                  } else if (e.key === 'Enter') {
                    patch({ search: searchText });
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    listEl.current?.focus();
                  }
                }}
              />
            </div>
            <CmdToggle command="logs.tail" pressed={tailOn} className="btn btn-xs logs-tail-btn">
              <Radio size={12} aria-hidden="true" /> Tail
            </CmdToggle>
            <button
              type="button"
              className="btn btn-xs"
              title="Export log"
              aria-haspopup="menu"
              disabled={!exportView.enabled}
              onClick={(e) => exportMenu(e.currentTarget)}
            >
              <Download size={12} aria-hidden="true" /> Export ▾
            </button>
          </div>
          {srcs.connError && (
            <Banner tone="warn" actions={<button type="button" className="btn btn-xs" onClick={() => setSrcEpoch((e) => e + 1)}>Retry</button>}>
              Could not list the log sources of {connName}: {srcs.connError}. The engine log is still available.
            </Banner>
          )}
          {info?.id === 'monitor' && providerId === 'redis' && (
            <Banner
              tone="warn"
              actions={autoStopped ? <button type="button" className="btn btn-xs" onClick={extendTail}>Extend 10 min</button> : undefined}
            >
              MONITOR costs ~50 % throughput on busy servers. It stops automatically after 10 minutes{autoStopped ? ' — it was stopped.' : '.'}
            </Banner>
          )}
          {hint && (
            <Banner
              tone="info"
              actions={hint.needs ? (
                parseConfigSet(hint.needs) && providerId === 'redis' && !readOnly
                  ? <button type="button" className="btn btn-xs" onClick={() => void applyConfigHint()}>Run {hint.needs}</button>
                  : (
                    <>
                      {parseProfilingHint(info?.id, hint.needs) && providerId === 'mongodb' && !readOnly && (
                        <button type="button" className="btn btn-xs" onClick={() => void applyProfilingHint()}>Turn on profiling</button>
                      )}
                      <CommandButton command="logs.copyGrant" label="Copy" variant="btn" className="btn-xs" />
                    </>
                  )
              ) : undefined}
            >
              {hint.reason}
              {hint.needs && <code className="logs-hint-code">{hint.needs}</code>}
            </Banner>
          )}
          {tail.status === 'ended' && !autoStopped && tailOn && (
            <Banner tone="warn" actions={<button type="button" className="btn btn-xs" onClick={() => setTailEpoch((e) => e + 1)}>Restart tail</button>}>
              The tail ended{tail.reason ? `: ${tail.reason}` : ''}.
            </Banner>
          )}
          {tail.status === 'error' && tailOn && (
            <InlineError compact title="Tail failed" message={tail.reason ?? 'Unknown error'} onRetry={() => setTailEpoch((e) => e + 1)} />
          )}
          {load.truncated && load.key === loadKey && (
            <Banner tone="info">The server keeps only a capped window of this log; older lines are not available.</Banner>
          )}
          <div className="logs-body">{logsBody()}</div>
          <div className="logs-status">
            <span role="status" aria-live="polite" aria-atomic="true" className={tail.status === 'open' ? 'logs-live' : undefined}>
              {tail.status === 'open' && <span className="logs-live-dot" aria-hidden="true" />}
              {statusText}
            </span>
            <span className="flex-1" />
            {load.hasMore && !tailOn && (
              <CommandButton command="logs.loadOlder" label={load.loadingOlder ? 'Loading…' : 'Load older'} variant="ghost" className="btn-xs" />
            )}
            <CmdToggle command="logs.clear" className="btn btn-xs btn-ghost" shortcut={LOCAL_KEYS.clear}>Clear</CmdToggle>
            <CmdToggle command="logs.pause" pressed={tail.status === 'paused'} className="btn btn-xs btn-ghost">
              {tail.status === 'paused' ? 'Resume' : 'Pause'}
            </CmdToggle>
            <CmdToggle command="logs.wrap" pressed={st.wrap} className="btn btn-xs btn-ghost">
              <WrapText size={12} aria-hidden="true" /> Wrap
            </CmdToggle>
          </div>
        </>
      ) : (
        <ActivityView
          cid={cid}
          providerId={providerId}
          connectionName={connName}
          readOnly={readOnly}
          source={srcs.loaded ? merged.activity : null}
          sourcesLoading={!srcs.loaded}
          sourcesError={srcs.connError}
          onRetrySources={() => setSrcEpoch((e) => e + 1)}
          visible={visible}
          onlyActive={st.onlyActive}
          mode={st.activityMode}
          onPatch={patch}
          handleRef={activity}
        />
      )}
    </div>
  );
}

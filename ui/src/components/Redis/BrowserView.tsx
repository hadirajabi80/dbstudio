// Key browser (`redis.browser`, docs/PLAN-M2.md 5.3): DB · pattern · type filters, incremental SCAN ("Scan more",
// at most 100k keys), delimiter tree or flat virtualized list with type / TTL countdown / lazy memory badges, and the
// key detail pane with the typed value editors. Keyboard: Ctrl+F pattern, Enter opens, F2 rename, Delete delete,
// Insert new key, Alt+Left / Alt+Right panes, F5 rescan, Ctrl+S saves the value editor.
import { Database, Lock, Plus, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { RedisKeySummary, RedisKeyType, RedisKeyValue } from '../../api/types';
import type { SourceTarget } from '../../commands/types';
import { CONTEXT_MENUS } from '../../commands/menuModel';
import { formatCount, TYPE_LABEL } from '../../redis/format';
import { hasGlob } from '../../redis/glob';
import { ancestors, buildKeyIndex, flattenKeyTree, type KeyTreeRow } from '../../redis/keyTree';
import { useTabs } from '../../store/tabs';
import { Select } from '../common/Select';
import { showContextMenu } from '../common/Menu';
import { Splitter } from '../common/Splitter';
import { commandMenuItems } from '../layout/commandMenu';
import type { TabViewProps } from '../layout/tabViews';
import { copyKeyName, copyValueJson, deleteKey, deletePattern, isWritable, newKey, onKeysChanged, renameKey, setTtl } from './actions';
import { KeyDetail, valueAsJson, type KeyDetailHandle } from './KeyDetail';
import { KeyList, type KeyListHandle } from './KeyList';
import type { BrowserState } from './open';
import { errorText, loadServer, rememberKeys, useRedis } from './store';
import { useRedisViewEvents } from './viewEvents';
import { copyText } from '../../app/actions';

export const MAX_BROWSER_KEYS = 100_000;
const PAGE_TARGET = 500;
const TYPES: (RedisKeyType | 'all')[] = ['all', 'string', 'hash', 'list', 'set', 'zset', 'stream', 'rejson'];

/** The SCAN MATCH of the pattern box: plain text means "contains". */
export function effectivePattern(text: string): string {
  const t = text.trim();
  if (!t) return '*';
  return hasGlob(t) ? t : `*${t.replace(/[\\]/g, '\\\\')}*`;
}

interface ScanState {
  keys: Map<string, RedisKeySummary>;
  cursor: string;
  scanned: number;
  dbSize: number;
  scanning: boolean;
  error: string | null;
  /** Bumped per (re)start so late responses of an older scan are ignored. */
  gen: number;
}

const EMPTY: ScanState = { keys: new Map(), cursor: '0', scanned: 0, dbSize: 0, scanning: false, error: null, gen: 0 };

export function BrowserView({ tab, theme, visible }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = tab.state as BrowserState;
  const patch = useCallback((p: Partial<BrowserState>) => {
    const cur = useTabs.getState().tabs.find((t) => t.id === tab.id);
    useTabs.getState().updateView(tab.id, { state: { ...(cur?.kind === 'view' ? (cur.state as object) : {}), ...p } });
  }, [tab.id]);
  const server = useRedis((s) => s.conns[cid]?.server);
  useEffect(() => {
    void loadServer(cid);
  }, [cid]);
  const info = server?.data;
  const readOnly = info?.readOnly ?? !isWritable(cid);
  const delimiter = info?.delimiter || ':';
  const cluster = info?.mode === 'cluster';

  const [scan, setScan] = useState<ScanState>(EMPTY);
  const scanRef = useRef(scan);
  useEffect(() => {
    scanRef.current = scan;
  }, [scan]);
  const commit = (s: ScanState) => {
    scanRef.current = s;
    setScan(s);
  };
  const [expiries, setExpiries] = useState<Map<string, number>>(new Map());
  const [sizes, setSizes] = useState<Map<string, number | null>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [listWidth, setListWidth] = useState(420);
  const [patternDraft, setPatternDraft] = useState(st.pattern ?? '');
  const patternRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<KeyListHandle>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const detailHandle = useRef<KeyDetailHandle | null>(null);
  const dragStart = useRef(420);

  useEffect(() => setPatternDraft(st.pattern ?? ''), [st.pattern]);

  // TTL countdown
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible]);

  const pattern = effectivePattern(st.pattern ?? '');
  const type = st.type && st.type !== 'all' ? st.type : null;

  /** Scans until PAGE_TARGET new keys were found or the scan is complete. */
  const scanMore = useCallback(async (restart: boolean) => {
    const prev = scanRef.current;
    if (!restart && (prev.scanning || prev.cursor === '0')) return;
    const gen = restart ? prev.gen + 1 : prev.gen;
    let state: ScanState = restart ? { ...EMPTY, gen, scanning: true } : { ...prev, scanning: true, error: null };
    commit(state);
    if (restart) {
      setExpiries(new Map());
      setSizes(new Map());
    }
    let found = 0;
    let cursor = restart ? '0' : prev.cursor;
    try {
      do {
        const r = await api.redis.scan(cid, { db: st.db, pattern, type, cursor, count: info?.scanCount ?? 500 });
        if (scanRef.current.gen !== gen) return;
        const keys = new Map(state.keys);
        const exp = new Map<string, number>();
        const t0 = Date.now();
        for (const k of r.keys) {
          if (!keys.has(k.key)) found++;
          keys.set(k.key, k);
          if (k.ttl >= 0) exp.set(k.key, t0 + k.ttl * 1000);
        }
        setExpiries((m) => {
          const n = new Map(m);
          for (const [k, v] of exp) n.set(k, v);
          return n;
        });
        cursor = r.cursor;
        state = { ...state, keys, cursor, scanned: state.scanned + r.scanned, dbSize: r.dbSize };
        commit(state);
        rememberKeys(cid, st.db, r.keys, pattern === '*' && !type ? r.dbSize : undefined);
      } while (cursor !== '0' && found < PAGE_TARGET && state.keys.size < MAX_BROWSER_KEYS);
      commit({ ...state, scanning: false });
    } catch (e) {
      if (scanRef.current.gen === gen) commit({ ...state, scanning: false, error: errorText(e) });
    }
  }, [cid, st.db, pattern, type, info?.scanCount]);

  useEffect(() => {
    if (!info) return;
    void scanMore(true);
    // restart whenever the filters change
  }, [info === undefined, st.db, pattern, type]); // eslint-disable-line react-hooks/exhaustive-deps

  // keys changed elsewhere (dialogs, explorer, other tabs)
  useEffect(() => onKeysChanged((c) => {
    if (c.cid !== cid || c.db !== st.db) return;
    if (c.kind === 'removed' || c.kind === 'renamed') {
      setScan((s) => {
        const keys = new Map(s.keys);
        const gone = c.kind === 'removed' ? c.keys : [c.from];
        const moved = c.kind === 'renamed' ? keys.get(c.from) : undefined;
        for (const k of gone) keys.delete(k);
        if (c.kind === 'renamed' && moved) keys.set(c.to, { ...moved, key: c.to });
        return { ...s, keys, dbSize: Math.max(0, s.dbSize - (c.kind === 'removed' ? c.keys.length : 0)) };
      });
      const curTab = useTabs.getState().tabs.find((t) => t.id === tab.id);
      const selected = curTab?.kind === 'view' ? (curTab.state as BrowserState | undefined)?.selected : undefined;
      if (c.kind === 'renamed' && selected === c.from) patch({ selected: c.to });
      if (c.kind === 'removed' && selected && c.keys.includes(selected)) patch({ selected: null });
    } else if (c.kind === 'added') {
      void api.redis.scan(cid, { db: st.db, pattern: c.key.replace(/[*?[\]\\]/g, (m) => `\\${m}`), cursor: '0', count: 10 }).then((r) => {
        setScan((s) => {
          const keys = new Map(s.keys);
          for (const k of r.keys) keys.set(k.key, k);
          return { ...s, keys, dbSize: s.dbSize + 1 };
        });
        for (const a of ancestors(c.key, delimiter)) setExpanded((e) => new Set(e).add(a));
        patch({ selected: c.key });
      }, () => {});
    } else if (c.kind === 'ttl') {
      setScan((s) => {
        const cur = s.keys.get(c.key);
        if (!cur) return s;
        const keys = new Map(s.keys);
        keys.set(c.key, { ...cur, ttl: c.ttl });
        return { ...s, keys };
      });
      setExpiries((m) => {
        const n = new Map(m);
        if (c.ttl >= 0) n.set(c.key, Date.now() + c.ttl * 1000);
        else n.delete(c.key);
        return n;
      });
      detailHandle.current?.reload();
    } else void scanMore(true);
  }), [cid, st.db, delimiter, scanMore, patch, tab.id]);

  // lazy memory badges for the visible rows (≤ 100 keys per request)
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const memTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onVisibleKeys = useCallback((keys: string[]) => {
    if (memTimer.current) clearTimeout(memTimer.current);
    memTimer.current = setTimeout(() => {
      const missing = keys.filter((k) => !sizesRef.current.has(k)).slice(0, 100);
      if (!missing.length) return;
      api.redis.memory(cid, { db: st.db, keys: missing }).then((r) => setSizes((m) => {
        const n = new Map(m);
        for (const [k, v] of Object.entries(r.sizes)) n.set(k, v);
        return n;
      }), () => {});
    }, 150);
  }, [cid, st.db]);
  useEffect(() => () => {
    if (memTimer.current) clearTimeout(memTimer.current);
  }, []);

  const entries = useMemo(() => [...scan.keys.values()], [scan.keys]);
  const index = useMemo(() => (st.tree ? buildKeyIndex(entries, delimiter) : null), [entries, delimiter, st.tree]);
  const rows: KeyTreeRow[] = useMemo(() => {
    if (index) return flattenKeyTree(index, expanded);
    return [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((e) => ({ kind: 'key' as const, id: `k:${e.key}`, label: e.key, depth: 0, entry: e }));
  }, [index, entries, expanded]);

  // reveal a key selected from outside (explorer, palette)
  useEffect(() => {
    if (!st.selected || !st.tree) return;
    const need = ancestors(st.selected, delimiter).filter((a) => !expanded.has(a));
    if (need.length && scan.keys.has(st.selected)) setExpanded((e) => new Set([...e, ...need]));
  }, [st.selected, st.tree, delimiter, scan.keys]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((prefix: string, open?: boolean) => {
    setExpanded((e) => {
      const n = new Set(e);
      const want = open ?? !n.has(prefix);
      if (want) n.add(prefix);
      else n.delete(prefix);
      return n;
    });
  }, []);

  const selected = st.selected ?? null;
  const target = (key: string): SourceTarget => ({ kind: 'source', connectionId: cid, providerId: 'redis', nodeType: 'key', path: [String(st.db), key], meta: { db: st.db, key } });

  // command events of this tab (redis.* commands with scope `redis` / `redisKeys`)
  useRedisViewEvents(tab.id, (action) => {
    switch (action) {
      case 'focusPattern': patternRef.current?.focus(); patternRef.current?.select(); break;
      case 'focusKeys': listRef.current?.focus(); break;
      case 'focusValue': detailRef.current?.querySelector<HTMLElement>('textarea, [data-primary-focus], .redis-cell.editable, input, button')?.focus(); break;
      case 'refresh': void loadServer(cid, true); void scanMore(true); break;
      case 'newKey': if (!readOnly) newKey(cid, st.db); break;
      case 'renameKey': if (selected && !readOnly) renameKey(cid, st.db, selected); break;
      case 'deleteKey': if (selected && !readOnly) void deleteKey(cid, st.db, selected); break;
      case 'setTtl': if (selected && !readOnly) void setTtl(cid, st.db, selected); break;
      case 'copyKey': if (selected) void copyKeyName(selected); break;
      case 'copyValueJson': if (selected) void copyValueJson(cid, st.db, selected); break;
      case 'deletePattern': if (!readOnly) deletePattern(cid, st.db, pattern); break;
      case 'save': void detailHandle.current?.save(); break;
      case 'scanMore': void scanMore(false); break;
    }
  });

  const dbOptions = useMemo(() => {
    const n = info?.databases ?? 16;
    const counts = new Map(info?.keyspace.map((k) => [k.db, k.keys]) ?? []);
    return Array.from({ length: n }, (_, i) => ({ value: i, label: `db${i}`, hint: counts.has(i) ? formatCount(counts.get(i)) : undefined }));
  }, [info]);

  const onLoaded = useCallback((v: RedisKeyValue) => {
    setScan((s) => {
      const cur = s.keys.get(v.key);
      if (!cur || (cur.ttl === v.ttl && cur.type === v.type)) return s;
      const keys = new Map(s.keys);
      keys.set(v.key, { ...cur, ttl: v.ttl, type: v.type });
      return { ...s, keys };
    });
    setSizes((m) => new Map(m).set(v.key, v.memory));
    if (v.ttl >= 0) setExpiries((m) => new Map(m).set(v.key, Date.now() + v.ttl * 1000));
  }, []);
  const onMissing = useCallback((key: string) => {
    setScan((s) => {
      if (!s.keys.has(key)) return s;
      const keys = new Map(s.keys);
      keys.delete(key);
      return { ...s, keys };
    });
  }, []);

  if (server?.error && !info) {
    return (
      <div className="redis-view redis-error-view" role="alert">
        <Database size={28} />
        <h3>Could not connect</h3>
        <p className="muted">{server.error}</p>
        <button className="btn" onClick={() => void loadServer(cid, true)}>Retry</button>
      </div>
    );
  }

  const capReached = scan.keys.size >= MAX_BROWSER_KEYS;
  return (
    <div className="redis-view redis-browser" data-command-scope="redis" onKeyDown={(e) => {
      // F5 rescans and Ctrl+S saves the value editor (handled here: the global F5 / Ctrl+S belong to consoles)
      if (e.key === 'F5' && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); void loadServer(cid, true); void scanMore(true); }
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); void detailHandle.current?.save(); }
    }}>
      <div className="redis-toolbar" role="toolbar" aria-label="Key browser">
        {!cluster && (
          <Select size="sm" aria-label="Database" value={st.db} onChange={(v) => patch({ db: Number(v), selected: null })} options={dbOptions} mono />
        )}
        <div className="search-box redis-pattern">
          <Search size={14} aria-hidden />
          <input ref={patternRef} type="search" aria-label="Key pattern" placeholder="Filter by key name or pattern (user:*)" value={patternDraft}
            onChange={(e) => setPatternDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') patch({ pattern: patternDraft.trim(), selected: null });
              else if (e.key === 'Escape' && patternDraft) {
                e.stopPropagation();
                setPatternDraft('');
                patch({ pattern: '' });
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.focus();
              }
            }} />
        </div>
        <Select size="sm" aria-label="Key type" value={st.type ?? 'all'} onChange={(v) => patch({ type: v as BrowserState['type'] })}
          options={TYPES.map((t) => ({ value: t, label: t === 'all' ? 'All types' : TYPE_LABEL[t] }))} />
        <button className="icon-btn" aria-label="Rescan" title="Rescan (F5)" onClick={() => void scanMore(true)}><RefreshCw size={15} className={scan.scanning ? 'spin' : ''} /></button>
        <div className="segmented" role="group" aria-label="Key list mode">
          <button className={st.tree ? 'on' : ''} aria-pressed={st.tree} onClick={() => patch({ tree: true })} title="Group keys by delimiter">Tree</button>
          <button className={!st.tree ? 'on' : ''} aria-pressed={!st.tree} onClick={() => patch({ tree: false })} title="Flat list">List</button>
        </div>
        <button className="btn btn-xs btn-primary" disabled={readOnly} onClick={() => newKey(cid, st.db)} title={readOnly ? 'Read-only connection' : 'New key (Insert in the key list)'}><Plus size={13} /> Key</button>
        <span className="flex-1" />
        {readOnly && <span className="pill pill-muted" title="Writes are refused on this connection"><Lock size={11} /> read-only</span>}
        <span className="muted tabular redis-scan-status" role="status" aria-live="polite">
          {formatCount(scan.keys.size)} key{scan.keys.size === 1 ? '' : 's'}
          {scan.cursor !== '0' || scan.scanning ? <> · scanned {formatCount(scan.scanned)} of ~{formatCount(scan.dbSize)}</> : scan.dbSize ? <> · {formatCount(scan.dbSize)} in db{st.db}</> : null}
        </span>
        {scan.cursor !== '0' && !capReached && (
          <button className="btn btn-xs" disabled={scan.scanning} onClick={() => void scanMore(false)}>Scan more</button>
        )}
      </div>
      {capReached && <div className="message sev-warning redis-banner" role="status">The browser stops at {formatCount(MAX_BROWSER_KEYS)} keys: refine the pattern to see the others.</div>}
      {scan.error && <div className="message sev-error redis-banner" role="alert">{scan.error}</div>}
      <div className="redis-split">
        <div className="redis-keys-pane" style={{ width: listWidth }}>
          <div className="redis-list-head" aria-hidden>
            <span>{st.tree ? 'Key' : 'Key'}</span><span className="redis-ttl">TTL</span><span className="redis-size">Size</span>
          </div>
          <KeyList ref={listRef} rows={rows} selected={selected} expiries={expiries} sizes={sizes} now={now} tree={!!st.tree}
            onSelect={(k) => patch({ selected: k })} onToggle={toggle} onVisibleKeys={onVisibleKeys}
            onContextMenu={(k, x, y) => showContextMenu({ clientX: x, clientY: y }, commandMenuItems(CONTEXT_MENUS['explorer.redis.key'], target(k)))}
            empty={scan.scanning ? 'Scanning…' : pattern !== '*' || type ? 'No key matches the filters (yet): Scan more continues the scan.' : 'The database is empty.'} />
        </div>
        <Splitter direction="vertical" ariaLabel="Resize key list" onDragStart={() => { dragStart.current = listWidth; }}
          onDrag={(d) => setListWidth(Math.max(240, Math.min(900, dragStart.current + d)))} />
        <div className="redis-detail-pane" ref={detailRef}>
          {selected ? (
            <KeyDetail key={`${st.db}:${selected}`} cid={cid} db={st.db} keyName={selected} readOnly={readOnly} theme={theme} now={now}
              onMissing={onMissing} onLoaded={onLoaded}
              onRename={() => renameKey(cid, st.db, selected)} onTtl={(t) => void setTtl(cid, st.db, selected, t)} onDelete={() => void deleteKey(cid, st.db, selected)}
              onCopyKey={() => void copyKeyName(selected)} onCopyJson={(v) => void copyText(valueAsJson(v), 'Value copied as JSON')}
              handle={(h) => { detailHandle.current = h; }} />
          ) : (
            <div className="redis-empty-detail muted">
              <p>Select a key to see its value.</p>
              <p className="redis-hints"><kbd>Ctrl</kbd>+<kbd>F</kbd> pattern · <kbd>↑</kbd><kbd>↓</kbd> keys · <kbd>Enter</kbd> open · <kbd>F2</kbd> rename · <kbd>Del</kbd> delete · <kbd>Ins</kbd> new key · <kbd>Alt</kbd>+<kbd>←</kbd><kbd>→</kbd> panes</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Find in database (Ctrl+Shift+F): a search box with case / whole word / regex toggles, a scope picker, "search in"
// options (names, columns, code, opt-in table data), and the results grouped connection › schema › object › match,
// streamed in while the engine searches. Enter searches, arrows walk the results, Enter opens one, Esc cancels.
import {
  CaseSensitive, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleStop, Columns3, Globe, Info, KeyRound, LoaderCircle, Regex,
  Rows3, Search, SearchX, TriangleAlert, WholeWord, X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import type { CatalogObjectType } from '../../api/types';
import type { SearchHitItem } from '../../api/types.search';
import { displayShortcut } from '../../commands/keys';
import { getCommand } from '../../commands/registry';
import { formatCount } from '../../lib/format';
import { OBJECT_TYPE_SINGULAR } from '../../lib/sql';
import { useCatalog } from '../../store/catalog';
import { hasDatabaseLevel, useConnections } from '../../store/connections';
import { connectionActivity, useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { DatabaseIcon, ObjectIcon } from '../common/icons';
import { showContextMenu, type MenuItem } from '../common/Menu';
import { contextMenu } from '../layout/commandMenu';
import type { TabViewProps } from '../layout/tabViews';
import {
  buildRequest, dataAllowed, flattenGroups, groupHits, keyLabel, MAX_ROW_LIMIT, sameScope, scopeLabel, segments, totals, TYPE_CHIPS, type ResultRow,
  type SearchScope, type SearchTabState, type TypeChip,
} from './model';
import { isRelationalConnection, openHit, openObjectOf, revealObject, targetOfObject } from './open';
import { ScopePicker } from './ScopePicker';
import { useSearchRun, useSearchRuns } from './searchStore';
import './search.css';

const ROW_H = 26;
const OVERSCAN = 8;

const ROUTINES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc', 'package', 'trigger']);

function menuIdOf(t: CatalogObjectType): string {
  if (t === 'table') return 'explorer.table';
  if (t === 'view' || t === 'mview') return 'explorer.view';
  if (ROUTINES.has(t)) return 'explorer.routine';
  return 'explorer.object';
}

function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setH(el.clientHeight || 480);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

function Marked({ text, ranges }: { text: string; ranges: SearchHitItem['ranges'] | null | undefined }) {
  return (
    <>
      {segments(text, ranges).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  );
}

function elapsed(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function SearchView({ tab, visible }: TabViewProps) {
  const state = tab.state as SearchTabState;
  const update = useCallback((p: Partial<SearchTabState>) => {
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tab.id);
    if (cur?.kind === 'view') tabs.updateView(tab.id, { state: { ...(cur.state as SearchTabState), ...p } });
  }, [tab.id]);

  const run = useSearchRun(tab.id);
  const connections = useConnections((s) => s.connections);
  const sessions = useSessions((s) => s.sessions);
  const catalogConns = useCatalog((s) => s.conns);
  const relational = useMemo(() => connections.filter((c) => isRelationalConnection(c.id)), [connections]);
  const connected = useMemo(
    () => new Set(relational.filter((c) => connectionActivity(c.id, sessions, (id) => catalogConns[id]?.status)).map((c) => c.id)),
    [relational, sessions, catalogConns],
  );
  const nameOf = useCallback((cid: string) => connections.find((c) => c.id === cid)?.name ?? cid, [connections]);
  const showDatabase = useCallback((cid: string) => hasDatabaseLevel(connections.find((c) => c.id === cid)?.providerId), [connections]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const height = useHeight(listRef);

  // Ctrl+Shift+F again: focus the search box with its text selected.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [state.nonce, visible]);

  const groups = useMemo(() => groupHits(run.hits, run.errors, { nameOf, showDatabase }), [run.hits, run.errors, nameOf, showDatabase]);
  const rows = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);
  const sum = useMemo(() => totals(groups), [groups]);
  const activeIndex = active ? rows.findIndex((r) => r.key === active) : -1;

  const start = () => {
    setPickerOpen(false);
    const req = buildRequest(state.scope, state, [...connected]);
    if ('error' in req) {
      setHint(req.error);
      return;
    }
    setHint(null);
    setCollapsed(new Set());
    setActive(null);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    void useSearchRuns.getState().start(tab.id, req);
  };
  const cancel = () => void useSearchRuns.getState().cancel(tab.id);
  const running = run.status === 'running';

  const pickScope = (scope: SearchScope, close: boolean) => {
    update({ scope, ...(dataAllowed(scope) ? {} : { data: false }) });
    if (close) {
      setPickerOpen(false);
      inputRef.current?.focus();
    }
  };

  // ------------------------------------------------------------------ results keyboard / mouse

  const toggleRow = (key: string, open?: boolean) => setCollapsed((s) => {
    const n = new Set(s);
    const isOpen = !n.has(key);
    if (open ?? !isOpen) n.delete(key);
    else n.add(key);
    return n;
  });

  const openRow = (r: ResultRow) => {
    if (r.kind === 'hit') openHit(r.hit, { matchCase: run.request?.matchCase ?? state.matchCase });
    else if (r.kind === 'object') openObjectOf(r.group);
    else if (r.kind === 'conn' || r.kind === 'schema') toggleRow(r.key);
  };

  const scrollToIndex = (i: number) => {
    const el = listRef.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  const moveTo = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    setActive(r.key);
    scrollToIndex(rows.indexOf(r));
  };

  const rowMenu = (r: ResultRow, pos: { clientX: number; clientY: number; preventDefault?: () => void }) => {
    let items: MenuItem[] = [];
    const object = r.kind === 'object' ? r.group : r.kind === 'hit' ? r.object : null;
    if (r.kind === 'hit') items.push({ label: 'Open match', onClick: () => openRow(r) }, { separator: true });
    if (object) {
      items.push(...contextMenu(menuIdOf(object.type), targetOfObject(object)));
      items.push({ separator: true }, { label: 'Reveal in explorer', onClick: () => revealObject(object) });
    }
    if (r.kind === 'hit' && r.hit.text) items.push({ label: 'Copy matched text', onClick: () => void navigator.clipboard?.writeText(r.hit.text).catch(() => undefined) });
    items = items.filter((it, i, all) => !(it.separator && (i === 0 || all[i - 1]?.separator)));
    if (items.length) showContextMenu(pos, items);
    else pos.preventDefault?.();
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    const i = activeIndex;
    const r = rows[i];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveTo(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (i <= 0) inputRef.current?.focus();
        else moveTo(i - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveTo(rows.length - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        moveTo(i + Math.max(1, Math.floor(height / ROW_H) - 1));
        break;
      case 'PageUp':
        e.preventDefault();
        moveTo(i - Math.max(1, Math.floor(height / ROW_H) - 1));
        break;
      case 'ArrowRight':
        if (!r) break;
        e.preventDefault();
        if ((r.kind === 'conn' || r.kind === 'schema' || (r.kind === 'object' && r.expandable)) && !r.expanded) toggleRow(r.key, true);
        else if (rows[i + 1] && rows[i + 1].depth > r.depth) moveTo(i + 1);
        break;
      case 'ArrowLeft':
        if (!r) break;
        e.preventDefault();
        if ((r.kind === 'conn' || r.kind === 'schema' || r.kind === 'object') && r.expanded) toggleRow(r.key, false);
        else if ('parent' in r) moveTo(rows.findIndex((x) => x.key === r.parent));
        break;
      case 'Enter':
        if (!r) break;
        e.preventDefault();
        openRow(r);
        break;
      case 'Escape':
        e.preventDefault();
        if (running) cancel();
        else inputRef.current?.focus();
        break;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break;
        if (!r) break;
        e.preventDefault();
        {
          const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(r.key)}"]`);
          const b = el?.getBoundingClientRect();
          rowMenu(r, { clientX: (b?.left ?? 0) + 40, clientY: (b?.bottom ?? 0) - 4 });
        }
        break;
      default:
        break;
    }
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      start();
    } else if (e.key === 'Escape') {
      if (running) {
        e.preventDefault();
        cancel();
      }
    } else if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      listRef.current?.focus();
      if (activeIndex < 0) moveTo(0);
    }
  };

  // ------------------------------------------------------------------ rendering

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const findKey = displayShortcut(getCommand('search.findInDatabase')?.shortcut ?? 'Mod+Shift+F');
  const scopeText = state.scope.kind === 'all' ? `All connected (${connected.size})` : scopeLabel(state.scope, nameOf, showDatabase);
  const consoleConn = state.consoleConnectionId && connections.find((c) => c.id === state.consoleConnectionId);
  const offerConsole = !!consoleConn && !sameScope(state.scope, { kind: 'connection', connectionId: consoleConn.id });
  const canData = dataAllowed(state.scope);
  const progress = Object.values(run.progress);
  const toggles: { key: 'matchCase' | 'wholeWord' | 'regex'; label: string; Icon: typeof Regex }[] = [
    { key: 'matchCase', label: 'Match case', Icon: CaseSensitive },
    { key: 'wholeWord', label: 'Whole word', Icon: WholeWord },
    { key: 'regex', label: 'Regular expression', Icon: Regex },
  ];
  const searchIn: { key: 'names' | 'columns' | 'code'; label: string }[] = [
    { key: 'names', label: 'Object names' },
    { key: 'columns', label: 'Columns' },
    { key: 'code', label: 'Code' },
  ];

  return (
    <div className="sx-view" style={{ display: visible ? undefined : 'none' }} data-command-scope="search">
      <div className="sx-head">
        <div className="sx-query">
          <div className="sx-box">
            <Search size={16} className="sx-box-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              data-primary-focus
              className="sx-input"
              value={state.term}
              placeholder="Find in database: names, columns, code…"
              aria-label="Search for"
              spellCheck={false}
              onChange={(e) => update({ term: e.target.value })}
              onKeyDown={onInputKeyDown}
            />
            {state.term && (
              <button type="button" className="icon-btn xs" title="Clear" aria-label="Clear the search box" onClick={() => { update({ term: '' }); inputRef.current?.focus(); }}>
                <X size={13} />
              </button>
            )}
            <span className="sx-box-sep" />
            {toggles.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                className={`sx-toggle${state[key] ? ' on' : ''}`}
                aria-pressed={state[key]}
                title={label}
                aria-label={label}
                onClick={() => update({ [key]: !state[key] } as Partial<SearchTabState>)}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          {running ? (
            <button type="button" className="btn sx-go" onClick={cancel} title="Cancel the search (Esc)">
              <CircleStop size={14} /> Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-primary sx-go" onClick={start} title="Search (Enter)">
              <Search size={14} /> Search
            </button>
          )}
        </div>

        <div className="sx-options">
          <div className="sx-opt-group sx-scope-wrap">
            <span className="sx-opt-label">In</span>
            <button
              type="button"
              className={`sx-scope${pickerOpen ? ' open' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              title="Choose where to search: every connection, a connection, a database, a schema or tables"
              onClick={() => setPickerOpen((v) => !v)}
            >
              {state.scope.kind === 'all' ? <Globe size={14} aria-hidden="true" /> : (
                <ProviderLogo providerId={connections.find((c) => c.id === (state.scope as { connectionId: string }).connectionId)?.providerId ?? ''} size={14} />
              )}
              <span className="sx-scope-label">{scopeText}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            {state.scope.kind !== 'all' && (
              <button type="button" className="sx-chip" onClick={() => pickScope({ kind: 'all' }, true)} title="Search every connected connection">
                All connections
              </button>
            )}
            {offerConsole && consoleConn && (
              <button type="button" className="sx-chip" onClick={() => pickScope({ kind: 'connection', connectionId: consoleConn.id }, true)} title="Search only the connection of the active console">
                Only {consoleConn.name}
              </button>
            )}
            {pickerOpen && (
              <>
                <div className="sx-picker-backdrop" onMouseDown={() => setPickerOpen(false)} />
                <ScopePicker scope={state.scope} connections={relational} connected={connected} onPick={pickScope} onClose={() => { setPickerOpen(false); inputRef.current?.focus(); }} />
              </>
            )}
          </div>

          <div className="sx-opt-group" role="group" aria-label="Object types">
            <span className="sx-opt-label">Types</span>
            <button type="button" className={`sx-type${state.types.length === 0 ? ' on' : ''}`} aria-pressed={state.types.length === 0} onClick={() => update({ types: [] })}>All</button>
            {TYPE_CHIPS.map((c) => {
              const on = state.types.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`sx-type${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => update({ types: on ? state.types.filter((x) => x !== c.id) : [...state.types, c.id] as TypeChip[] })}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sx-options">
          <div className="sx-opt-group" role="group" aria-label="Search in">
            <span className="sx-opt-label">Search in</span>
            {searchIn.map((o) => (
              <label key={o.key} className="check sx-check">
                <input type="checkbox" checked={state[o.key]} onChange={(e) => update({ [o.key]: e.target.checked } as Partial<SearchTabState>)} />
                {o.label}
              </label>
            ))}
            <label className={`check sx-check${canData ? '' : ' disabled'}`} title={canData ? 'Reads the text columns of every table in the scope' : 'Choose a schema or tables to search their data'}>
              <input type="checkbox" checked={state.data && canData} disabled={!canData} onChange={(e) => update({ data: e.target.checked })} />
              Table data
            </label>
            {canData && state.data && (
              <span className="sx-data-note">
                <TriangleAlert size={13} aria-hidden="true" />
                Slower: up to
                <input
                  type="number"
                  className="input xs sx-rows"
                  min={1}
                  max={MAX_ROW_LIMIT}
                  value={state.rowLimit}
                  aria-label="Rows per table"
                  onChange={(e) => update({ rowLimit: Math.max(1, Math.min(MAX_ROW_LIMIT, Number(e.target.value) || 1)) })}
                />
                rows per table
              </span>
            )}
            {!canData && <span className="sx-muted">Data: choose a schema or tables</span>}
          </div>
        </div>
      </div>

      <div className="sx-status" role="status" aria-live="polite">
        {running ? (
          <>
            <LoaderCircle size={14} className="spin sx-status-icon" aria-hidden="true" />
            <span className="sx-status-text">
              Searching
              {progress.length ? ` ${progress.slice(0, 2).map((p) => [nameOf(p.connectionId), p.database && showDatabase(p.connectionId) ? p.database : null, p.schema].filter(Boolean).join(' › ') + ` · ${p.phase}${p.table ? ` ${p.table}` : ''}${p.phase === 'data' && p.total ? ` (${p.done}/${p.total})` : ''}`).join(', ')}` : '…'}
            </span>
            <span className="sx-status-count">{formatCount(sum.matches)} so far</span>
          </>
        ) : run.status === 'error' ? (
          <>
            <TriangleAlert size={14} className="sx-status-icon sx-danger" aria-hidden="true" />
            <span className="sx-status-text sx-danger">{run.error}</span>
          </>
        ) : run.status === 'done' || run.status === 'cancelled' ? (
          <span className="sx-status-text">
            {sum.matches === 0 ? 'No matches' : `${formatCount(sum.matches)} match${sum.matches === 1 ? '' : 'es'} in ${formatCount(sum.objects)} object${sum.objects === 1 ? '' : 's'}`}
            {sum.connections > 1 ? ` · ${sum.connections} connections` : ''}
            {run.elapsedMs !== null ? ` · ${elapsed(run.elapsedMs)}` : ''}
            {run.status === 'cancelled' && ' · cancelled'}
            {run.truncated && <span className="sx-warn"> · stopped at {formatCount(run.hits.length)} matches: narrow the search</span>}
          </span>
        ) : (
          <span className="sx-status-text sx-muted">{hint ?? `Press Enter to search · ${findKey} with a schema selected in the explorer searches only that schema`}</span>
        )}
        {hint && run.status !== 'idle' && <span className="sx-hint">{hint}</span>}
        <span className="flex-1" />
        {rows.length > 0 && (
          <>
            <button type="button" className="icon-btn xs" title="Expand all" aria-label="Expand all" onClick={() => setCollapsed(new Set())}>
              <ChevronsUpDown size={14} />
            </button>
            <button
              type="button"
              className="icon-btn xs"
              title="Collapse all"
              aria-label="Collapse all"
              onClick={() => setCollapsed(new Set(groups.flatMap((c) => c.schemas.flatMap((s) => s.objects.map((o) => o.key)))))}
            >
              <ChevronsDownUp size={14} />
            </button>
          </>
        )}
      </div>
      {running && <div className="sx-progress" aria-hidden="true" />}

      <div
        ref={listRef}
        className="sx-results"
        role="tree"
        aria-label="Search results"
        tabIndex={rows.length ? 0 : -1}
        aria-activedescendant={activeIndex >= 0 ? `sx-row-${activeIndex}` : undefined}
        onKeyDown={onListKeyDown}
        onFocus={() => { if (activeIndex < 0 && rows.length) setActive(rows[0].key); }}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {rows.length === 0 ? (
          <div className="sx-empty">
            {run.status === 'idle' ? (
              <>
                <Search size={28} aria-hidden="true" />
                <div className="sx-empty-title">Search object names, columns, code and data</div>
                <div className="sx-empty-text">
                  Searches every connected connection, or the scope chosen above. Select a connection, database, schema or table in the explorer
                  and press {findKey} to search only there.
                </div>
              </>
            ) : run.status === 'running' ? (
              <LoaderCircle size={22} className="spin" aria-hidden="true" />
            ) : run.status === 'done' || run.status === 'cancelled' ? (
              <>
                <SearchX size={28} aria-hidden="true" />
                <div className="sx-empty-title">Nothing found{run.request ? ` for “${run.request.term}”` : ''}</div>
                <div className="sx-empty-text">Try another scope, turn off Match case / Whole word, or include Code and Table data.</div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="sx-rows-host" style={{ height: rows.length * ROW_H }}>
            {rows.slice(first, last).map((r, j) => {
              const i = first + j;
              return (
                <ResultRowView
                  key={r.key}
                  row={r}
                  index={i}
                  top={i * ROW_H}
                  active={i === activeIndex}
                  nameOf={nameOf}
                  providerOf={(cid) => connections.find((c) => c.id === cid)?.providerId ?? ''}
                  onSelect={() => setActive(r.key)}
                  onOpen={() => openRow(r)}
                  onToggle={() => toggleRow(r.key)}
                  onMenu={(e) => {
                    setActive(r.key);
                    rowMenu(r, e);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  row: ResultRow;
  index: number;
  top: number;
  active: boolean;
  nameOf(cid: string): string;
  providerOf(cid: string): string;
  onSelect(): void;
  onOpen(): void;
  onToggle(): void;
  onMenu(e: ReactMouseEvent): void;
}

function ResultRowView({ row: r, index, top, active, nameOf, providerOf, onSelect, onOpen, onToggle, onMenu }: RowProps) {
  const expandable = r.kind === 'conn' || r.kind === 'schema' || (r.kind === 'object' && r.expandable);
  const expanded = 'expanded' in r && r.expanded;
  const chevron = expandable ? (
    <button type="button" className="sx-chev" tabIndex={-1} aria-label={expanded ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  ) : <span className="sx-chev-gap" />;

  let body: ReactNode;
  let title: string | undefined;
  switch (r.kind) {
    case 'conn':
      body = (
        <>
          <ProviderLogo providerId={providerOf(r.group.connectionId)} size={15} />
          <span className="sx-name strong">{nameOf(r.group.connectionId)}</span>
          {r.group.count > 0 && <span className="sx-count">{formatCount(r.group.count)}</span>}
        </>
      );
      break;
    case 'schema':
      body = (
        <>
          <DatabaseIcon size={15} />
          <span className="sx-name">{r.group.label}</span>
          <span className="sx-count">{formatCount(r.group.count)}</span>
        </>
      );
      break;
    case 'object': {
      const o = r.group;
      title = `${o.schema ? `${o.schema}.` : ''}${o.name} (${OBJECT_TYPE_SINGULAR[o.type] ?? o.type})`;
      body = (
        <>
          <ObjectIcon type={o.type} size={15} />
          <span className="sx-name mono">{o.nameHit ? <Marked text={o.name} ranges={o.nameHit.ranges} /> : o.name}</span>
          <span className="sx-kind">{OBJECT_TYPE_SINGULAR[o.type] ?? o.type}</span>
          {o.nameHit && <span className="sx-badge name">name</span>}
          {o.counts.column > 0 && <span className="sx-badge column">{o.counts.column} column{o.counts.column === 1 ? '' : 's'}</span>}
          {o.counts.code > 0 && <span className="sx-badge code">{o.counts.code} in code</span>}
          {o.counts.data > 0 && <span className="sx-badge data">{o.counts.data} in data</span>}
        </>
      );
      break;
    }
    case 'hit': {
      const h = r.hit;
      if (h.match === 'column') {
        title = `${h.column} ${h.dataType ?? ''}`.trim();
        body = (
          <>
            <Columns3 size={14} className="sx-hit-icon column" aria-hidden="true" />
            <span className="sx-hit-text mono"><Marked text={h.text} ranges={h.ranges} /></span>
            {h.dataType && <span className="sx-muted mono">{h.dataType}</span>}
          </>
        );
      } else if (h.match === 'code' && !h.line) {
        body = <span className="sx-muted sx-more">+{formatCount(h.more)} more matching line{h.more === 1 ? '' : 's'}: open the object to see them</span>;
      } else if (h.match === 'code') {
        title = h.text;
        body = (
          <>
            <span className="sx-line mono" aria-label={`line ${h.line}`}>{h.line}</span>
            <span className="sx-hit-text mono sx-code"><Marked text={h.text} ranges={h.ranges} /></span>
          </>
        );
      } else {
        title = `${h.column}: ${h.text}`;
        body = (
          <>
            <Rows3 size={14} className="sx-hit-icon data" aria-hidden="true" />
            <span className="sx-col-name mono">{h.column}</span>
            <span className="sx-hit-text mono"><Marked text={h.text} ranges={h.ranges} /></span>
            {h.key?.length ? (
              <span className="sx-muted sx-key mono"><KeyRound size={11} aria-hidden="true" /> {keyLabel(h.key)}</span>
            ) : null}
          </>
        );
      }
      break;
    }
    case 'error':
      title = r.error.message;
      body = (
        <>
          {r.error.notice ? <Info size={14} className="sx-hit-icon sx-info" aria-hidden="true" /> : <TriangleAlert size={14} className="sx-hit-icon sx-danger" aria-hidden="true" />}
          <span className={`sx-hit-text${r.error.notice ? '' : ' sx-danger'}`}>
            {[r.error.database, r.error.schema, r.error.table].filter(Boolean).join(' › ')}
            {(r.error.database || r.error.schema || r.error.table) ? ': ' : ''}
            {r.error.message}
          </span>
        </>
      );
      break;
  }

  return (
    <div
      id={`sx-row-${index}`}
      data-key={r.key}
      role="treeitem"
      aria-level={r.depth + 1}
      aria-selected={active}
      aria-expanded={expandable ? expanded : undefined}
      className={`sx-row sx-${r.kind}${active ? ' active' : ''}`}
      style={{ top, height: ROW_H, paddingLeft: 6 + r.depth * 18 }}
      title={title}
      onMouseDown={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onMenu}
    >
      {chevron}
      {body}
    </div>
  );
}

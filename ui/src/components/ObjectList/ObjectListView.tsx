// Objects tab (WP3, Navicat's object pane done lighter): every object of a schema (or of a whole database) with row
// counts, sizes and dates, a live filter, type groups with counts, a list (sortable, virtualized) and a card grid.
// Enter / double-click opens an object like the explorer does; the context menu is the explorer's.
import {
  ArrowDown, ArrowUp, ChevronDown, Database, FolderOpen, Grid3x3, LayoutGrid, List, LoaderCircle, PencilRuler, Play, Plus, RefreshCw, Search, SearchX,
  Trash2, TriangleAlert, X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { errorMessage } from '../../api/client';
import { objectsApi } from '../../api/objectsClient';
import type { CatalogObjectType, ObjectRef } from '../../api/types';
import type { ObjectListItem } from '../../api/types.objects';
import { activateObject, catalogDatabase } from '../../app/actions';
import type { ContextEntry } from '../../commands/menuModel';
import { hasCommand, runCommand } from '../../commands/registry';
import type { ContainerTarget, ObjectTarget } from '../../commands/types';
import { commandView, useCommandsVersion } from '../../commands/useCommands';
import { isTabular, OBJECT_TYPE_SINGULAR } from '../../lib/sql';
import { dbKey, useCatalog } from '../../store/catalog';
import { useConnection } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { ObjectIcon } from '../common/icons';
import { showContextMenu, showMenuBelow } from '../common/Menu';
import { EmptyState } from '../EmptyState/EmptyState';
import { commandMenuItems, contextMenu } from '../layout/commandMenu';
import type { TabViewProps } from '../layout/tabViews';
import {
  countByGroup, filterObjects, formatModified, formatRowsShort, formatSize, fromCatalog, GROUPS, groupOf, itemKey, nextSort, sortObjects, uniqueObjects,
  type GroupFilter, type SortKey,
} from './model';
import type { ObjectsState } from './open';
import { SavedQueryList } from '../SavedQueries/SavedQueryList';
import { queriesIn, useSavedQueries } from '../../store/savedQueries';
import { QUERIES_GROUP } from './model';
import './objectList.css';

const ROW_H = 32;
const CARD_H = 72;
const CARD_MIN_W = 228;
const CARD_GAP = 10;
// Compact layout: small icon + name tiles, as many per row as fit (Navicat's small-icons view).
const TILE_H = 30;
const TILE_MIN_W = 184;
const TILE_GAP = 4;
const OVERSCAN = 6;

const ROUTINES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc', 'package']);
const DESIGNABLE = new Set<CatalogObjectType>(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'trigger', 'type']);

/** The explorer's context menu of an object of this type. */
function menuIdOf(t: CatalogObjectType): string {
  if (t === 'table') return 'explorer.table';
  if (t === 'view' || t === 'mview') return 'explorer.view';
  if (ROUTINES.has(t) || t === 'trigger') return 'explorer.routine';
  return 'explorer.object';
}

const NEW_ENTRIES: ContextEntry[] = [
  { command: 'designer.newTable', optional: true, hideDisabled: true },
  { command: 'designer.newView', optional: true, hideDisabled: true },
  { command: 'designer.newProcedure', optional: true, hideDisabled: true },
  { command: 'designer.newFunction', optional: true, hideDisabled: true },
  { command: 'designer.newPackage', optional: true, hideDisabled: true },
  { command: 'designer.newTrigger', optional: true, hideDisabled: true },
  'separator',
  { command: 'queries.new', optional: true, hideDisabled: true },
];

/** Tracks the size of an element (the virtualized list and grid render only what is visible). */
function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 800, height: 480 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth || s.width, height: el.clientHeight || s.height }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

interface Column {
  key: SortKey;
  label: string;
  width: string;
  numeric?: boolean;
  render(it: ObjectListItem): ReactNode;
}

/** A per-scope Objects tab ("Objects: Shop.dbo"). */
export function ObjectListView({ tab, visible }: TabViewProps) {
  const state = tab.state as ObjectsState;
  const patch = useCallback((p: Partial<ObjectsState>) => {
    const cur = useTabs.getState().tabs.find((t) => t.id === tab.id);
    if (cur?.kind === 'view') useTabs.getState().updateView(tab.id, { state: { ...(cur.state as ObjectsState), ...p } });
  }, [tab.id]);
  return <ObjectList state={state} patch={patch} visible={visible} />;
}

export interface ObjectListProps {
  state: ObjectsState;
  /** Changes of the type filter, layout and sort. */
  patch(p: Partial<ObjectsState>): void;
  visible: boolean;
  /** An object to select and scroll to once the list has it (the explorer's selection, in the Objects tab). */
  highlight?: Pick<ObjectListItem, 'schema' | 'name' | 'type'> | null;
  /** Shown before the toolbar (the Objects tab's breadcrumb). */
  header?: ReactNode;
}

/** The object list of one connection / database / schema: toolbar, type groups, virtualized list or cards, status. */
export function ObjectList({ state, patch, visible, highlight, header }: ObjectListProps) {
  useCommandsVersion(); // enablement of the toolbar commands (registry changes only; this view does not follow executions)
  const { connectionId: cid, database, schema } = state;
  const conn = useConnection(cid);
  const catDb = useCatalog(() => catalogDatabase(cid, database));
  const loaded = useCatalog((s) => s.dbs[dbKey(cid, catDb)]?.loaded);
  // A DDL change reloads the schema's catalog; the list follows.
  const catVersion = schema ? loaded?.[schema]?.version ?? 0 : Object.values(loaded ?? {}).reduce((n, s) => n + s.version, 0);
  const [items, setItems] = useState<ObjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useSize(bodyRef);
  const [scrollTop, setScrollTop] = useState(0);
  // Saved queries of the scope (the Queries group, components/SavedQueries).
  const queryCount = useSavedQueries((s) => queriesIn(s.byConn[cid]?.items, catDb, schema).length);
  useEffect(() => {
    void useSavedQueries.getState().ensure(cid);
  }, [cid]);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    objectsApi.list(cid, database, schema, null, ctl.signal)
      .then((list) => {
        setItems(uniqueObjects(list));
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [cid, database, schema, reload, catVersion]);

  const fallback = useMemo(() => fromCatalog(Object.values(loaded ?? {}), schema), [loaded, schema]);
  const source = items ?? (error && fallback.length ? fallback : null);
  const counts = useMemo(() => countByGroup(source ?? []), [source]);
  const group: GroupFilter = state.group ?? 'all';
  const shown = useMemo(() => sortObjects(filterObjects(source ?? [], group, query), state.sort), [source, group, query, state.sort]);
  const layout = state.layout ?? 'list';
  const multiSchema = schema === null;

  const refOf = useCallback((it: ObjectListItem): ObjectRef => ({ database, schema: it.schema, name: it.name, type: it.type }), [database]);
  const targetOf = useCallback((it: ObjectListItem): ObjectTarget => ({ kind: 'object', connectionId: cid, database, ref: refOf(it) }), [cid, database, refOf]);
  const groupType = group === 'all' ? undefined : GROUPS.find((g) => g.id === group)?.types[0];
  const container: ContainerTarget = { kind: 'container', connectionId: cid, database, schema, objectType: groupType };

  const selectedIndex = selected ? shown.findIndex((it) => itemKey(it) === selected) : -1;
  const current = selectedIndex >= 0 ? shown[selectedIndex] : null;
  const target = current ? targetOf(current) : null;

  const open = useCallback((it: ObjectListItem) => {
    const t = targetOf(it);
    if (isTabular(it.type) && hasCommand('data.open') && runCommand('data.open', t)) return;
    activateObject(cid, database, t.ref);
  }, [cid, database, targetOf]);

  // ---------------------------------------------------------------- layout math (virtualization)
  const tiled = layout !== 'list';
  const pad = layout === 'grid' ? 14 : layout === 'compact' ? 10 : 0;
  const gap = layout === 'grid' ? CARD_GAP : TILE_GAP;
  const minW = layout === 'grid' ? CARD_MIN_W : TILE_MIN_W;
  const cols = tiled ? Math.max(1, Math.floor((size.width - 2 * pad + gap) / (minW + gap))) : 1;
  const lineH = layout === 'grid' ? CARD_H + CARD_GAP : layout === 'compact' ? TILE_H + TILE_GAP : ROW_H;
  const lines = Math.ceil(shown.length / cols);
  const first = Math.max(0, Math.floor(scrollTop / lineH) - OVERSCAN);
  const last = Math.min(lines, Math.ceil((scrollTop + size.height) / lineH) + OVERSCAN);

  const reveal = (index: number) => {
    const el = bodyRef.current;
    if (!el || index < 0) return;
    const top = Math.floor(index / cols) * lineH + pad;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + lineH > el.scrollTop + el.clientHeight) el.scrollTop = top + lineH - el.clientHeight;
  };

  const move = (index: number) => {
    if (!shown.length) return;
    const i = Math.max(0, Math.min(shown.length - 1, index));
    setSelected(itemKey(shown[i]));
    reveal(i);
  };

  // The highlighted object (explorer selection): selected and scrolled to once, when the list has it.
  const highlightKey = highlight ? itemKey(highlight) : null;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightKey) {
      revealed.current = null;
      return;
    }
    if (revealed.current === highlightKey) return;
    const i = shown.findIndex((it) => itemKey(it) === highlightKey);
    if (i < 0) return;
    revealed.current = highlightKey;
    setSelected(highlightKey);
    const el = bodyRef.current;
    if (el) {
      const top = Math.floor(i / cols) * lineH;
      if (top < el.scrollTop || top + lineH > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 3));
    }
  }, [highlightKey, shown, cols, lineH]);

  const menuAt = (it: ObjectListItem, pos: { clientX: number; clientY: number; preventDefault?: () => void }) => {
    setSelected(itemKey(it));
    const items = contextMenu(menuIdOf(it.type), targetOf(it));
    if (items.length) showContextMenu(pos, items);
    else pos.preventDefault?.();
  };

  const onBodyKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = selectedIndex;
    const page = Math.max(1, Math.floor(size.height / lineH) - 1) * cols;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(i < 0 ? 0 : i + cols); break;
      case 'ArrowUp': e.preventDefault(); if (i <= 0 && layout === 'list') searchRef.current?.focus(); else move(i - cols); break;
      case 'ArrowRight': if (tiled) { e.preventDefault(); move(i + 1); } break;
      case 'ArrowLeft': if (tiled) { e.preventDefault(); move(i - 1); } break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(shown.length - 1); break;
      case 'PageDown': e.preventDefault(); move(i + page); break;
      case 'PageUp': e.preventDefault(); move(i - page); break;
      case 'Enter': if (current) { e.preventDefault(); open(current); } break;
      case 'Delete': if (target) { e.preventDefault(); runCommand('explorer.drop', target); } break;
      case 'F10':
      case 'ContextMenu': {
        if (!current || (e.key === 'F10' && !e.shiftKey)) break;
        e.preventDefault();
        const el = bodyRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(itemKey(current))}"]`);
        const r = el?.getBoundingClientRect();
        menuAt(current, { clientX: (r?.left ?? 0) + 40, clientY: r?.bottom ?? 0 });
        break;
      }
      case 'Escape': if (query) { e.preventDefault(); setQuery(''); } break;
      default:
        // Type to filter: printable keys go to the search box.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          e.preventDefault();
          setQuery(query + e.key);
          searchRef.current?.focus();
        }
    }
  };

  // ---------------------------------------------------------------- columns
  // Columns follow the type group (not the filter text, so they do not jump while typing).
  const inGroup = useMemo(() => filterObjects(source ?? [], group, ''), [source, group]);
  const anyRows = inGroup.some((it) => it.rowCount !== null);
  const anySize = inGroup.some((it) => it.sizeBytes !== null);
  const anyModified = inGroup.some((it) => it.modified !== null);
  const anyComment = inGroup.some((it) => !!it.comment);

  // ---------------------------------------------------------------- type groups (+ the scope's saved queries)
  const groupTabs = (
    <div className="ol-groups" role="tablist" aria-label="Object types">
      {(['all', ...GROUPS.map((g) => g.id)] as GroupFilter[])
        .filter((g) => g === 'all' || counts[g] > 0 || g === group)
        .map((g) => (
          <button
            key={g}
            role="tab"
            aria-selected={group === g}
            className={`ol-group${group === g ? ' on' : ''}`}
            onClick={() => { patch({ group: g }); setSelected(null); }}
          >
            {g !== 'all' && <span className={`ol-group-dot ol-tint-${g}`} aria-hidden="true" />}
            {g === 'all' ? 'All' : GROUPS.find((x) => x.id === g)!.label}
            <span className="ol-group-count">{source ? counts[g].toLocaleString('en-US') : '…'}</span>
          </button>
        ))}
      <button
        role="tab"
        aria-selected={group === QUERIES_GROUP}
        className={`ol-group${group === QUERIES_GROUP ? ' on' : ''}`}
        onClick={() => { patch({ group: QUERIES_GROUP }); setSelected(null); }}
        title="Queries saved into this schema"
      >
        <span className="ol-group-dot ol-tint-queries" aria-hidden="true" />
        Queries
        <span className="ol-group-count">{queryCount.toLocaleString('en-US')}</span>
      </button>
    </div>
  );
  if (group === QUERIES_GROUP) {
    return (
      <SavedQueryList
        connectionId={cid}
        database={catDb}
        schema={schema}
        layout={layout}
        onLayout={(l) => patch({ layout: l as ObjectsState['layout'] })}
        sort={state.sort}
        onSort={(s) => patch({ sort: s as ObjectsState['sort'] })}
        visible={visible}
        header={header}
        groupTabs={groupTabs}
        onNewMenu={(el) => {
          const entries = commandMenuItems(NEW_ENTRIES, { ...container, queries: true });
          if (entries.length) showMenuBelow(el, entries);
        }}
      />
    );
  }
  const columns: Column[] = [
    {
      key: 'name', label: 'Name', width: 'minmax(200px, 2.2fr)',
      render: (it) => (
        <span className="ol-name">
          <ObjectIcon type={it.type} size={15} />
          <span className="ol-name-text" title={`${it.schema ? `${it.schema}.` : ''}${it.name}`}>{it.name}</span>
        </span>
      ),
    },
    ...(multiSchema ? [{ key: 'schema' as const, label: 'Schema', width: 'minmax(90px, 0.7fr)', render: (it: ObjectListItem) => <span className="ol-muted">{it.schema}</span> }] : []),
    ...(group === 'all' ? [{ key: 'type' as const, label: 'Type', width: 'minmax(96px, 0.7fr)', render: (it: ObjectListItem) => <span className="ol-muted">{OBJECT_TYPE_SINGULAR[it.type]}</span> }] : []),
    ...(anyRows ? [{ key: 'rows' as const, label: 'Rows', width: '96px', numeric: true, render: (it: ObjectListItem) => (it.rowCount === null ? <span className="ol-faint">{it.type === 'table' || it.type === 'mview' ? '—' : ''}</span> : it.rowCount.toLocaleString('en-US')) }] : []),
    ...(anySize ? [{ key: 'size' as const, label: 'Size', width: '88px', numeric: true, render: (it: ObjectListItem) => formatSize(it.sizeBytes) }] : []),
    ...(anyModified ? [{ key: 'modified' as const, label: 'Modified', width: '138px', render: (it: ObjectListItem) => <span className="ol-muted">{formatModified(it.modified)}</span> }] : []),
    ...(anyComment ? [{ key: 'comment' as const, label: 'Comment', width: 'minmax(140px, 2fr)', render: (it: ObjectListItem) => <span className="ol-comment" title={it.comment ?? undefined}>{it.comment}</span> }] : []),
  ];
  const template = columns.map((c) => c.width).join(' ');

  // ---------------------------------------------------------------- toolbar
  const cv = (id: string, args: unknown, title?: string) => commandView(id, args, title);
  const execute = target ? cv('routine.execute', target, 'Execute…') : null;
  const design = target && DESIGNABLE.has(target.ref.type) ? cv('designer.edit', target, target.ref.type === 'table' ? 'Design' : 'Edit') : null;
  const drop = target ? cv('explorer.drop', target) : null;
  const newMenu = (el: HTMLElement) => {
    const entries = commandMenuItems(NEW_ENTRIES, container);
    if (entries.length) showMenuBelow(el, entries);
  };
  const where = [database ?? (conn?.providerId === 'sqlite' ? null : catDb), schema].filter(Boolean).join(' › ');
  const groupLabel = group === 'all' ? 'objects' : GROUPS.find((g) => g.id === group)!.label.toLowerCase();
  const fmt = (n: number) => n.toLocaleString('en-US');
  const statusText = (n: number, total: number) => (n === total ? `${fmt(total)} ${noun(total)}` : `${fmt(n)} of ${fmt(total)} ${groupLabel}`);
  const noun = (n: number) => (group === 'all' ? `${n === 1 ? 'object' : 'objects'}` : n === 1 ? GROUPS.find((g) => g.id === group)!.singular : groupLabel);

  const body = (() => {
    if (!source) {
      if (error) {
        return (
          <EmptyState
            icon={<TriangleAlert size={28} strokeWidth={1.5} />}
            title="Could not list the objects"
            hint={error}
            action={{ label: 'Try again', onClick: () => setReload((n) => n + 1) }}
          />
        );
      }
      return (
        <div className="ol-skeleton" role="status" aria-label="Loading objects">
          {[68, 52, 74, 46, 60, 40, 56].map((w, i) => (
            <div key={i} className="ol-skeleton-row">
              <span className="ol-skeleton-icon" />
              <span className="ol-skeleton-bar" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      );
    }
    if (!shown.length) {
      if (query) {
        return (
          <EmptyState
            compact
            icon={<SearchX size={26} strokeWidth={1.5} />}
            title={`No ${groupLabel} match “${query}”`}
            action={{ label: 'Clear filter', onClick: () => setQuery('') }}
          />
        );
      }
      const g = GROUPS.find((x) => x.id === group);
      const create = g?.id === 'table' || group === 'all' ? 'designer.newTable' : g?.id === 'view' ? 'designer.newView' : g?.id === 'proc' ? 'designer.newProcedure' : g?.id === 'func' ? 'designer.newFunction' : null;
      return (
        <EmptyState
          icon={<Database size={28} strokeWidth={1.5} />}
          title={`No ${groupLabel} in ${schema ?? database ?? 'this database'}`}
          hint={group === 'all' ? 'This schema is empty.' : undefined}
          action={create ? { command: create, args: container } : undefined}
          secondary={group !== 'all' ? { label: 'Show all objects', onClick: () => patch({ group: 'all' }) } : undefined}
        />
      );
    }
    if (layout === 'compact') {
      const tiles: ReactNode[] = [];
      for (let i = first * cols; i < Math.min(shown.length, last * cols); i++) {
        const it = shown[i];
        const k = itemKey(it);
        const row = Math.floor(i / cols);
        const col = i % cols;
        const meta = [OBJECT_TYPE_SINGULAR[it.type], it.rowCount !== null ? `${formatRowsShort(it.rowCount)} rows` : null, it.sizeBytes !== null ? formatSize(it.sizeBytes) : null]
          .filter(Boolean).join(' · ');
        tiles.push(
          <div
            key={k}
            data-key={k}
            role="option"
            aria-selected={k === selected}
            className={`ol-mini${k === selected ? ' selected' : ''}`}
            style={{ top: pad + row * lineH, left: `calc(${pad}px + ${col} * ((100% - ${2 * pad}px - ${(cols - 1) * gap}px) / ${cols} + ${gap}px))`, width: `calc((100% - ${2 * pad}px - ${(cols - 1) * gap}px) / ${cols})`, height: TILE_H }}
            onMouseDown={() => setSelected(k)}
            onDoubleClick={() => open(it)}
            onContextMenu={(e) => menuAt(it, e)}
            title={`${it.schema ? `${it.schema}.` : ''}${it.name}\n${meta}${it.comment ? `\n${it.comment}` : ''}`}
          >
            <span className={`ol-mini-icon ol-tint-${groupOf(it.type)}`}>
              <ObjectIcon type={it.type} size={14} />
            </span>
            <span className="ol-mini-name">
              {multiSchema && it.schema ? <span className="ol-mini-schema">{it.schema}.</span> : null}
              {it.name}
            </span>
          </div>,
        );
      }
      return <div className="ol-canvas" style={{ height: 2 * pad + lines * lineH - gap }}>{tiles}</div>;
    }
    if (layout === 'grid') {
      const cards: ReactNode[] = [];
      for (let i = first * cols; i < Math.min(shown.length, last * cols); i++) {
        const it = shown[i];
        const k = itemKey(it);
        const row = Math.floor(i / cols);
        const col = i % cols;
        const meta = [it.rowCount !== null ? `${formatRowsShort(it.rowCount)} rows` : null, it.sizeBytes !== null ? formatSize(it.sizeBytes) : null]
          .filter(Boolean).join(' · ') || (it.comment ?? OBJECT_TYPE_SINGULAR[it.type]);
        cards.push(
          <div
            key={k}
            data-key={k}
            role="option"
            aria-selected={k === selected}
            className={`ol-card${k === selected ? ' selected' : ''}`}
            style={{ top: 14 + row * lineH, left: `calc(14px + ${col} * ((100% - 28px - ${(cols - 1) * CARD_GAP}px) / ${cols} + ${CARD_GAP}px))`, width: `calc((100% - 28px - ${(cols - 1) * CARD_GAP}px) / ${cols})`, height: CARD_H }}
            onMouseDown={() => setSelected(k)}
            onDoubleClick={() => open(it)}
            onContextMenu={(e) => menuAt(it, e)}
            title={`${it.schema ? `${it.schema}.` : ''}${it.name}${it.comment ? `\n${it.comment}` : ''}`}
          >
            <span className={`ol-tile ol-tint-${groupOf(it.type)}`}>
              <ObjectIcon type={it.type} size={18} />
            </span>
            <span className="ol-card-text">
              <span className="ol-card-name">{it.name}</span>
              <span className="ol-card-meta">
                {multiSchema && it.schema ? <span className="ol-card-schema">{it.schema}</span> : null}
                {meta}
              </span>
            </span>
          </div>,
        );
      }
      return <div className="ol-canvas" style={{ height: 28 + lines * lineH - CARD_GAP }}>{cards}</div>;
    }
    const rows: ReactNode[] = [];
    for (let i = first; i < last; i++) {
      const it = shown[i];
      const k = itemKey(it);
      rows.push(
        <div
          key={k}
          data-key={k}
          role="option"
          aria-selected={k === selected}
          className={`ol-row${k === selected ? ' selected' : ''}`}
          style={{ top: i * ROW_H, height: ROW_H, gridTemplateColumns: template }}
          onMouseDown={() => setSelected(k)}
          onDoubleClick={() => open(it)}
          onContextMenu={(e) => menuAt(it, e)}
        >
          {columns.map((c) => (
            <span key={c.key} className={`ol-cell${c.numeric ? ' num' : ''}`}>
              {c.render(it)}
            </span>
          ))}
        </div>,
      );
    }
    return <div className="ol-canvas" style={{ height: shown.length * ROW_H }}>{rows}</div>;
  })();

  return (
    <div className="ol-view" style={{ display: visible ? undefined : 'none' }} data-command-scope="objects">
      {header}
      <div className="ol-toolbar" role="toolbar" aria-label="Objects">
        <button className="btn btn-xs" aria-haspopup="menu" onClick={(e) => newMenu(e.currentTarget)} title="Create an object in this schema">
          <Plus size={13} /> New <ChevronDown size={11} />
        </button>
        <span className="ol-sep" aria-hidden="true" />
        <button className="btn btn-xs" disabled={!current} onClick={() => current && open(current)} title="Open (Enter)">
          <FolderOpen size={13} /> Open
        </button>
        <button className="btn btn-xs" disabled={!design?.enabled} onClick={() => design?.run()} title={design?.tooltip ?? 'Design or edit the selected object'}>
          <PencilRuler size={13} /> {design?.title ?? 'Design'}
        </button>
        {(execute?.enabled || (current && ROUTINES.has(current.type))) && (
          <button className="btn btn-xs ol-execute" disabled={!execute?.enabled} onClick={() => execute?.run()} title="Execute with a parameter form">
            <Play size={12} fill="currentColor" /> Execute…
          </button>
        )}
        <button className="icon-btn sm" disabled={!drop?.enabled} onClick={() => drop?.run()} title={drop?.tooltip ?? 'Drop the selected object (Delete)'} aria-label="Drop">
          <Trash2 size={14} />
        </button>
        <div className="flex-1" />
        <div className="ol-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            data-primary-focus
            className="ol-search-input"
            placeholder={`Filter ${groupLabel}`}
            aria-label="Filter objects"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
              else if (e.key === 'ArrowDown' || (e.key === 'Enter' && shown.length)) {
                e.preventDefault();
                if (e.key === 'Enter' && shown.length === 1) return open(shown[0]);
                bodyRef.current?.focus();
                move(selectedIndex >= 0 ? selectedIndex : 0);
              }
            }}
          />
          {query && (
            <button className="icon-btn xs" aria-label="Clear search" title="Clear (Esc)" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="ol-layout" role="group" aria-label="Layout">
          <button className={layout === 'list' ? 'on' : ''} aria-pressed={layout === 'list'} title="List" aria-label="List" onClick={() => patch({ layout: 'list' })}>
            <List size={14} />
          </button>
          <button className={layout === 'grid' ? 'on' : ''} aria-pressed={layout === 'grid'} title="Cards" aria-label="Cards" onClick={() => patch({ layout: 'grid' })}>
            <LayoutGrid size={14} />
          </button>
          <button className={layout === 'compact' ? 'on' : ''} aria-pressed={layout === 'compact'} title="Small icons" aria-label="Small icons" onClick={() => patch({ layout: 'compact' })}>
            <Grid3x3 size={14} />
          </button>
        </div>
        <button className="icon-btn sm" title="Refresh" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {groupTabs}

      {layout === 'list' && source && shown.length > 0 && (
        <div className="ol-head" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => {
            const on = state.sort.key === c.key;
            return (
              <button
                key={c.key}
                role="columnheader"
                aria-sort={on ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={`ol-head-cell${c.numeric ? ' num' : ''}${on ? ' on' : ''}`}
                onClick={() => patch({ sort: nextSort(state.sort, c.key) })}
              >
                {c.label}
                {on && (state.sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={bodyRef}
        className={`ol-body ol-${layout}`}
        role="listbox"
        aria-label={`Objects of ${where || 'the database'}`}
        aria-activedescendant={undefined}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onBodyKey}
        onFocus={() => { if (selectedIndex < 0 && shown.length) setSelected(itemKey(shown[0])); }}
      >
        {body}
      </div>

      <div className="ol-status">
        <span>
          {source ? statusText(shown.length, group === 'all' ? source.length : counts[group]) : 'Loading…'}
        </span>
        {where && <span className="ol-muted">{where}</span>}
        {error && items === null && source && (
          <span className="ol-warn" title={error}>
            <TriangleAlert size={12} /> Statistics unavailable
          </span>
        )}
        <div className="flex-1" />
        {current && <span className="ol-muted mono">{current.schema ? `${current.schema}.` : ''}{current.name}</span>}
      </div>
    </div>
  );
}

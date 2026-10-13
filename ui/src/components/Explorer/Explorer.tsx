import { ChevronDown, ChevronRight, ChevronsDownUp, Folder, LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import type { ConnectionProfile } from '../../api/types';
import { copyText, newConsole, openObject, selectTop } from '../../app/actions';
import { qualifiedName, isTabular } from '../../lib/sql';
import { dbKey, useCatalog } from '../../store/catalog';
import { dialectOf, useConnections } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { toast, useUi } from '../../store/ui';
import { showContextMenu, type MenuItem } from '../common/Menu';
import { ColumnIcon, DatabaseIcon, ObjectIcon, ProviderIcon } from '../common/icons';
import { buildTree, databasesOf, nodeId, refOf, singleSchema, type TreeRow } from './tree';

const ROW_H = 22;
const EXPANDED_KEY = 'dbstudio.explorer.expanded.v1';

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

interface ExplorerState {
  expanded: Set<string>;
  collapsedFolders: Set<string>;
  filter: string;
  selected: string | null;
  toggle(id: string, open?: boolean): void;
  toggleFolder(f: string): void;
  collapseAll(): void;
  setFilter(f: string): void;
  select(id: string | null): void;
}

export const useExplorer = create<ExplorerState>((set, get) => ({
  expanded: loadSet(EXPANDED_KEY),
  collapsedFolders: new Set(),
  filter: '',
  selected: null,
  toggle(id, open) {
    const next = new Set(get().expanded);
    const willOpen = open ?? !next.has(id);
    if (willOpen) next.add(id);
    else next.delete(id);
    set({ expanded: next });
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next].slice(-500)));
    } catch {
      /* ignore */
    }
  },
  toggleFolder(f) {
    const next = new Set(get().collapsedFolders);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    set({ collapsedFolders: next });
  },
  collapseAll() {
    set({ expanded: new Set() });
    try {
      localStorage.removeItem(EXPANDED_KEY);
    } catch {
      /* ignore */
    }
  },
  setFilter(f) {
    set({ filter: f });
  },
  select(id) {
    set({ selected: id });
  },
}));

/** Trigger lazy loads for expanded nodes whose data is missing (never auto-retries errors). */
function useLazyLoads(connections: ConnectionProfile[]) {
  const expanded = useExplorer((s) => s.expanded);
  const conns = useCatalog((s) => s.conns);
  const dbs = useCatalog((s) => s.dbs);
  useEffect(() => {
    const cat = useCatalog.getState();
    const ensureDb = (cid: string, db: string | null) => {
      const d = dbs[dbKey(cid, db)];
      if (!d || d.schemasStatus === 'idle') {
        void cat.loadSchemas(cid, db);
        return;
      }
      const single = singleSchema(d);
      if (single && !d.schemaStatus[single]) void cat.loadSchema(cid, db, single);
    };
    for (const c of connections) {
      if (!expanded.has(nodeId.conn(c.id))) continue;
      const cc = conns[c.id];
      if (!cc || cc.status === 'idle') {
        void cat.loadDatabases(c.id);
        continue;
      }
      const list = databasesOf(c, cc);
      if (!list) continue;
      if (list.length === 1 && list[0] === null) ensureDb(c.id, null);
      for (const db of list) {
        if (db !== null && expanded.has(nodeId.db(c.id, db))) ensureDb(c.id, db);
      }
    }
    for (const d of Object.values(dbs)) {
      for (const s of d.schemasResp?.schemas ?? []) {
        if (expanded.has(nodeId.schema(d.connectionId, d.database, s.name)) && !d.schemaStatus[s.name]) {
          void cat.loadSchema(d.connectionId, d.database, s.name);
        }
      }
    }
  }, [expanded, conns, dbs, connections]);
}

function Highlight({ text, positions }: { text: string; positions?: number[] }) {
  if (!positions || positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  const parts: { s: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.s += text[i];
    else parts.push({ s: text[i], hit });
  }
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
    </>
  );
}

export function Explorer() {
  const connections = useConnections((s) => s.connections);
  const conns = useCatalog((s) => s.conns);
  const dbs = useCatalog((s) => s.dbs);
  const { expanded, collapsedFolders, filter, selected } = useExplorer();
  const ex = useExplorer.getState;
  const sessions = useSessions((s) => s.sessions);
  const openDialog = useUi((s) => s.openConnectionDialog);
  useLazyLoads(connections);

  const rows = useMemo(
    () => buildTree({ connections, conns, dbs, expanded, collapsedFolders, filter }),
    [connections, conns, dbs, expanded, collapsedFolders, filter],
  );
  const activeConnections = useMemo(() => new Set(Object.values(sessions).map((s) => s.connectionId)), [sessions]);

  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 10);

  const toggleRow = (r: TreeRow, open?: boolean) => {
    if (!r.expandable) return;
    if (r.kind === 'cfolder') ex().toggleFolder(r.label);
    else ex().toggle(r.id, open);
  };

  const activate = (r: TreeRow) => {
    if (r.kind === 'object' || r.kind === 'column') {
      const ref = refOf(r);
      if (ref && r.connectionId) openObject(r.connectionId, r.database ?? null, ref, r.kind === 'column' ? r.column?.name : null);
    } else toggleRow(r);
  };

  const scrollIntoView = (idx: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = rows.findIndex((r) => r.id === selected);
    const r = rows[idx];
    const move = (i: number) => {
      const n = Math.max(0, Math.min(rows.length - 1, i));
      ex().select(rows[n]?.id ?? null);
      scrollIntoView(n);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(rows.length - 1); }
    else if (e.key === 'ArrowRight' && r) {
      e.preventDefault();
      if (r.expandable && !r.expanded) toggleRow(r, true);
      else move(idx + 1);
    } else if (e.key === 'ArrowLeft' && r) {
      e.preventDefault();
      if (r.expandable && r.expanded) toggleRow(r, false);
      else {
        for (let i = idx - 1; i >= 0; i--) if (rows[i].depth < r.depth) { move(i); break; }
      }
    } else if (e.key === 'Enter' && r) { e.preventDefault(); activate(r); }
    else if (e.key === 'F5' && r?.connectionId) { e.preventDefault(); void refreshRow(r); }
    else if (e.key === 'Escape' && filter) { e.preventDefault(); ex().setFilter(''); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
      // Speed search: typing in the tree filters it.
      e.preventDefault();
      ex().setFilter(filter + e.key);
      filterRef.current?.focus();
    }
  };

  return (
    <div className="explorer" aria-label="Database explorer">
      <div className="panel-header">
        <span className="panel-title">Database Explorer</span>
        <div className="panel-actions">
          <button className="icon-btn" title="New connection" aria-label="New connection" onClick={() => openDialog({ mode: 'new' })}>
            <Plus size={15} />
          </button>
          <button
            className="icon-btn"
            title="Refresh selected connection (F5)"
            aria-label="Refresh"
            onClick={() => {
              const r = rows.find((x) => x.id === selected);
              if (r?.connectionId) void refreshRow(r);
              else for (const c of connections) if (conns[c.id]) void useCatalog.getState().refresh(c.id);
            }}
          >
            <RefreshCw size={14} />
          </button>
          <button className="icon-btn" title="Collapse all" aria-label="Collapse all" onClick={() => ex().collapseAll()}>
            <ChevronsDownUp size={15} />
          </button>
        </div>
      </div>
      <div className="explorer-filter">
        <Search size={13} className="explorer-filter-icon" />
        <input
          ref={filterRef}
          className="input sm"
          placeholder="Filter objects (fuzzy)"
          aria-label="Filter objects"
          value={filter}
          spellCheck={false}
          onChange={(e) => ex().setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              ex().setFilter('');
              listRef.current?.focus();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              ex().select(rows.find((r) => r.kind === 'object')?.id ?? rows[0]?.id ?? null);
              listRef.current?.focus();
            }
          }}
        />
        {filter && (
          <button className="icon-btn sm" aria-label="Clear filter" onClick={() => ex().setFilter('')}>
            <X size={13} />
          </button>
        )}
      </div>
      {connections.length === 0 ? (
        <div className="explorer-empty">
          <DatabaseIcon size={28} />
          <p>No connections yet.</p>
          <button className="btn btn-primary" onClick={() => openDialog({ mode: 'new' })}>
            <Plus size={14} /> New connection
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          className="tree"
          role="tree"
          aria-label="Connections"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
        >
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            {rows.slice(first, last).map((r, i) => (
              <TreeRowView
                key={r.id}
                row={r}
                top={(first + i) * ROW_H}
                selected={r.id === selected}
                active={r.kind === 'connection' && !!r.connectionId && (activeConnections.has(r.connectionId) || conns[r.connectionId]?.status === 'ready')}
                onSelect={() => ex().select(r.id)}
                onToggle={() => toggleRow(r)}
                onActivate={() => activate(r)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

async function refreshRow(r: TreeRow) {
  if (!r.connectionId) return;
  const cat = useCatalog.getState();
  if (r.kind === 'connection') await cat.refresh(r.connectionId);
  else if (r.schema && (r.kind === 'schema' || r.kind === 'folder' || r.kind === 'object' || r.kind === 'column')) {
    await cat.loadSchema(r.connectionId, r.database ?? null, r.schema, true);
  } else await cat.refresh(r.connectionId, r.database ?? null);
  toast('info', 'Refreshed');
}

function contextItems(r: TreeRow): MenuItem[] {
  const cid = r.connectionId;
  const ui = useUi.getState();
  if (r.kind === 'cfolder') {
    return [{ label: 'New connection in folder', icon: <Plus size={14} />, onClick: () => ui.openConnectionDialog({ mode: 'new', folder: r.label }) }];
  }
  if (!cid) return [];
  const dialect = dialectOf(cid);
  const refresh: MenuItem = { label: 'Refresh', icon: <RefreshCw size={14} />, shortcut: 'F5', onClick: () => void refreshRow(r) };
  if (r.kind === 'connection') {
    const conn = useConnections.getState().connections.find((c) => c.id === cid);
    return [
      { label: 'Open console', shortcut: 'Ctrl+T', onClick: () => newConsole(cid, null) },
      { separator: true },
      { label: 'Edit connection…', onClick: () => ui.openConnectionDialog({ mode: 'edit', id: cid }) },
      { label: 'Duplicate…', onClick: () => ui.openConnectionDialog({ mode: 'duplicate', id: cid }) },
      { label: 'New connection…', onClick: () => ui.openConnectionDialog({ mode: 'new', folder: conn?.folder ?? null }) },
      { separator: true },
      refresh,
      {
        label: 'Disconnect explorer',
        onClick: () => {
          useCatalog.getState().forget(cid);
          useExplorer.getState().toggle(r.id, false);
        },
      },
      { label: 'Copy name', onClick: () => void copyText(r.label) },
      { separator: true },
      {
        label: 'Delete connection',
        danger: true,
        onClick: async () => {
          const ok = await ui.askConfirm({ title: 'Delete connection', message: `Delete “${r.label}”? Its saved password is removed too.`, confirmLabel: 'Delete', danger: true });
          if (!ok) return;
          try {
            await useConnections.getState().remove(cid);
            useCatalog.getState().forget(cid);
          } catch (e) {
            toast('error', 'Delete failed', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ];
  }
  if (r.kind === 'database' || r.kind === 'schema' || r.kind === 'folder') {
    return [
      { label: 'Open console', onClick: () => newConsole(cid, r.database ?? null) },
      refresh,
      { label: 'Copy name', onClick: () => void copyText(r.kind === 'schema' ? r.schema ?? r.label : r.label) },
    ];
  }
  const ref = refOf(r);
  if (!ref) return [];
  const defaultSchema = useCatalog.getState().dbs[dbKey(cid, r.database ?? null)]?.defaultSchema ?? null;
  const qualified = qualifiedName(ref, dialect, { defaultSchema });
  if (r.kind === 'column') {
    return [
      { label: 'Copy column name', onClick: () => void copyText(r.column!.name) },
      { label: `Open ${ref.name}`, onClick: () => openObject(cid, r.database ?? null, ref, r.column?.name) },
    ];
  }
  return [
    ...(isTabular(ref.type)
      ? [{ label: 'Select top 1000 rows', onClick: () => selectTop(cid, r.database ?? null, ref, 1000) } satisfies MenuItem]
      : []),
    { label: 'Open DDL / details', shortcut: 'Enter', onClick: () => openObject(cid, r.database ?? null, ref) },
    { label: 'Open console', onClick: () => newConsole(cid, r.database ?? null) },
    { separator: true },
    { label: 'Copy qualified name', onClick: () => void copyText(qualifiedName(ref, dialect, { always: true })) },
    { label: 'Copy name', onClick: () => void copyText(qualified) },
    { separator: true },
    refresh,
  ];
}

interface RowProps {
  row: TreeRow;
  top: number;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onActivate: () => void;
}

function TreeRowView({ row: r, top, selected, active, onSelect, onToggle, onActivate }: RowProps) {
  const conn = useConnections((s) => (r.kind === 'connection' ? s.connections.find((c) => c.id === r.connectionId) : undefined));
  const draggable = r.kind === 'object' || r.kind === 'column';
  let icon: ReactNode = null;
  if (r.kind === 'connection' && conn) icon = <ProviderIcon providerId={conn.providerId} color={conn.color} size={15} />;
  else if (r.kind === 'cfolder') icon = <Folder size={14} className="obj-icon obj-folder" />;
  else if (r.kind === 'database') icon = <DatabaseIcon />;
  else if (r.kind === 'schema') icon = <span className="schema-glyph">S</span>;
  else if (r.kind === 'folder') icon = <Folder size={14} className="obj-icon obj-folder" />;
  else if (r.kind === 'object' && r.objectType) icon = <ObjectIcon type={r.objectType} />;
  else if (r.kind === 'column') icon = <ColumnIcon pk={r.column?.pk} />;
  else if (r.status === 'loading') icon = <LoaderCircle size={13} className="spin" />;

  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}${r.kind === 'status' ? ` status ${r.status}` : ''}`}
      role="treeitem"
      aria-level={r.depth + 1}
      aria-expanded={r.expandable ? r.expanded : undefined}
      aria-selected={selected}
      data-kind={r.kind}
      data-id={r.id}
      style={{ top, paddingLeft: 6 + r.depth * 14 }}
      draggable={draggable}
      onDragStart={(e) => {
        if (!r.connectionId) return;
        const ref = refOf(r);
        let text = r.label;
        if (r.kind === 'object' && ref) {
          const def = useCatalog.getState().dbs[dbKey(r.connectionId, r.database ?? null)]?.defaultSchema ?? null;
          text = qualifiedName(ref, dialectOf(r.connectionId), { defaultSchema: def });
        }
        e.dataTransfer.setData('text/plain', text);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onMouseDown={() => onSelect()}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.tree-twisty')) return;
        if (r.kind === 'cfolder' || r.kind === 'folder') onToggle();
      }}
      onDoubleClick={() => onActivate()}
      onContextMenu={(e) => {
        onSelect();
        const items = contextItems(r);
        if (items.length) showContextMenu(e, items);
        else e.preventDefault();
      }}
      title={r.kind === 'column' ? `${r.label} ${r.detail ?? ''}` : r.object?.cm ?? undefined}
    >
      <span
        className="tree-twisty"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {r.expandable ? r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </span>
      {icon && <span className="tree-icon">{icon}</span>}
      <span className={`tree-label${r.kind === 'connection' ? ' strong' : ''}`}>
        <Highlight text={r.label} positions={r.match} />
      </span>
      {active && <span className="conn-active-dot" title="Connected" />}
      {r.detail && <span className="tree-detail">{r.detail}</span>}
      {r.count !== undefined && r.kind !== 'object' && <span className="tree-count">{r.count}</span>}
    </div>
  );
}

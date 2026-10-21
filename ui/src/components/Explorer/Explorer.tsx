import {
  ChevronDown, ChevronRight, ChevronsDownUp, Circle, Columns3, Database, Folder, LoaderCircle, Lock, PanelsTopLeft, Plus, RefreshCw,
  Search, SquareTerminal, Unplug, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { CatalogObjectType, ConnectionProfile } from '../../api/types';
import { activateObject, connectAndOpen, newConsole } from '../../app/actions';
import { displayShortcut } from '../../commands/keys';
import { hasCommand, runCommand } from '../../commands/registry';
import type { CommandTarget } from '../../commands/types';
import { useCommandContext } from '../../commands/useCommands';
import { isTabular, qualifiedName } from '../../lib/sql';
import { dbKey, useCatalog } from '../../store/catalog';
import { getSourceModule, useSourceModules } from '../../lib/sources';
import { dialectOf, kindOf, providerKind, useConnections } from '../../store/connections';
import { useSourceClients } from '../../store/sourceClients';
import { connectionActivity, useSessions, type ConnectionActivity } from '../../store/sessions';
import { connColorCss, connColorName } from '../../theme/connColors';
import { showContextMenu } from '../common/Menu';
import { ColumnIcon, DatabaseIcon, ObjectIcon } from '../common/icons';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { activityTitle } from '../common/text';
import { EmptyState } from '../EmptyState/EmptyState';
import { contextMenu } from '../layout/commandMenu';
import { activeChips, ALL_CONNECTIONS, chipsFor, TYPE_CHIPS, useExplorer } from './explorerStore';
import { buildTree, databasesOf, isSourceConnection, nodeId, refOf, singleSchema, typesOfChips, type TreeRow } from './tree';

export { useExplorer } from './explorerStore';

const ROW_H = 24;

/** Focus requests (filter box, tree) already acted on. */
const consumed = { filter: 0, tree: 0 };

/** Trigger lazy loads for expanded nodes whose data is missing (never auto-retries errors). */
function useLazyLoads(connections: ConnectionProfile[]) {
  const expanded = useExplorer((s) => s.expanded);
  const conns = useCatalog((s) => s.conns);
  const dbs = useCatalog((s) => s.dbs);
  const modules = useSourceModules((s) => s.modules);
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
      if (isSourceConnection(c)) {
        // M2: Redis/MongoDB/Kafka never load the SQL catalog; their module loads what its expanded nodes need.
        modules[c.providerId]?.ensureLoaded?.(c, expanded);
        continue;
      }
      const cc = conns[c.id];
      if (!cc || cc.status === 'idle') {
        void cat.loadDatabases(c.id);
        continue;
      }
      const list = databasesOf(c, cc);
      if (!list) continue;
      if (list.length === 1 && (list[0] === null || c.providerId === 'sqlite')) ensureDb(c.id, list[0]);
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
  }, [expanded, conns, dbs, connections, modules]);
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
  return <>{parts.map((p, i) => (p.hit ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}</>;
}

/** Command target of a tree row (context-menu args; also stored as the explorer selection). */
export function targetOfRow(r: TreeRow): CommandTarget | null {
  if (!r.connectionId) return null;
  if (r.kind === 'connection') return { kind: 'connection', connectionId: r.connectionId };
  if (r.kind === 'source' && r.source) {
    return {
      kind: 'source', connectionId: r.connectionId, providerId: r.source.providerId, nodeType: r.source.nodeType, path: r.source.path,
      meta: r.source.meta,
    };
  }
  if (r.kind === 'object' || r.kind === 'column') {
    const ref = refOf(r);
    return ref ? { kind: 'object', connectionId: r.connectionId, database: r.database ?? null, ref } : null;
  }
  if (r.kind === 'database' || r.kind === 'schema' || r.kind === 'folder') {
    return { kind: 'container', connectionId: r.connectionId, database: r.database ?? null, schema: r.schema ?? null, objectType: r.kind === 'folder' ? r.objectType : undefined };
  }
  return null;
}

const ROUTINES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc', 'package', 'trigger']);

export function contextMenuIdOf(r: TreeRow): string | null {
  if (r.kind === 'cfolder') return 'explorer.folder';
  if (r.kind === 'connection') return r.connectionId && kindOf(r.connectionId) !== 'relational' ? 'explorer.sourceConnection' : 'explorer.connection';
  if (r.kind === 'source') return r.source ? getSourceModule(r.source.providerId)?.contextMenuId(r) ?? null : null;
  if (r.kind === 'database' || r.kind === 'schema' || r.kind === 'folder') return 'explorer.container';
  if (r.kind === 'object' || r.kind === 'column') {
    const t = r.objectType;
    if (t === 'table') return 'explorer.table';
    if (t === 'view' || t === 'mview') return 'explorer.view';
    if (t && ROUTINES.has(t)) return 'explorer.routine';
    return 'explorer.object';
  }
  return null;
}

/**
 * Enter / double-click: tables & views open their data (when the data tab exists), other objects their details, or
 * routines their "Edit:" console with "Open procedures and functions in edit mode" (activateObject).
 */
function activateRow(r: TreeRow, toggle: (r: TreeRow, open?: boolean) => void) {
  if (r.kind === 'status' && r.status === 'load' && r.connectionId && r.loadSchema) {
    void useCatalog.getState().loadSchema(r.connectionId, r.database ?? null, r.loadSchema);
    return;
  }
  if (r.kind === 'source') {
    // M2: leaves open their view (module.activate); containers toggle.
    const mod = r.source ? getSourceModule(r.source.providerId) : undefined;
    if (mod && !r.expandable) mod.activate(r);
    else toggle(r);
    return;
  }
  if (r.kind === 'object' || r.kind === 'column') {
    const t = targetOfRow(r);
    if (!t || t.kind !== 'object') return;
    if (r.kind === 'object' && isTabular(t.ref.type) && hasCommand('data.open') && runCommand('data.open', t)) return;
    activateObject(t.connectionId, t.database, t.ref, r.kind === 'column' ? r.column?.name : null);
  } else toggle(r);
}

export function Explorer() {
  useCommandContext();
  const connections = useConnections((s) => s.connections);
  const conns = useCatalog((s) => s.conns);
  const dbs = useCatalog((s) => s.dbs);
  const expanded = useExplorer((s) => s.expanded);
  const collapsedFolders = useExplorer((s) => s.collapsedFolders);
  const filter = useExplorer((s) => s.filter);
  const selected = useExplorer((s) => s.selected);
  const chipsMap = useExplorer((s) => s.chips);
  const chipScope = useExplorer((s) => s.chipScope);
  const searchColumns = useExplorer((s) => s.searchColumns);
  const focusFilterSeq = useExplorer((s) => s.focusFilterSeq);
  const focusTreeSeq = useExplorer((s) => s.focusTreeSeq);
  const revealSeq = useExplorer((s) => s.revealSeq);
  const ex = useExplorer.getState;
  const sessions = useSessions((s) => s.sessions);
  const sourceVersion = useSourceModules((s) => s.version);
  const sourceClients = useSourceClients((s) => s.clients);
  useLazyLoads(connections);

  const chips = activeChips({ chips: chipsMap, chipScope });
  const typesFor = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof typesOfChips>>();
    return (cid: string) => {
      if (!cache.has(cid)) cache.set(cid, typesOfChips(chipsFor({ chips: chipsMap, chipScope }, cid)));
      return cache.get(cid)!;
    };
  }, [chipsMap, chipScope]);

  const rows = useMemo(
    () => buildTree({ connections, conns, dbs, expanded, collapsedFolders, filter, typesFor, searchColumns }),
    // sourceVersion: source modules re-render their subtrees through notifySourceTreeChanged().
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connections, conns, dbs, expanded, collapsedFolders, filter, typesFor, searchColumns, sourceVersion],
  );
  // One definition of "connected" (shared with the status bar): an open session or a loaded catalog.
  const activityOf = useMemo(() => {
    const m = new Map<string, ConnectionActivity>();
    return (cid: string) => {
      // M2: an open source client (Redis/MongoDB/Kafka) counts like a loaded catalog.
      if (!m.has(cid)) m.set(cid, connectionActivity(cid, sessions, (id) => conns[id]?.status ?? (sourceClients[id] ? 'ready' : undefined)));
      return m.get(cid)!;
    };
  }, [sessions, conns, sourceClients]);

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
  }, [connections.length]);

  // A request is consumed once: remounting the panel (switching dock tabs) must not steal focus again.
  useEffect(() => {
    if (focusFilterSeq && focusFilterSeq !== consumed.filter) {
      consumed.filter = focusFilterSeq;
      filterRef.current?.focus();
      filterRef.current?.select();
    }
  }, [focusFilterSeq]);
  useEffect(() => {
    if (focusTreeSeq && focusTreeSeq !== consumed.tree) {
      consumed.tree = focusTreeSeq;
      listRef.current?.focus();
    }
  }, [focusTreeSeq]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 10);

  const select = (r: TreeRow | undefined) => ex().select(r?.id ?? null, r ? targetOfRow(r) : null);

  const toggleRow = (r: TreeRow, open?: boolean) => {
    if (!r.expandable) return;
    if (r.kind === 'cfolder') ex().toggleFolder(r.label);
    else ex().toggle(r.id, open);
  };

  const scrollIntoView = (idx: number) => {
    const el = listRef.current;
    if (!el || idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  // Reveal (palette Alt+Enter): scroll the selected row into view once it exists.
  useEffect(() => {
    if (!revealSeq) return;
    const idx = rows.findIndex((r) => r.id === selected);
    if (idx >= 0) {
      scrollIntoView(idx);
      const r = rows[idx];
      ex().select(r.id, targetOfRow(r));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq, rows]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = rows.findIndex((r) => r.id === selected);
    const r = rows[idx];
    const move = (i: number) => {
      const n = Math.max(0, Math.min(rows.length - 1, i));
      select(rows[n]);
      scrollIntoView(n);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(rows.length - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(idx + Math.floor(height / ROW_H)); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(idx - Math.floor(height / ROW_H)); }
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
    } else if (e.key === 'Enter' && r) { e.preventDefault(); activateRow(r, toggleRow); }
    else if (e.key === 'Delete' && r && r.kind === 'object') {
      // Drop… asks first (statement preview, Cancel focused).
      e.preventDefault();
      runCommand('explorer.drop', targetOfRow(r));
    }
    else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && r) {
      e.preventDefault();
      const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(r.id)}"]`);
      const rect = el?.getBoundingClientRect();
      openMenu(r, { clientX: (rect?.left ?? 0) + 40, clientY: rect?.bottom ?? 0 });
    } else if (e.key === 'Escape' && filter) { e.preventDefault(); ex().setFilter(''); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
      // Speed search: typing in the tree filters it.
      e.preventDefault();
      ex().setFilter(filter + e.key);
      filterRef.current?.focus();
    }
  };

  const openMenu = (r: TreeRow, e: { clientX: number; clientY: number; preventDefault?: () => void }) => {
    const id = contextMenuIdOf(r);
    if (!id) return e.preventDefault?.();
    const args = r.kind === 'cfolder' ? { folder: r.label } : targetOfRow(r);
    const items = contextMenu(id, args);
    if (items.length) showContextMenu(e, items);
    else e.preventDefault?.();
  };

  const nothingOpen = !filter && connections.length > 0 && Object.keys(conns).length === 0 && !connections.some((c) => expanded.has(nodeId.conn(c.id)));
  const recentConn = [...connections].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0];
  const scopedName = chipScope !== ALL_CONNECTIONS ? connections.find((c) => c.id === chipScope)?.name ?? null : null;
  const selectedTarget = ex().selectedTarget;
  const selectedConn = selectedTarget && 'connectionId' in selectedTarget ? connections.find((c) => c.id === selectedTarget.connectionId) : undefined;
  const offerScope = chipScope === ALL_CONNECTIONS && chips.length > 0 && !!selectedConn && connections.length > 1;

  return (
    <div className="explorer dock-panel" aria-label="Database explorer" data-command-scope="explorer">
      <div className="panel-header">
        <span className="panel-title">Explorer</span>
        <div className="panel-actions">
          <button className="icon-btn" title={`New connection (${displayShortcut('Mod+Shift+N')})`} aria-label="New connection" onClick={() => runCommand('file.newConnection')}>
            <Plus size={16} strokeWidth={1.5} />
          </button>
          <button
            className="icon-btn"
            title={`Refresh selected (${displayShortcut('F5')})`}
            aria-label="Refresh"
            onClick={() => {
              const t = ex().selectedTarget;
              if (t) runCommand('connections.refreshCatalog', t);
              else for (const c of connections) if (conns[c.id]) void useCatalog.getState().refresh(c.id);
            }}
          >
            <RefreshCw size={16} strokeWidth={1.5} />
          </button>
          <button className="icon-btn" title="Collapse all" aria-label="Collapse all" onClick={() => ex().collapseAll()}>
            <ChevronsDownUp size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {connections.length > 0 && (
        <div className="explorer-filter">
          <div className="search-box">
            <Search size={14} strokeWidth={1.5} />
            <input
              ref={filterRef}
              className="input borderless"
              placeholder={`Filter objects (${displayShortcut('Mod+F')})`}
              aria-label="Filter objects"
              value={filter}
              dir="auto"
              spellCheck={false}
              onChange={(e) => ex().setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (filter) ex().setFilter('');
                  else listRef.current?.focus();
                } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  e.preventDefault();
                  const r = rows.find((x) => x.kind === 'object') ?? rows[0];
                  select(r);
                  listRef.current?.focus();
                  if (e.key === 'Enter' && r) activateRow(r, toggleRow);
                }
              }}
            />
            {filter && (
              <button className="search-toggle" aria-label="Clear filter" title="Clear filter (Esc)" onClick={() => ex().setFilter('')}>
                <X size={14} />
              </button>
            )}
            <button
              className={`search-toggle${searchColumns ? ' on' : ''}`}
              aria-pressed={searchColumns}
              aria-label="Search columns too"
              title="Search column names too"
              onClick={() => ex().setSearchColumns(!searchColumns)}
            >
              <Columns3 size={14} strokeWidth={1.75} />
            </button>
          </div>
          <div className="chip-row" role="group" aria-label={`Object types${scopedName ? ` in ${scopedName}` : ' in every connection'}`}>
            {TYPE_CHIPS.map((c) => (
              <button key={c.id} className={`chip${chips.includes(c.id) ? ' on' : ''}`} aria-pressed={chips.includes(c.id)} onClick={() => ex().toggleChip(c.id)}>
                {c.label}
              </button>
            ))}
            {chips.length > 0 && (
              <button className="chip chip-clear" onClick={() => ex().clearChips()} title="Show all object types">
                Clear
              </button>
            )}
            {scopedName !== null ? (
              <button
                className="chip chip-scope on"
                onClick={() => ex().scopeChipsTo(ALL_CONNECTIONS)}
                title={`The type filter applies only to ${scopedName}. Click to apply it to every connection.`}
                aria-label={`Type filter only in ${scopedName}; remove to apply it to every connection`}
              >
                in {scopedName} <X size={12} aria-hidden="true" />
              </button>
            ) : offerScope ? (
              <button
                className="chip chip-scope-offer"
                onClick={() => ex().scopeChipsTo(selectedConn!.id)}
                title={`Apply the type filter only to ${selectedConn!.name}`}
              >
                only in {selectedConn!.name}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {connections.length === 0 ? (
        <EmptyState
          icon={<Database size={32} strokeWidth={1.25} />}
          title="Add your first connection"
          hint="SQL databases, Redis, MongoDB or Kafka."
          action={{ command: 'file.newConnection', label: 'New connection' }}
          secondary={{ command: 'file.sampleDb', label: 'Try the sample database' }}
        />
      ) : (
        <>
          <div
            ref={listRef}
            className="tree"
            role="tree"
            aria-label="Connections"
            aria-activedescendant={selected ? `tree-${selected}` : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (!selected && rows[0]) select(rows[0]);
            }}
            onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
          >
            <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
              {rows.slice(first, last).map((r, i) => (
                <TreeRowView
                  key={r.id}
                  row={r}
                  top={(first + i) * ROW_H}
                  selected={r.id === selected}
                  activity={r.kind === 'connection' && r.connectionId ? activityOf(r.connectionId) : null}
                  onSelect={() => select(r)}
                  onToggle={() => toggleRow(r)}
                  onActivate={() => activateRow(r, toggleRow)}
                  onMenu={(e) => {
                    select(r);
                    openMenu(r, e);
                  }}
                />
              ))}
            </div>
          </div>
          {nothingOpen && recentConn && (
            <EmptyState
              compact
              className="explorer-connect"
              icon={<Database size={24} strokeWidth={1.25} />}
              title="Connect to browse objects"
              action={{ label: `Connect to ${recentConn.name}`, onClick: () => ex().toggle(nodeId.conn(recentConn.id), true) }}
            />
          )}
        </>
      )}
    </div>
  );
}

interface RowProps {
  row: TreeRow;
  top: number;
  selected: boolean;
  activity: ConnectionActivity;
  onSelect: () => void;
  onToggle: () => void;
  onActivate: () => void;
  onMenu: (e: ReactMouseEvent) => void;
}

function TreeRowView({ row: r, top, selected, activity, onSelect, onToggle, onActivate, onMenu }: RowProps) {
  const active = !!activity;
  const conn = useConnections((s) => (r.kind === 'connection' ? s.connections.find((c) => c.id === r.connectionId) : undefined));
  const draggable = r.kind === 'object' || r.kind === 'column';
  let icon: ReactNode = null;
  if (r.kind === 'connection' && conn) icon = <ProviderLogo providerId={conn.providerId} size={16} />;
  else if (r.kind === 'cfolder') icon = <Folder size={16} strokeWidth={1.5} className="obj-icon obj-folder" />;
  else if (r.kind === 'database') icon = <DatabaseIcon />;
  else if (r.kind === 'schema') icon = <span className="schema-glyph" aria-hidden="true">S</span>;
  else if (r.kind === 'folder') icon = <Folder size={16} strokeWidth={1.5} className="obj-icon obj-folder" />;
  else if (r.kind === 'object' && r.objectType) icon = <ObjectIcon type={r.objectType} />;
  else if (r.kind === 'column') icon = <ColumnIcon pk={r.column?.pk} fk={r.column?.fk} />;
  else if (r.kind === 'source') {
    const custom = r.source ? getSourceModule(r.source.providerId)?.icon?.(r) : undefined;
    icon = custom ?? (r.expandable
      ? <Folder size={16} strokeWidth={1.5} className="obj-icon obj-folder" />
      : <Circle size={10} strokeWidth={2} className="obj-icon obj-source" />);
  }
  else if (r.status === 'loading') icon = <LoaderCircle size={14} className="spin" />;
  else if (r.status === 'load') icon = <Database size={14} strokeWidth={1.5} />;

  const color = conn ? connColorCss(conn.color) : undefined;
  const title =
    r.kind === 'column' ? `${r.label} ${r.detail ?? ''}${r.column?.pk ? ' · primary key' : ''}${r.column?.fk ? ' · foreign key' : ''}`
      : r.kind === 'connection' && conn ? `${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''}${conn.readOnly ? ' · read-only' : ''}`
        : r.object?.cm ?? undefined;

  return (
    <div
      id={`tree-${r.id}`}
      className={`tree-row${selected ? ' selected' : ''}${r.kind === 'status' ? ` status ${r.status}` : ''}${r.kind === 'connection' ? ' root' : ''}`}
      role="treeitem"
      aria-level={r.depth + 1}
      aria-expanded={r.expandable ? r.expanded : undefined}
      aria-selected={selected}
      data-kind={r.kind}
      data-id={r.id}
      style={{ top, paddingLeft: 8 + r.depth * 16, ...(color ? { ['--conn-color' as string]: color } : {}) }}
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
        e.dataTransfer.setData('application/x-dbstudio-object', JSON.stringify({ connectionId: r.connectionId, name: text }));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onMouseDown={() => onSelect()}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.tree-twisty, .tree-row-actions')) return;
        if (r.kind === 'cfolder' || r.kind === 'folder' || r.kind === 'database' || r.kind === 'schema' || (r.kind === 'source' && r.expandable)) onToggle();
        if (r.kind === 'status' && r.status === 'load') onActivate();
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.tree-row-actions')) return;
        if (r.kind === 'connection' || r.kind === 'object' || r.kind === 'column' || (r.kind === 'source' && !r.expandable)) onActivate();
      }}
      onContextMenu={onMenu}
      title={title}
    >
      {r.kind === 'connection' && color && <span className="tree-conn-bar" aria-hidden="true" />}
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
      <span className={`tree-label${r.kind === 'connection' ? ' strong' : ''}`} dir="auto">
        <Highlight text={r.label} positions={r.match} />
      </span>
      {conn?.readOnly && <Lock size={11} className="tree-lock" aria-label="Read-only" />}
      {r.busy && <LoaderCircle size={12} className="spin tree-spinner" aria-label="Loading" />}
      {active && !r.busy && (
        <span
          className={`conn-active-dot${activity?.kind === 'session' ? ' has-session' : ' catalog-only'}`}
          title={activityTitle(activity)}
          role="img"
          aria-label={activityTitle(activity)}
        />
      )}
      {r.detail && <span className="tree-detail">{r.detail}</span>}
      {r.count !== undefined && r.kind !== 'object' && <span className="tree-count">{r.count.toLocaleString()}</span>}
      {r.kind === 'connection' && r.connectionId && (
        <span className="tree-row-actions">
          {conn && providerKind(conn.providerId) !== 'relational' ? (
            <button className="icon-btn xs" title="Open" aria-label={`Open ${r.label}`} tabIndex={-1} onClick={() => connectAndOpen(r.connectionId!)}>
              <PanelsTopLeft size={13} />
            </button>
          ) : (
            <button className="icon-btn xs" title="Open console" aria-label={`Open console on ${r.label}`} tabIndex={-1} onClick={() => newConsole(r.connectionId!, null)}>
              <SquareTerminal size={13} />
            </button>
          )}
          {active && (
            <button className="icon-btn xs" title="Disconnect" aria-label={`Disconnect ${r.label}`} tabIndex={-1} onClick={() => runCommand('connections.disconnect', { kind: 'connection', connectionId: r.connectionId })}>
              <Unplug size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

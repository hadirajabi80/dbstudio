// Scope picker of the Search tab: a dropdown tree of every relational connection › database › schema › table/view,
// loaded lazily from the catalog store as nodes expand. A click on a connection, database or schema searches there;
// tables and views are checked (several of one database) to search only them.
import { Check, ChevronDown, ChevronRight, Globe, LoaderCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CatalogObjectType, ConnectionProfile } from '../../api/types';
import { dbKey, useCatalog, type ConnCatalog, type DbCatalog } from '../../store/catalog';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { DatabaseIcon, FolderIcon, ObjectIcon } from '../common/icons';
import { databasesOf } from '../Explorer/tree';
import type { ScopeObject, SearchScope } from './model';

type PickRow =
  | { kind: 'all'; key: string; depth: 0; label: string }
  | { kind: 'conn'; key: string; depth: 0; conn: ConnectionProfile; connected: boolean; expanded: boolean }
  | { kind: 'db'; key: string; depth: 1; cid: string; database: string; expanded: boolean }
  | { kind: 'schema'; key: string; depth: number; cid: string; database: string | null; schema: string; expanded: boolean }
  | { kind: 'object'; key: string; depth: number; cid: string; database: string | null; obj: ScopeObject }
  | { kind: 'status'; key: string; depth: number; label: string; loading?: boolean };

const PICKABLE = new Set<CatalogObjectType>(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'trigger']);

interface Props {
  scope: SearchScope;
  connections: ConnectionProfile[];
  connected: ReadonlySet<string>;
  onPick(scope: SearchScope, close: boolean): void;
  onClose(): void;
}

function objectChecked(scope: SearchScope, cid: string, database: string | null, o: ScopeObject): boolean {
  return scope.kind === 'objects' && scope.connectionId === cid && (scope.database ?? null) === database
    && scope.objects.some((x) => x.name === o.name && (x.schema ?? null) === (o.schema ?? null) && x.type === o.type);
}

function isCurrent(scope: SearchScope, r: PickRow): boolean {
  switch (r.kind) {
    case 'all': return scope.kind === 'all';
    case 'conn': return scope.kind === 'connection' && scope.connectionId === r.conn.id;
    case 'db': return scope.kind === 'database' && scope.connectionId === r.cid && scope.database === r.database;
    case 'schema': return scope.kind === 'schema' && scope.connectionId === r.cid && (scope.database ?? null) === r.database && scope.schema === r.schema;
    default: return false;
  }
}

export function ScopePicker({ scope, connections, connected, onPick, onClose }: Props) {
  const conns = useCatalog((s) => s.conns);
  const dbs = useCatalog((s) => s.dbs);
  const initial = useMemo(() => {
    const s = new Set<string>();
    if (scope.kind !== 'all') s.add(`c|${scope.connectionId}`);
    if ((scope.kind === 'schema' || scope.kind === 'objects' || scope.kind === 'database') && scope.database) s.add(`d|${scope.connectionId}|${scope.database}`);
    if (scope.kind === 'objects') for (const o of scope.objects) s.add(`s|${scope.connectionId}|${scope.database ?? ''}|${o.schema ?? ''}`);
    return s;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [expanded, setExpanded] = useState<Set<string>>(initial);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => filterRef.current?.focus(), []);

  // Lazy loads of what an expanded node needs (never auto-retries errors).
  useEffect(() => {
    const cat = useCatalog.getState();
    for (const c of connections) {
      if (!expanded.has(`c|${c.id}`)) continue;
      const cc = conns[c.id];
      if (!cc || cc.status === 'idle') {
        void cat.loadDatabases(c.id);
        continue;
      }
      for (const db of databasesOf(c, cc) ?? []) {
        const flat = isFlat(c, cc);
        if (!flat && !expanded.has(`d|${c.id}|${db ?? ''}`)) continue;
        const d = dbs[dbKey(c.id, db)];
        if (!d || d.schemasStatus === 'idle') {
          void cat.loadSchemas(c.id, db);
          continue;
        }
        for (const s of d.schemasResp?.schemas ?? []) {
          if (expanded.has(`s|${c.id}|${db ?? ''}|${s.name}`) && !d.schemaStatus[s.name]) void cat.loadSchema(c.id, db, s.name);
        }
      }
    }
  }, [expanded, conns, dbs, connections]);

  const rows = useMemo(() => buildRows(connections, connected, conns, dbs, expanded, filter.trim().toLowerCase()), [connections, connected, conns, dbs, expanded, filter]);
  const activeIdx = Math.min(active, rows.length - 1);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const toggle = (key: string, open?: boolean) => setExpanded((s) => {
    const n = new Set(s);
    if (open ?? !n.has(key)) n.add(key);
    else n.delete(key);
    return n;
  });

  const choose = (r: PickRow) => {
    switch (r.kind) {
      case 'all': onPick({ kind: 'all' }, true); break;
      case 'conn': onPick({ kind: 'connection', connectionId: r.conn.id }, true); break;
      case 'db': onPick({ kind: 'database', connectionId: r.cid, database: r.database }, true); break;
      case 'schema': onPick({ kind: 'schema', connectionId: r.cid, database: r.database, schema: r.schema }, true); break;
      case 'object': {
        const same = scope.kind === 'objects' && scope.connectionId === r.cid && (scope.database ?? null) === r.database;
        const list = same ? scope.objects : [];
        const on = objectChecked(scope, r.cid, r.database, r.obj);
        const next = on ? list.filter((x) => !(x.name === r.obj.name && x.schema === r.obj.schema && x.type === r.obj.type)) : [...list, r.obj];
        if (next.length === 0) onPick({ kind: 'schema', connectionId: r.cid, database: r.database, schema: r.obj.schema ?? '' }, false);
        else onPick({ kind: 'objects', connectionId: r.cid, database: r.database, objects: next }, false);
        break;
      }
      default:
        break;
    }
  };

  const expandable = (r: PickRow) => r.kind === 'conn' || r.kind === 'db' || r.kind === 'schema';
  const isOpen = (r: PickRow) => 'expanded' in r && r.expanded;

  const onKeyDown = (e: KeyboardEvent) => {
    const r = rows[activeIdx];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(rows.length - 1, activeIdx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, activeIdx - 1));
    } else if (e.key === 'ArrowRight' && r && expandable(r) && !isOpen(r) && (e.target === listRef.current || !filter)) {
      e.preventDefault();
      toggle(r.key, true);
    } else if (e.key === 'ArrowLeft' && r && expandable(r) && isOpen(r) && (e.target === listRef.current || !filter)) {
      e.preventDefault();
      toggle(r.key, false);
    } else if ((e.key === 'Enter' || (e.key === ' ' && e.target === listRef.current)) && r) {
      e.preventDefault();
      choose(r);
    }
  };

  return (
    <div className="sx-picker" role="dialog" aria-label="Where to search" onKeyDown={onKeyDown}>
      <div className="sx-picker-filter">
        <Search size={13} aria-hidden="true" />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setActive(0); }}
          placeholder="Filter loaded connections, schemas, tables…"
          aria-label="Filter scopes"
          aria-controls="sx-picker-list"
          aria-activedescendant={rows[activeIdx] ? `sx-pick-${activeIdx}` : undefined}
        />
      </div>
      <div className="sx-picker-list" id="sx-picker-list" role="tree" aria-label="Scopes" tabIndex={0} ref={listRef}
        aria-activedescendant={rows[activeIdx] ? `sx-pick-${activeIdx}` : undefined}>
        {rows.map((r, i) => {
          const current = isCurrent(scope, r);
          const checked = r.kind === 'object' && objectChecked(scope, r.cid, r.database, r.obj);
          return (
            <div
              key={r.key}
              id={`sx-pick-${i}`}
              data-index={i}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-selected={current || checked}
              aria-expanded={expandable(r) ? isOpen(r) : undefined}
              className={`sx-pick${i === activeIdx ? ' active' : ''}${current ? ' current' : ''}${r.kind === 'status' ? ' status' : ''}`}
              style={{ paddingLeft: 8 + r.depth * 16 }}
              onMouseEnter={() => setActive(i)}
              onClick={() => r.kind !== 'status' && choose(r)}
            >
              {expandable(r) ? (
                <button
                  type="button"
                  className="sx-chev"
                  tabIndex={-1}
                  aria-label={isOpen(r) ? 'Collapse' : 'Expand'}
                  onClick={(e) => { e.stopPropagation(); toggle(r.key); }}
                >
                  {isOpen(r) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span className="sx-chev-gap" />}
              {r.kind === 'all' && <Globe size={15} className="sx-pick-icon" aria-hidden="true" />}
              {r.kind === 'conn' && <ProviderLogo providerId={r.conn.providerId} size={15} />}
              {r.kind === 'db' && <DatabaseIcon size={15} />}
              {r.kind === 'schema' && <FolderIcon size={15} />}
              {r.kind === 'object' && <input type="checkbox" tabIndex={-1} checked={checked} readOnly aria-hidden="true" className="sx-pick-check" />}
              {r.kind === 'object' && <ObjectIcon type={r.obj.type} size={15} />}
              {r.kind === 'status' && r.loading && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
              <span className="sx-pick-label">
                {r.kind === 'all' ? r.label : r.kind === 'conn' ? r.conn.name : r.kind === 'db' ? r.database : r.kind === 'schema' ? r.schema : r.kind === 'object' ? r.obj.name : r.label}
              </span>
              {r.kind === 'conn' && !r.connected && <span className="sx-pick-muted">not connected</span>}
              {current && <Check size={14} className="sx-pick-tick" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
      <div className="sx-picker-foot">
        <span className="muted">Click to search there · check tables to search only them</span>
        <button type="button" className="btn btn-xs" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** No database row: Oracle (no database level) and SQLite's lone "main" show their schemas directly. */
function isFlat(c: ConnectionProfile, cc: ConnCatalog | undefined): boolean {
  const list = databasesOf(c, cc) ?? [];
  return list.length === 1 && (list[0] === null || c.providerId === 'sqlite');
}

function buildRows(
  connections: ConnectionProfile[], connected: ReadonlySet<string>, conns: Record<string, ConnCatalog>, dbs: Record<string, DbCatalog>,
  expanded: ReadonlySet<string>, filter: string,
): PickRow[] {
  const rows: PickRow[] = [];
  const hit = (s: string) => !filter || s.toLowerCase().includes(filter);
  if (!filter) rows.push({ kind: 'all', key: 'all', depth: 0, label: `All connected connections (${connected.size})` });
  const sorted = [...connections].sort((a, b) => Number(connected.has(b.id)) - Number(connected.has(a.id)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const c of sorted) {
    const ck = `c|${c.id}`;
    const open = expanded.has(ck) || !!filter;
    const sub: PickRow[] = [];
    if (open) addDatabases(sub, c, conns[c.id], dbs, expanded, filter);
    if (filter && !hit(c.name) && !sub.some((r) => r.kind !== 'status')) continue;
    rows.push({ kind: 'conn', key: ck, depth: 0, conn: c, connected: connected.has(c.id), expanded: open });
    rows.push(...sub);
  }
  if (rows.length === 0) rows.push({ kind: 'status', key: 'none', depth: 0, label: filter ? 'Nothing loaded matches' : 'No connections' });
  return rows;
}

function addDatabases(rows: PickRow[], c: ConnectionProfile, cc: ConnCatalog | undefined, dbs: Record<string, DbCatalog>, expanded: ReadonlySet<string>, filter: string) {
  const list = databasesOf(c, cc);
  if (!list) {
    if (cc?.status === 'error') rows.push({ kind: 'status', key: `c|${c.id}#err`, depth: 1, label: cc.error ?? 'Failed to connect' });
    else if (!filter) rows.push({ kind: 'status', key: `c|${c.id}#load`, depth: 1, label: 'Connecting…', loading: true });
    return;
  }
  if (isFlat(c, cc)) {
    addSchemas(rows, c.id, list[0], dbs, expanded, filter, 1);
    return;
  }
  for (const db of list) {
    if (db === null) continue;
    const dk = `d|${c.id}|${db}`;
    const open = expanded.has(dk) || (!!filter && !!dbs[dbKey(c.id, db)]?.schemasResp);
    const sub: PickRow[] = [];
    if (open) addSchemas(sub, c.id, db, dbs, expanded, filter, 2);
    if (filter && !db.toLowerCase().includes(filter) && !sub.some((r) => r.kind !== 'status')) continue;
    rows.push({ kind: 'db', key: dk, depth: 1, cid: c.id, database: db, expanded: open });
    rows.push(...sub);
  }
}

function addSchemas(rows: PickRow[], cid: string, db: string | null, dbs: Record<string, DbCatalog>, expanded: ReadonlySet<string>, filter: string, depth: number) {
  const d = dbs[dbKey(cid, db)];
  const list = d?.schemasResp?.schemas;
  if (!list) {
    if (d?.schemasStatus === 'error') rows.push({ kind: 'status', key: `d|${cid}|${db ?? ''}#err`, depth, label: d.schemasError ?? 'Failed to load schemas' });
    else if (!filter) rows.push({ kind: 'status', key: `d|${cid}|${db ?? ''}#load`, depth, label: 'Loading schemas…', loading: true });
    return;
  }
  for (const s of list) {
    const sk = `s|${cid}|${db ?? ''}|${s.name}`;
    const loaded = d.loaded[s.name];
    const objects = (loaded?.objects ?? []).filter((o) => PICKABLE.has(o.t)).sort((a, b) => a.n.localeCompare(b.n, undefined, { sensitivity: 'base' }));
    const matching = filter ? objects.filter((o) => o.n.toLowerCase().includes(filter)) : objects;
    const open = expanded.has(sk) || (!!filter && matching.length > 0);
    if (filter && !s.name.toLowerCase().includes(filter) && matching.length === 0) continue;
    rows.push({ kind: 'schema', key: sk, depth, cid, database: db, schema: s.name, expanded: open });
    if (!open) continue;
    if (!loaded) {
      rows.push({ kind: 'status', key: `${sk}#load`, depth: depth + 1, label: d.schemaStatus[s.name] === 'error' ? d.schemaError[s.name] ?? 'Failed to load' : 'Loading…', loading: d.schemaStatus[s.name] !== 'error' });
      continue;
    }
    for (const o of matching) {
      rows.push({ kind: 'object', key: `${sk}|${o.t}|${o.n}`, depth: depth + 1, cid, database: db, obj: { schema: s.name, name: o.n, type: o.t } });
    }
    if (matching.length === 0) rows.push({ kind: 'status', key: `${sk}#empty`, depth: depth + 1, label: 'No tables or routines' });
  }
}

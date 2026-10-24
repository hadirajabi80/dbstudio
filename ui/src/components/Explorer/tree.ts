import type { CatalogObject, CatalogObjectType, ConnectionProfile, ObjectRef, ProviderId } from '../../api/types';
import { fuzzyMatchLower } from '../../lib/fuzzy';
import { getSourceModule, sourceNodeId } from '../../lib/sources';
import { dialectOf, hasDatabaseLevel, providerKind } from '../../store/connections';
import { isTabular, objectTypeLabel, OBJECT_TYPE_ORDER } from '../../lib/sql';
import { dbKey, type ConnCatalog, type DbCatalog } from '../../store/catalog';
import type { ConnQueries, SavedQuery } from '../../store/savedQueries';
import type { TypeChip } from './explorerStore';

/** M2: `source` rows belong to a source module (Redis/MongoDB/Kafka, see lib/sources.ts). */
export type NodeKind = 'cfolder' | 'connection' | 'database' | 'schema' | 'folder' | 'object' | 'column' | 'status' | 'source'
  /** A schema's "Queries" folder and the queries saved into it (components/SavedQueries). */
  | 'qfolder' | 'query';

export interface TreeRow {
  id: string;
  kind: NodeKind;
  depth: number;
  label: string;
  detail?: string;
  expandable: boolean;
  expanded: boolean;
  connectionId?: string;
  database?: string | null;
  schema?: string;
  objectType?: CatalogObjectType;
  object?: CatalogObject;
  column?: { name: string; type: string; nullable: boolean; pk: boolean; fk?: boolean };
  status?: 'loading' | 'error' | 'empty' | 'hint' | 'load';
  /** Highlighted label positions when filtering. */
  match?: number[];
  count?: number;
  /** Connection root: catalog is loading (per-root spinner). */
  busy?: boolean;
  /** status 'load': the schema to load when activated. */
  loadSchema?: string;
  /** M2: rows of a source module (kind 'source'): node type ('db', 'key', 'collection', 'topic'...), path from the connection. */
  source?: { providerId: ProviderId; nodeType: string; path: string[]; meta?: unknown };
  /** kind 'query': the saved query. */
  savedQuery?: SavedQuery;
}

export const nodeId = {
  cfolder: (f: string) => `cf:${f}`,
  conn: (cid: string) => `c:${cid}`,
  db: (cid: string, db: string | null) => `d:${cid}:${db ?? ''}`,
  schema: (cid: string, db: string | null, s: string) => `s:${cid}:${db ?? ''}:${s}`,
  folder: (cid: string, db: string | null, s: string, t: CatalogObjectType) => `f:${cid}:${db ?? ''}:${s}:${t}`,
  object: (cid: string, db: string | null, s: string, t: CatalogObjectType, n: string) => `o:${cid}:${db ?? ''}:${s}:${t}:${n}`,
  /** M2: source module rows (lib/sources.ts sourceNodeId). */
  source: sourceNodeId,
  /** A schema's "Queries" folder. */
  queries: (cid: string, db: string | null, s: string) => `q:${cid}:${db ?? ''}:${s}`,
  savedQuery: (cid: string, id: string) => `sq:${cid}:${id}`,
};

/** M2: whether a connection is rendered by a source module instead of the SQL catalog. */
export function isSourceConnection(c: ConnectionProfile): boolean {
  return providerKind(c.providerId) !== 'relational';
}

/** M2: child rows of an expanded non-relational connection, delegated to its source module. */
function addSourceChildren(rows: TreeRow[], input: TreeInput, c: ConnectionProfile, depth: number, parent: string, filter = '') {
  const mod = getSourceModule(c.providerId);
  if (!mod) return status(rows, parent, depth, 'hint', 'Support for this source is not available in this build');
  let children: TreeRow[];
  try {
    children = mod.tree({ connection: c, depth, expanded: input.expanded, filter });
  } catch (e) {
    return status(rows, parent, depth, 'error', e instanceof Error ? e.message : String(e));
  }
  if (children.length === 0 && !filter) return status(rows, parent, depth, 'empty', 'Nothing to show');
  for (const r of children) rows.push(r);
}

/** Chip → object types (1.1.2). */
export const CHIP_TYPES: Record<TypeChip, CatalogObjectType[]> = {
  tables: ['table'],
  views: ['view', 'mview'],
  procs: ['proc', 'package'],
  funcs: ['func', 'tablefunc'],
  other: ['synonym', 'sequence', 'type', 'trigger'],
};

/** Whether the chips show the "Queries" folders (saved queries): no chip (every type), or the Other chip. */
export function queriesShown(chips: readonly TypeChip[]): boolean {
  return !chips.length || chips.includes('other');
}

export function typesOfChips(chips: readonly TypeChip[]): Set<CatalogObjectType> | null {
  if (!chips.length) return null;
  return new Set(chips.flatMap((c) => CHIP_TYPES[c]));
}

export interface TreeInput {
  connections: ConnectionProfile[];
  conns: Record<string, ConnCatalog>;
  dbs: Record<string, DbCatalog>;
  expanded: ReadonlySet<string>;
  /** Folders of connections that are collapsed (they default to expanded). */
  collapsedFolders: ReadonlySet<string>;
  filter: string;
  /** Allowed object types per connection (null = all). */
  typesFor?: (connectionId: string) => Set<CatalogObjectType> | null;
  /** Also match column names ("Customers · Email"). */
  searchColumns?: boolean;
  /**
   * Saved queries per connection: when given, every schema gets a "Queries" folder (and the filter matches query
   * names). Absent = no Queries folders.
   */
  savedQueries?: Record<string, ConnQueries | undefined>;
  /** Whether the type chips show the Queries folders of a connection (default: yes). */
  queriesFor?: (connectionId: string) => boolean;
}

/**
 * Databases shown under a connection; `[null]` when the provider has no database level (Oracle) or none were returned.
 * A list that is being reloaded stays (the store keeps it 'ready' while it revalidates).
 */
export function databasesOf(conn: ConnectionProfile, cat: ConnCatalog | undefined): (string | null)[] | null {
  if (!cat || cat.status === 'error' || !cat.databases) return null;
  if (!hasDatabaseLevel(conn.providerId) && conn.providerId !== 'sqlite') return [null];
  if (cat.databases.databases.length === 0) return [null];
  return cat.databases.databases;
}

/** Whether the database node hides its single schema level. */
export function singleSchema(d: DbCatalog | undefined): string | null {
  const list = d?.schemasResp?.schemas;
  return list && list.length === 1 ? list[0].name : null;
}

function groupObjects(objects: CatalogObject[], types: Set<CatalogObjectType> | null): Map<CatalogObjectType, CatalogObject[]> {
  const m = new Map<CatalogObjectType, CatalogObject[]>();
  for (const o of objects) {
    if (types && !types.has(o.t)) continue;
    let l = m.get(o.t);
    if (!l) m.set(o.t, (l = []));
    l.push(o);
  }
  for (const l of m.values()) l.sort((a, b) => a.n.localeCompare(b.n, undefined, { sensitivity: 'base' }));
  return m;
}

export function buildTree(input: TreeInput): TreeRow[] {
  return input.filter.trim() ? buildFiltered(input) : buildFull(input);
}

function sortedConnections(list: ConnectionProfile[]) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function isBusy(input: TreeInput, cid: string): boolean {
  // An explicit "Refresh catalog" reloads the database list: the root spins (quietly) while its rows stay. Quiet
  // per-schema revalidations (save of an edited object, catalog.changed) show nothing.
  if (input.conns[cid]?.status === 'loading' || input.conns[cid]?.revalidating) return true;
  for (const d of Object.values(input.dbs)) {
    if (d.connectionId !== cid) continue;
    if (d.schemasStatus === 'loading') return true;
    for (const st of Object.values(d.schemaStatus)) if (st === 'loading') return true;
  }
  return false;
}

function buildFull(input: TreeInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const byFolder = new Map<string, ConnectionProfile[]>();
  const loose: ConnectionProfile[] = [];
  for (const c of input.connections) {
    if (c.folder) {
      let l = byFolder.get(c.folder);
      if (!l) byFolder.set(c.folder, (l = []));
      l.push(c);
    } else loose.push(c);
  }
  for (const folder of [...byFolder.keys()].sort()) {
    const id = nodeId.cfolder(folder);
    const open = !input.collapsedFolders.has(folder);
    const list = byFolder.get(folder)!;
    rows.push({ id, kind: 'cfolder', depth: 0, label: folder, expandable: true, expanded: open, count: list.length });
    if (open) for (const c of sortedConnections(list)) addConnection(rows, input, c, 1);
  }
  for (const c of sortedConnections(loose)) addConnection(rows, input, c, 0);
  return rows;
}

function status(rows: TreeRow[], parent: string, depth: number, s: TreeRow['status'], label: string, extra: Partial<TreeRow> = {}) {
  rows.push({ id: `${parent}#${s}${extra.loadSchema ? `:${extra.loadSchema}` : ''}`, kind: 'status', depth, label, expandable: false, expanded: false, status: s, ...extra });
}

function addConnection(rows: TreeRow[], input: TreeInput, c: ConnectionProfile, depth: number) {
  const id = nodeId.conn(c.id);
  const open = input.expanded.has(id);
  const cat = input.conns[c.id];
  rows.push({
    id, kind: 'connection', depth, label: c.name, expandable: true, expanded: open, connectionId: c.id, busy: isBusy(input, c.id),
  });
  if (!open) return;
  if (isSourceConnection(c)) return addSourceChildren(rows, input, c, depth + 1, id);
  // A list that is already shown stays while it reloads (refresh, save): never collapse it into a status row.
  const shown = !!cat?.databases && cat.status !== 'error';
  if (!cat || (!shown && (cat.status === 'loading' || cat.status === 'idle'))) return status(rows, id, depth + 1, 'loading', 'Connecting…');
  if (cat.status === 'error') return status(rows, id, depth + 1, 'error', cat.error ?? 'Failed to connect');
  const dbs = databasesOf(c, cat) ?? [];
  if (dbs.length === 1 && (dbs[0] === null || c.providerId === 'sqlite')) {
    // No database level (Oracle), or SQLite's lone "main": show its schemas/objects directly.
    addSchemas(rows, input, c.id, dbs[0], depth + 1, id);
    return;
  }
  const current = cat.databases?.current ?? null;
  for (const db of dbs) {
    const did = nodeId.db(c.id, db);
    const dOpen = input.expanded.has(did);
    rows.push({
      id: did, kind: 'database', depth: depth + 1, label: db ?? '(default)', expandable: true, expanded: dOpen, connectionId: c.id, database: db,
      detail: db === current && dbs.length > 1 ? 'current' : undefined,
    });
    if (dOpen) addSchemas(rows, input, c.id, db, depth + 2, did);
  }
}

function addSchemas(rows: TreeRow[], input: TreeInput, cid: string, db: string | null, depth: number, parent: string) {
  const d = input.dbs[dbKey(cid, db)];
  // A schema list that is already shown stays while it reloads: only a first load shows "Loading schemas…".
  const shown = !!d?.schemasResp && d.schemasStatus !== 'error';
  if (!d || (!shown && (d.schemasStatus === 'idle' || d.schemasStatus === 'loading'))) return status(rows, parent, depth, 'loading', 'Loading schemas…');
  if (d.schemasStatus === 'error') return status(rows, parent, depth, 'error', d.schemasError ?? 'Failed to load schemas');
  const list = d.schemasResp?.schemas ?? [];
  if (list.length === 0) return status(rows, parent, depth, 'empty', 'No schemas');
  const single = singleSchema(d);
  if (single) {
    addFolders(rows, input, cid, db, single, depth, parent);
    return;
  }
  const def = d.schemasResp?.defaultSchema;
  const sorted = [...list].sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : a.name.localeCompare(b.name)));
  for (const s of sorted) {
    const sid = nodeId.schema(cid, db, s.name);
    const open = input.expanded.has(sid);
    rows.push({
      id: sid, kind: 'schema', depth, label: s.name, expandable: true, expanded: open, connectionId: cid, database: db, schema: s.name,
      detail: s.name === def ? 'default' : undefined, count: d.loaded[s.name]?.objects.length ?? s.objectCount ?? undefined,
    });
    if (open) addFolders(rows, input, cid, db, s.name, depth + 1, sid);
  }
}

function addFolders(rows: TreeRow[], input: TreeInput, cid: string, db: string | null, schema: string, depth: number, parent: string) {
  const d = input.dbs[dbKey(cid, db)];
  const st = d?.schemaStatus[schema];
  const loaded = d?.loaded[schema];
  if (!loaded) {
    if (st === 'error') return status(rows, parent, depth, 'error', d?.schemaError[schema] ?? 'Failed to load objects');
    return status(rows, parent, depth, 'loading', 'Loading objects…');
  }
  const types = input.typesFor?.(cid) ?? null;
  const groups = groupObjects(loaded.objects, types);
  const withQueries = !!input.savedQueries && (input.queriesFor?.(cid) ?? true);
  if (groups.size === 0 && !withQueries) return status(rows, parent, depth, 'empty', types ? 'No objects of the selected types' : 'No objects');
  const dialect = dialectOf(cid);
  for (const t of OBJECT_TYPE_ORDER) {
    const objs = groups.get(t);
    if (!objs) continue;
    const fid = nodeId.folder(cid, db, schema, t);
    const open = input.expanded.has(fid);
    rows.push({
      id: fid, kind: 'folder', depth, label: objectTypeLabel(t, dialect), expandable: true, expanded: open, connectionId: cid, database: db,
      schema, objectType: t, count: objs.length,
    });
    if (!open) continue;
    for (const o of objs) addObject(rows, input, cid, db, schema, o, depth + 1);
  }
  if (withQueries) addQueries(rows, input, cid, db, schema, depth);
}

/** The schema's "Queries" folder (Navicat): the queries saved into it, by name. */
function addQueries(rows: TreeRow[], input: TreeInput, cid: string, db: string | null, schema: string, depth: number) {
  const cq = input.savedQueries?.[cid];
  const list = cq ? cq.items.filter((q) => (q.database ?? '') === (db ?? '') && (q.schema ?? '') === schema) : [];
  const fid = nodeId.queries(cid, db, schema);
  const open = input.expanded.has(fid);
  rows.push({
    id: fid, kind: 'qfolder', depth, label: 'Queries', expandable: true, expanded: open, connectionId: cid, database: db, schema,
    count: list.length || undefined,
  });
  if (!open) return;
  if (!list.length) {
    if (!cq || cq.status === 'loading') return status(rows, fid, depth + 1, 'loading', 'Loading queries…');
    if (cq.status === 'error') return status(rows, fid, depth + 1, 'error', cq.error ?? 'Failed to load the saved queries');
    return status(rows, fid, depth + 1, 'empty', 'No saved queries');
  }
  for (const q of list) rows.push(queryRow(cid, db, schema, q, depth + 1));
}

function queryRow(cid: string, db: string | null, schema: string, q: SavedQuery, depth: number, match?: number[]): TreeRow {
  return {
    id: nodeId.savedQuery(cid, q.id), kind: 'query', depth, label: q.name, expandable: false, expanded: false, connectionId: cid, database: db,
    schema, savedQuery: q, match,
  };
}

function fkColumns(o: CatalogObject): Set<string> {
  const s = new Set<string>();
  for (const fk of o.fk ?? []) for (const c of fk.cols) s.add(c);
  return s;
}

function addObject(
  rows: TreeRow[], input: TreeInput, cid: string, db: string | null, schema: string, o: CatalogObject, depth: number,
  match?: number[], opts: { forceOpen?: boolean; onlyColumns?: Map<string, number[]> } = {},
) {
  const oid = nodeId.object(cid, db, schema, o.t, o.n);
  const hasCols = !!o.c && o.c.length > 0 && (isTabular(o.t) || o.t === 'type');
  const open = hasCols && (opts.forceOpen || input.expanded.has(oid));
  rows.push({
    id: oid, kind: 'object', depth, label: o.n, expandable: hasCols, expanded: open, connectionId: cid, database: db, schema,
    objectType: o.t, object: o, match,
    detail: o.t === 'synonym' && o.target ? `→ ${o.target.s ? `${o.target.s}.` : ''}${o.target.n}` : o.st === 'INVALID' ? 'invalid' : undefined,
  });
  if (!open) return;
  const fks = fkColumns(o);
  for (const c of o.c!) {
    if (c[4] & 4) continue; // hidden
    const cm = opts.onlyColumns?.get(c[0]);
    if (opts.onlyColumns && !cm) continue;
    rows.push({
      id: `${oid}:${c[0]}`, kind: 'column', depth: depth + 1, label: c[0], detail: `${c[1]}${c[2] ? '' : ' not null'}`, expandable: false,
      expanded: false, connectionId: cid, database: db, schema, objectType: o.t, object: o, match: cm,
      column: { name: c[0], type: c[1], nullable: c[2] === 1, pk: c[3] === 1, fk: fks.has(c[0]) },
    });
  }
}

interface Hit {
  db: string | null;
  schema: string;
  o: CatalogObject;
  m: number[] | undefined;
  score: number;
  cols?: Map<string, number[]>;
}

interface QueryHit {
  db: string | null;
  schema: string;
  q: SavedQuery;
  m: number[];
  score: number;
}

const MAX_HITS_PER_CONNECTION = 500;
const MAX_LOAD_HINTS = 4;

/** Filter mode: matching loaded objects (and connections) with their ancestors, all expanded. */
function buildFiltered(input: TreeInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const pattern = input.filter.trim().toLowerCase();
  for (const c of sortedConnections(input.connections)) {
    const connMatch = fuzzyMatchLower(pattern, c.name, c.name.toLowerCase());
    if (isSourceConnection(c)) {
      // M2: the source module filters its own (loaded) rows.
      const sub: TreeRow[] = [];
      const cid = nodeId.conn(c.id);
      if (getSourceModule(c.providerId)) addSourceChildren(sub, input, c, 1, cid, input.filter.trim());
      const hits = sub.filter((r) => r.kind === 'source');
      if (!connMatch && hits.length === 0) continue;
      rows.push({
        id: cid, kind: 'connection', depth: 0, label: c.name, expandable: true, expanded: hits.length > 0, connectionId: c.id,
        match: connMatch?.positions, busy: false, count: hits.length || undefined,
      });
      if (hits.length > 0) for (const r of sub) rows.push(r);
      continue;
    }
    const types = input.typesFor?.(c.id) ?? null;
    const hits: Hit[] = [];
    const unloaded: { db: string | null; schema: string }[] = [];
    for (const d of Object.values(input.dbs)) {
      if (d.connectionId !== c.id) continue;
      for (const s of d.schemasResp?.schemas ?? []) {
        if (!d.loaded[s.name] && d.schemaStatus[s.name] !== 'loading') unloaded.push({ db: d.database, schema: s.name });
      }
      for (const s of Object.values(d.loaded)) {
        for (const o of s.objects) {
          if (types && !types.has(o.t)) continue;
          const m = fuzzyMatchLower(pattern, o.n, o.n.toLowerCase());
          let cols: Map<string, number[]> | undefined;
          let colScore = 0;
          if (input.searchColumns && o.c) {
            for (const col of o.c) {
              if (col[4] & 4) continue;
              const cm = fuzzyMatchLower(pattern, col[0], col[0].toLowerCase());
              if (cm && cm.score > 0) {
                (cols ??= new Map()).set(col[0], cm.positions);
                colScore = Math.max(colScore, cm.score - 50);
              }
            }
          }
          if ((m && m.score > 0) || cols) {
            hits.push({ db: d.database, schema: s.name, o, m: m && m.score > 0 ? m.positions : undefined, score: Math.max(m?.score ?? 0, colScore), cols: m && m.score > 0 ? undefined : cols });
          }
        }
      }
    }
    // Saved queries match by name too (shown after the objects of their schema).
    const qhits: QueryHit[] = [];
    if (input.savedQueries && (input.queriesFor?.(c.id) ?? true)) {
      for (const q of input.savedQueries[c.id]?.items ?? []) {
        const m = fuzzyMatchLower(pattern, q.name, q.name.toLowerCase());
        if (m && m.score > 0) qhits.push({ db: q.database, schema: q.schema ?? '', q, m: m.positions, score: m.score });
      }
    }
    const total = hits.length + qhits.length;
    const hintsNeeded = unloaded.length > 0 && !!input.conns[c.id];
    if (!connMatch && total === 0 && !hintsNeeded) continue;
    if (!connMatch && total === 0 && hintsNeeded && !input.expanded.has(nodeId.conn(c.id))) continue;
    rows.push({
      id: nodeId.conn(c.id), kind: 'connection', depth: 0, label: c.name, expandable: true, expanded: total > 0 || hintsNeeded,
      connectionId: c.id, match: connMatch?.positions, busy: isBusy(input, c.id), count: total || undefined,
    });
    hits.sort((a, b) => b.score - a.score || a.o.n.localeCompare(b.o.n));
    qhits.sort((a, b) => b.score - a.score || a.q.name.localeCompare(b.q.name));
    const groups = new Map<string, { db: string | null; schema: string; objects: Hit[]; queries: QueryHit[] }>();
    const groupOf = (db: string | null, schema: string) => {
      const k = `${db ?? ''}\u0001${schema}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { db, schema, objects: [], queries: [] }));
      return g;
    };
    for (const h of hits.slice(0, MAX_HITS_PER_CONNECTION)) groupOf(h.db, h.schema).objects.push(h);
    for (const h of qhits.slice(0, MAX_HITS_PER_CONNECTION)) groupOf(h.db, h.schema).queries.push(h);
    for (const g of groups.values()) {
      const { db, schema } = g;
      const sid = nodeId.schema(c.id, db, schema);
      rows.push({
        id: sid, kind: 'schema', depth: 1, label: db && db !== schema ? (schema ? `${db} · ${schema}` : db) : schema, expandable: true, expanded: true,
        connectionId: c.id, database: db, schema, count: g.objects.length + g.queries.length,
      });
      for (const h of g.objects) {
        addObject(rows, input, c.id, db, schema, h.o, 2, h.m, h.cols ? { forceOpen: true, onlyColumns: h.cols } : {});
      }
      for (const h of g.queries) rows.push(queryRow(c.id, db, schema, h.q, 2, h.m));
    }
    if (hits.length > MAX_HITS_PER_CONNECTION) {
      status(rows, nodeId.conn(c.id), 1, 'hint', `${(hits.length - MAX_HITS_PER_CONNECTION).toLocaleString()} more — refine the filter`);
    }
    for (const u of unloaded.slice(0, MAX_LOAD_HINTS)) {
      status(rows, nodeId.schema(c.id, u.db, u.schema), 1, 'load', `Load schema ${u.db && u.db !== u.schema ? `${u.db}.` : ''}${u.schema} to search it`, {
        connectionId: c.id, database: u.db, loadSchema: u.schema,
      });
    }
    if (unloaded.length > MAX_LOAD_HINTS) {
      status(rows, nodeId.conn(c.id), 1, 'hint', `${unloaded.length - MAX_LOAD_HINTS} more schemas are not loaded`);
    }
  }
  if (rows.length === 0) {
    rows.push({ id: 'filter#empty', kind: 'status', depth: 0, label: 'No matches in loaded schemas', expandable: false, expanded: false, status: 'hint' });
  }
  return rows;
}

export function refOf(row: TreeRow): ObjectRef | null {
  if (!row.object || !row.objectType) return null;
  return { database: row.database ?? null, schema: row.schema ?? null, name: row.object.n, type: row.objectType };
}

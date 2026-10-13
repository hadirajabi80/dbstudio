import type { CatalogObject, CatalogObjectType, ConnectionProfile, ObjectRef } from '../../api/types';
import { fuzzyMatch } from '../../lib/fuzzy';
import { isTabular, OBJECT_TYPE_LABELS, OBJECT_TYPE_ORDER } from '../../lib/sql';
import { dbKey, type ConnCatalog, type DbCatalog } from '../../store/catalog';

export type NodeKind = 'cfolder' | 'connection' | 'database' | 'schema' | 'folder' | 'object' | 'column' | 'status';

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
  column?: { name: string; type: string; nullable: boolean; pk: boolean };
  status?: 'loading' | 'error' | 'empty' | 'hint';
  /** Highlighted label positions when filtering. */
  match?: number[];
  count?: number;
}

export const nodeId = {
  cfolder: (f: string) => `cf:${f}`,
  conn: (cid: string) => `c:${cid}`,
  db: (cid: string, db: string | null) => `d:${cid}:${db ?? ''}`,
  schema: (cid: string, db: string | null, s: string) => `s:${cid}:${db ?? ''}:${s}`,
  folder: (cid: string, db: string | null, s: string, t: CatalogObjectType) => `f:${cid}:${db ?? ''}:${s}:${t}`,
  object: (cid: string, db: string | null, s: string, t: CatalogObjectType, n: string) => `o:${cid}:${db ?? ''}:${s}:${t}:${n}`,
};

export interface TreeInput {
  connections: ConnectionProfile[];
  conns: Record<string, ConnCatalog>;
  dbs: Record<string, DbCatalog>;
  expanded: ReadonlySet<string>;
  /** Folders of connections that are collapsed (they default to expanded). */
  collapsedFolders: ReadonlySet<string>;
  filter: string;
}

/** Databases shown under a connection; `[null]` when the provider has no database level (Oracle) or none were returned. */
export function databasesOf(conn: ConnectionProfile, cat: ConnCatalog | undefined): (string | null)[] | null {
  if (!cat || cat.status !== 'ready' || !cat.databases) return null;
  if (conn.providerId === 'oracle' || cat.databases.databases.length === 0) return [null];
  return cat.databases.databases;
}

/** Whether the database node hides its single schema level. */
export function singleSchema(d: DbCatalog | undefined): string | null {
  const list = d?.schemasResp?.schemas;
  return list && list.length === 1 ? list[0].name : null;
}

function groupObjects(objects: CatalogObject[]): Map<CatalogObjectType, CatalogObject[]> {
  const m = new Map<CatalogObjectType, CatalogObject[]>();
  for (const o of objects) {
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

function status(rows: TreeRow[], parent: string, depth: number, s: TreeRow['status'], label: string) {
  rows.push({ id: `${parent}#${s}`, kind: 'status', depth, label, expandable: false, expanded: false, status: s });
}

function addConnection(rows: TreeRow[], input: TreeInput, c: ConnectionProfile, depth: number) {
  const id = nodeId.conn(c.id);
  const open = input.expanded.has(id);
  const cat = input.conns[c.id];
  rows.push({
    id, kind: 'connection', depth, label: c.name, expandable: true, expanded: open, connectionId: c.id,
  });
  if (!open) return;
  if (!cat || cat.status === 'loading' || cat.status === 'idle') return status(rows, id, depth + 1, 'loading', 'Connecting…');
  if (cat.status === 'error') return status(rows, id, depth + 1, 'error', cat.error ?? 'Failed to connect');
  const dbs = databasesOf(c, cat) ?? [];
  if (dbs.length === 1 && dbs[0] === null) {
    addSchemas(rows, input, c.id, null, depth + 1, id);
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
  if (!d || d.schemasStatus === 'idle' || d.schemasStatus === 'loading') return status(rows, parent, depth, 'loading', 'Loading schemas…');
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
  const groups = groupObjects(loaded.objects);
  if (groups.size === 0) return status(rows, parent, depth, 'empty', 'No objects');
  for (const t of OBJECT_TYPE_ORDER) {
    const objs = groups.get(t);
    if (!objs) continue;
    const fid = nodeId.folder(cid, db, schema, t);
    const open = input.expanded.has(fid);
    rows.push({
      id: fid, kind: 'folder', depth, label: OBJECT_TYPE_LABELS[t], expandable: true, expanded: open, connectionId: cid, database: db,
      schema, objectType: t, count: objs.length,
    });
    if (!open) continue;
    for (const o of objs) addObject(rows, input, cid, db, schema, o, depth + 1);
  }
}

function addObject(rows: TreeRow[], input: TreeInput, cid: string, db: string | null, schema: string, o: CatalogObject, depth: number, match?: number[]) {
  const oid = nodeId.object(cid, db, schema, o.t, o.n);
  const hasCols = !!o.c && o.c.length > 0 && (isTabular(o.t) || o.t === 'type');
  const open = hasCols && input.expanded.has(oid);
  rows.push({
    id: oid, kind: 'object', depth, label: o.n, expandable: hasCols, expanded: open, connectionId: cid, database: db, schema,
    objectType: o.t, object: o, match,
    detail: o.t === 'synonym' && o.target ? `→ ${o.target.s ? `${o.target.s}.` : ''}${o.target.n}` : o.st === 'INVALID' ? 'invalid' : undefined,
  });
  if (!open) return;
  for (const c of o.c!) {
    if (c[4] & 4) continue; // hidden
    rows.push({
      id: `${oid}:${c[0]}`, kind: 'column', depth: depth + 1, label: c[0], detail: `${c[1]}${c[2] ? '' : ' not null'}`, expandable: false,
      expanded: false, connectionId: cid, database: db, schema, objectType: o.t, object: o,
      column: { name: c[0], type: c[1], nullable: c[2] === 1, pk: c[3] === 1 },
    });
  }
}

/** Filter mode: matching loaded objects (and connections) with their ancestors, all expanded. */
function buildFiltered(input: TreeInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const pattern = input.filter.trim();
  for (const c of sortedConnections(input.connections)) {
    const connMatch = fuzzyMatch(pattern, c.name);
    const hits: { db: string | null; schema: string; o: CatalogObject; m: number[]; score: number }[] = [];
    for (const d of Object.values(input.dbs)) {
      if (d.connectionId !== c.id) continue;
      for (const s of Object.values(d.loaded)) {
        for (const o of s.objects) {
          const m = fuzzyMatch(pattern, o.n);
          if (m && m.score > 0) hits.push({ db: d.database, schema: s.name, o, m: m.positions, score: m.score });
        }
      }
    }
    if (!connMatch && hits.length === 0) continue;
    rows.push({ id: nodeId.conn(c.id), kind: 'connection', depth: 0, label: c.name, expandable: true, expanded: hits.length > 0, connectionId: c.id, match: connMatch?.positions });
    hits.sort((a, b) => b.score - a.score || a.o.n.localeCompare(b.o.n));
    const groups = new Map<string, typeof hits>();
    for (const h of hits.slice(0, 500)) {
      const k = `${h.db ?? ''}\u0001${h.schema}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(h);
    }
    for (const g of groups.values()) {
      const { db, schema } = g[0];
      const sid = nodeId.schema(c.id, db, schema);
      rows.push({
        id: sid, kind: 'schema', depth: 1, label: db && db !== schema ? `${db} · ${schema}` : schema, expandable: true, expanded: true,
        connectionId: c.id, database: db, schema, count: g.length,
      });
      for (const h of g) addObject(rows, input, c.id, db, schema, h.o, 2, h.m);
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

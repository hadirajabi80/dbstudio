// Explorer subtree of a MongoDB connection (docs/PLAN-M2.md 6.2):
//   connection → databases (size) → collections (type icon, estimated count)
// Collections are leaves so Enter / double-click opens them (the explorer toggles containers); Indexes and Validation
// are sub-tabs of the collection tab and context-menu commands. Paths below the connection: [db], [db, coll].
import type { ConnectionProfile } from '../../api/types';
import { fuzzyMatchLower } from '../../lib/fuzzy';
import { sourceNodeId, sourceRow, type SourceTreeInput } from '../../lib/sources';
import type { TreeRow } from '../Explorer/tree';
import { loadCollections, loadDatabases, useMongo } from './store';

export type MongoNodeType = 'database' | 'collection' | 'indexes' | 'validation';

export interface CollectionMeta {
  type: 'collection' | 'view' | 'timeseries';
  count: number | null;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function statusRow(parent: string, depth: number, status: 'loading' | 'error' | 'empty', label: string): TreeRow {
  return { id: `${parent}#${status}`, kind: 'status', depth, label, expandable: false, expanded: false, status };
}

/** Databases shown for a connection: the profile's `database` only, when set. */
function visibleDatabases(connection: ConnectionProfile, names: string[]): string[] {
  const only = typeof connection.props.database === 'string' ? connection.props.database.trim() : '';
  return only ? names.filter((n) => n === only).concat(names.includes(only) ? [] : [only]) : names;
}

export function mongoTree({ connection, depth, expanded, filter }: SourceTreeInput): TreeRow[] {
  const cid = connection.id;
  const state = useMongo.getState().conns[cid];
  const base = { connectionId: cid, providerId: 'mongodb' as const, expanded };
  const rows: TreeRow[] = [];
  const connId = `c:${cid}`;
  const dbs = state?.databases;
  if (!dbs?.data) {
    if (dbs?.error) return [statusRow(connId, depth, 'error', dbs.error)];
    return [statusRow(connId, depth, 'loading', 'Loading databases…')];
  }
  const f = filter.trim().toLowerCase();
  const names = visibleDatabases(connection, dbs.data.map((d) => d.name));
  for (const db of names) {
    const info = dbs.data.find((d) => d.name === db);
    const colls = state.collections[db];
    const dbRow = sourceRow({
      ...base, nodeType: 'database', path: [db], depth, label: db, expandable: true, detail: formatBytes(info?.sizeOnDisk),
      count: colls?.data?.length, forceOpen: !!f,
    });
    if (f) {
      // filter mode: databases whose name or collections match, with their matching collections
      const dbMatch = fuzzyMatchLower(f, db, db.toLowerCase())?.positions;
      const hits = (colls?.data ?? []).map((c) => ({ c, m: fuzzyMatchLower(f, c.name, c.name.toLowerCase())?.positions })).filter((x) => x.m);
      if (!dbMatch && !hits.length) continue;
      rows.push({ ...dbRow, match: dbMatch ?? undefined });
      for (const { c, m } of hits) rows.push(collectionRow(base, db, c.name, c.type, c.count ?? null, depth + 1, m ?? undefined));
      continue;
    }
    rows.push(dbRow);
    if (!dbRow.expanded) continue;
    if (!colls?.data) {
      rows.push(statusRow(dbRow.id, depth + 1, colls?.error ? 'error' : 'loading', colls?.error ?? 'Loading collections…'));
      continue;
    }
    if (!colls.data.length) rows.push(statusRow(dbRow.id, depth + 1, 'empty', 'No collections'));
    for (const c of colls.data) {
      rows.push(collectionRow(base, db, c.name, c.type, c.count ?? null, depth + 1));
    }
  }
  if (!rows.length && !f) rows.push(statusRow(connId, depth, 'empty', 'No databases'));
  return rows;
}

function collectionRow(base: { connectionId: string; providerId: 'mongodb'; expanded: ReadonlySet<string> }, db: string, coll: string,
  type: CollectionMeta['type'], count: number | null, depth: number, match?: number[]): TreeRow {
  return sourceRow({
    ...base, nodeType: 'collection', path: [db, coll], depth, label: coll, expandable: false, detail: type === 'view' ? 'view' : formatCount(count),
    meta: { type, count } satisfies CollectionMeta, match,
  });
}

/** Explorer lazy loads: databases when the connection opens, collections when a database opens. */
export function ensureMongoLoaded(connection: ConnectionProfile, expanded: ReadonlySet<string>): void {
  const cid = connection.id;
  if (!expanded.has(`c:${cid}`)) return;
  const state = useMongo.getState().conns[cid];
  if (!state?.databases.data && !state?.databases.loading && !state?.databases.error) void loadDatabases(cid);
  for (const db of state?.databases.data?.map((d) => d.name) ?? []) {
    if (expanded.has(sourceNodeId(cid, [db])) && !state?.collections[db]) void loadCollections(cid, db);
  }
}

// Go-to-object index (A3): every loaded object of every open connection, built incrementally from the catalog
// store (entries are cached per CatalogSchema identity, so a refresh of one schema re-indexes only that schema).
// Search is a lower-cased subsequence pre-check plus fuzzy scoring: < 30 ms for 50k objects (objectIndex.test.ts).
import type { CatalogObjectType, CatalogSchema, ObjectRef } from '../../api/types';
import { fuzzyMatchLower, type FuzzyResult } from '../../lib/fuzzy';
import type { DbCatalog } from '../../store/catalog';

export interface IndexEntry {
  /** Object name (or "Table.Column" for column entries). */
  name: string;
  lower: string;
  type: CatalogObjectType | 'column';
  connectionId: string;
  database: string | null;
  schema: string;
  /** The object the entry opens (the table for a column entry). */
  ref: ObjectRef;
  column?: string;
}

export interface SearchHit {
  entry: IndexEntry;
  match: FuzzyResult;
}

/** Type prefixes: `t:` tables, `v:` views, `p:` procedures, `f:` functions, `c:` columns. */
export const TYPE_PREFIXES: Record<string, (t: IndexEntry['type']) => boolean> = {
  t: (t) => t === 'table',
  v: (t) => t === 'view' || t === 'mview',
  p: (t) => t === 'proc' || t === 'package',
  f: (t) => t === 'func' || t === 'tablefunc',
  c: (t) => t === 'column',
};

const objectCache = new WeakMap<CatalogSchema, IndexEntry[]>();
const columnCache = new WeakMap<CatalogSchema, IndexEntry[]>();

function schemaEntries(d: DbCatalog, s: CatalogSchema): IndexEntry[] {
  let list = objectCache.get(s);
  if (list) return list;
  list = s.objects.map((o) => ({
    name: o.n, lower: o.n.toLowerCase(), type: o.t, connectionId: d.connectionId, database: d.database, schema: s.name,
    ref: { database: d.database, schema: s.name, name: o.n, type: o.t },
  }));
  objectCache.set(s, list);
  return list;
}

function columnEntries(d: DbCatalog, s: CatalogSchema): IndexEntry[] {
  let list = columnCache.get(s);
  if (list) return list;
  list = [];
  for (const o of s.objects) {
    if (!o.c) continue;
    for (const c of o.c) {
      if (c[4] & 4) continue;
      const name = `${o.n}.${c[0]}`;
      list.push({
        name, lower: name.toLowerCase(), type: 'column', connectionId: d.connectionId, database: d.database, schema: s.name,
        ref: { database: d.database, schema: s.name, name: o.n, type: o.t }, column: c[0],
      });
    }
  }
  columnCache.set(s, list);
  return list;
}

/** Flattened entry arrays (one per loaded schema). Cheap: only cached arrays are collected. */
export function collectEntries(dbs: Record<string, DbCatalog>, withColumns: boolean): IndexEntry[][] {
  const out: IndexEntry[][] = [];
  for (const d of Object.values(dbs)) {
    for (const s of Object.values(d.loaded)) {
      out.push(schemaEntries(d, s));
      if (withColumns) out.push(columnEntries(d, s));
    }
  }
  return out;
}

export interface ParsedQuery {
  prefix: string | null;
  pattern: string;
}

export function parseObjectQuery(q: string): ParsedQuery {
  const m = /^\s*([tvpfc]):\s*(.*)$/i.exec(q);
  if (m) return { prefix: m[1].toLowerCase(), pattern: m[2].trim() };
  return { prefix: null, pattern: q.trim() };
}

/** Best `limit` hits for `query` over the index. */
export function searchObjects(groups: IndexEntry[][], query: string, limit = 200): SearchHit[] {
  const { prefix, pattern } = parseObjectQuery(query);
  const filter = prefix ? TYPE_PREFIXES[prefix] : null;
  const p = pattern.toLowerCase();
  let hits: SearchHit[] = [];
  const EMPTY: FuzzyResult = { score: 0, positions: [] };
  outer: for (const g of groups) {
    for (let i = 0; i < g.length; i++) {
      const e = g[i];
      if (filter ? !filter(e.type) : e.type === 'column') continue;
      if (!p) {
        hits.push({ entry: e, match: EMPTY });
        if (hits.length >= limit) break outer;
        continue;
      }
      const m = fuzzyMatchLower(p, e.name, e.lower);
      if (m) hits.push({ entry: e, match: m });
    }
  }
  if (!p) return hits.sort((a, b) => (a.entry.lower < b.entry.lower ? -1 : a.entry.lower > b.entry.lower ? 1 : 0));
  if (hits.length > limit * 4) {
    // Score threshold of the top `limit` via a typed-array sort (much cheaper than sorting the objects).
    const scores = new Float64Array(hits.length);
    for (let i = 0; i < hits.length; i++) scores[i] = hits[i].match.score;
    scores.sort();
    const threshold = scores[scores.length - limit];
    hits = hits.filter((h) => h.match.score >= threshold);
  }
  hits.sort((a, b) => b.match.score - a.match.score || a.entry.name.length - b.entry.name.length);
  return hits.slice(0, limit);
}

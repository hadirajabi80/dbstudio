// Find in database (Ctrl+Shift+F): the scope, the request and the result tree, as pure functions (no stores, no React).
import type { CatalogObjectType } from '../../api/types';
import type { SearchErrorItem, SearchHitItem, SearchRequestParams, SearchTargetParams } from '../../api/types.search';
import type { CommandTarget } from '../../commands/types';

export const SEARCH_VIEW = 'search';
/** One Search tab: opening it again (Ctrl+Shift+F) reuses it with the new scope. */
export const SEARCH_TAB_KEY = 'search';

export interface ScopeObject {
  schema: string | null;
  name: string;
  type: CatalogObjectType;
}

/** Where to search. "all" = every connected relational connection. */
export type SearchScope =
  | { kind: 'all' }
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string }
  | { kind: 'schema'; connectionId: string; database: string | null; schema: string }
  | { kind: 'objects'; connectionId: string; database: string | null; objects: ScopeObject[] };

/** Object type filter chips (the explorer's groups). */
export type TypeChip = 'tables' | 'views' | 'procs' | 'funcs' | 'other';
export const TYPE_CHIPS: { id: TypeChip; label: string }[] = [
  { id: 'tables', label: 'Tables' },
  { id: 'views', label: 'Views' },
  { id: 'procs', label: 'Procedures' },
  { id: 'funcs', label: 'Functions' },
  { id: 'other', label: 'Other' },
];
export const CHIP_TYPES: Record<TypeChip, CatalogObjectType[]> = {
  tables: ['table'],
  views: ['view', 'mview'],
  procs: ['proc', 'package'],
  funcs: ['func', 'tablefunc'],
  other: ['synonym', 'sequence', 'type', 'trigger'],
};

export function chipOfType(t: CatalogObjectType): TypeChip {
  for (const c of TYPE_CHIPS) if (CHIP_TYPES[c.id].includes(t)) return c.id;
  return 'other';
}

export interface SearchOptions {
  term: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  names: boolean;
  columns: boolean;
  code: boolean;
  data: boolean;
  /** Empty = every type. */
  types: TypeChip[];
  /** Rows read per table by a data search. */
  rowLimit: number;
}

export const DEFAULT_OPTIONS: SearchOptions = {
  term: '', matchCase: false, wholeWord: false, regex: false, names: true, columns: true, code: true, data: false, types: [], rowLimit: 20,
};

export const MAX_ROW_LIMIT = 1000;

/** Serializable state of the Search tab (persisted with the workspace; results are not). */
export interface SearchTabState extends SearchOptions {
  scope: SearchScope;
  /** Connection of the tab that was active when the search opened ("only this connection" offer). */
  consoleConnectionId: string | null;
  /** Changes on every Ctrl+Shift+F: the view focuses and selects the search box. */
  nonce: number;
}

/**
 * The scope (and type filter) of an explorer node: a connection, a database, a schema, a type folder (schema + types),
 * or objects (a table: its name, columns and data; several selected objects). Null for nodes that cannot be searched
 * (Redis, MongoDB and Kafka connections, folders of connections).
 */
export function scopeFromTarget(t: CommandTarget | null | undefined, relational: (connectionId: string) => boolean): { scope: SearchScope; types?: TypeChip[] } | null {
  if (!t || !('connectionId' in t) || !relational(t.connectionId)) return null;
  switch (t.kind) {
    case 'connection':
      return { scope: { kind: 'connection', connectionId: t.connectionId } };
    case 'container': {
      if (t.schema) {
        const scope: SearchScope = { kind: 'schema', connectionId: t.connectionId, database: t.database, schema: t.schema };
        return t.objectType ? { scope, types: [chipOfType(t.objectType)] } : { scope };
      }
      return t.database ? { scope: { kind: 'database', connectionId: t.connectionId, database: t.database } } : { scope: { kind: 'connection', connectionId: t.connectionId } };
    }
    case 'object': {
      const refs = t.refs?.length ? t.refs : [t.ref];
      return {
        scope: { kind: 'objects', connectionId: t.connectionId, database: t.database, objects: refs.map((r) => ({ schema: r.schema, name: r.name, type: r.type })) },
      };
    }
    default:
      return null;
  }
}

export function scopeConnection(scope: SearchScope): string | null {
  return scope.kind === 'all' ? null : scope.connectionId;
}

/** Table data is searched only in a schema or in chosen objects (it reads every text column of every table). */
export function dataAllowed(scope: SearchScope): boolean {
  return scope.kind === 'schema' || scope.kind === 'objects';
}

export function sameScope(a: SearchScope, b: SearchScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function scopeTargets(scope: SearchScope, connected: readonly string[]): SearchTargetParams[] {
  switch (scope.kind) {
    case 'all':
      return connected.map((connectionId) => ({ connectionId }));
    case 'connection':
      return [{ connectionId: scope.connectionId }];
    case 'database':
      return [{ connectionId: scope.connectionId, database: scope.database }];
    case 'schema':
      return [{ connectionId: scope.connectionId, database: scope.database, schema: scope.schema }];
    case 'objects':
      return [{ connectionId: scope.connectionId, database: scope.database, objects: scope.objects }];
  }
}

/** The stream params of a search, or a sentence saying why it cannot run. */
export function buildRequest(scope: SearchScope, o: SearchOptions, connected: readonly string[]): SearchRequestParams | { error: string } {
  // A regex is validated by the engine (.NET syntax, which differs from JavaScript's in places).
  if (!o.term.trim()) return { error: 'Type something to search for.' };
  const data = o.data && dataAllowed(scope);
  if (!o.names && !o.columns && !o.code && !data) return { error: 'Choose what to search in.' };
  const targets = scopeTargets(scope, connected);
  if (targets.length === 0) return { error: 'No connection is connected. Connect one in the explorer, or choose a connection to search.' };
  const types = o.types.length ? [...new Set(o.types.flatMap((c) => CHIP_TYPES[c]))] : null;
  return {
    term: o.term,
    matchCase: o.matchCase,
    wholeWord: o.wholeWord,
    regex: o.regex,
    in: { names: o.names, columns: o.columns, code: o.code, data },
    types,
    targets,
    dataRowLimit: Math.min(MAX_ROW_LIMIT, Math.max(1, Math.round(o.rowLimit) || DEFAULT_OPTIONS.rowLimit)),
  };
}

/** "All connections", "Shop", "Shop › Sales", "Shop › Sales › dbo", "Shop › dbo.Customers", "Shop › 3 objects in dbo". */
export function scopeLabel(scope: SearchScope, nameOf: (connectionId: string) => string, showDatabase: (connectionId: string) => boolean = () => true): string {
  if (scope.kind === 'all') return 'All connections';
  const conn = nameOf(scope.connectionId);
  const db = 'database' in scope && scope.database && showDatabase(scope.connectionId) ? ` › ${scope.database}` : '';
  switch (scope.kind) {
    case 'connection':
      return conn;
    case 'database':
      return `${conn} › ${scope.database}`;
    case 'schema':
      return `${conn}${db} › ${scope.schema}`;
    case 'objects': {
      if (scope.objects.length === 1) {
        const o = scope.objects[0];
        return `${conn}${db} › ${o.schema ? `${o.schema}.` : ''}${o.name}`;
      }
      const schemas = [...new Set(scope.objects.map((o) => o.schema ?? ''))];
      return `${conn}${db} › ${scope.objects.length} objects${schemas.length === 1 && schemas[0] ? ` in ${schemas[0]}` : ''}`;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- results

export interface ObjectGroup {
  key: string;
  connectionId: string;
  database: string | null;
  schema: string | null;
  name: string;
  type: CatalogObjectType;
  /** The name match (highlighted on the object row itself). */
  nameHit: SearchHitItem | null;
  /** Column, code and data matches, in display order. */
  hits: SearchHitItem[];
  counts: { column: number; code: number; data: number };
}

export interface SchemaGroup {
  key: string;
  connectionId: string;
  database: string | null;
  schema: string | null;
  label: string;
  objects: ObjectGroup[];
  count: number;
}

export interface ConnGroup {
  key: string;
  connectionId: string;
  schemas: SchemaGroup[];
  errors: SearchErrorItem[];
  count: number;
}

const KIND_ORDER: Record<string, number> = { column: 0, code: 1, data: 2 };

/** Matches (code: a "more" summary counts its lines). */
function weight(h: SearchHitItem): number {
  return h.match === 'code' && !h.line ? h.more : 1;
}

export interface GroupOptions {
  /** Display name of a connection (groups are sorted by it). */
  nameOf: (connectionId: string) => string;
  /** False for connections without a database level worth showing (SQLite's "main"). */
  showDatabase?: (connectionId: string) => boolean;
}

/** connection › database/schema › object › matches. */
export function groupHits(hits: readonly SearchHitItem[], errors: readonly SearchErrorItem[], opts: GroupOptions): ConnGroup[] {
  const conns = new Map<string, ConnGroup>();
  const schemas = new Map<string, SchemaGroup>();
  const objects = new Map<string, ObjectGroup>();
  const conn = (cid: string) => {
    let c = conns.get(cid);
    if (!c) conns.set(cid, (c = { key: `c|${cid}`, connectionId: cid, schemas: [], errors: [], count: 0 }));
    return c;
  };
  for (const h of hits) {
    const c = conn(h.connectionId);
    const sk = `s|${h.connectionId}|${h.database ?? ''}|${h.schema ?? ''}`;
    let s = schemas.get(sk);
    if (!s) {
      const db = h.database && (opts.showDatabase?.(h.connectionId) ?? true) && h.database !== h.schema ? h.database : null;
      s = { key: sk, connectionId: h.connectionId, database: h.database, schema: h.schema, label: [db, h.schema].filter(Boolean).join(' › ') || '(default)', objects: [], count: 0 };
      schemas.set(sk, s);
      c.schemas.push(s);
    }
    const ok = `o|${h.connectionId}|${h.database ?? ''}|${h.schema ?? ''}|${h.object.type}|${h.object.name}`;
    let o = objects.get(ok);
    if (!o) {
      o = {
        key: ok, connectionId: h.connectionId, database: h.database, schema: h.schema, name: h.object.name, type: h.object.type, nameHit: null, hits: [],
        counts: { column: 0, code: 0, data: 0 },
      };
      objects.set(ok, o);
      s.objects.push(o);
    }
    const w = weight(h);
    if (h.match === 'name') o.nameHit = h;
    else {
      o.hits.push(h);
      o.counts[h.match] += w;
    }
    s.count += w;
    c.count += w;
  }
  for (const e of errors) conn(e.connectionId).errors.push(e);

  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const list = [...conns.values()].sort((a, b) => byName(opts.nameOf(a.connectionId), opts.nameOf(b.connectionId)));
  for (const c of list) {
    c.schemas.sort((a, b) => byName(a.label, b.label));
    for (const s of c.schemas) {
      s.objects.sort((a, b) => byName(a.name, b.name) || byName(a.type, b.type));
      for (const o of s.objects) {
        o.hits.sort((a, b) => {
          const k = KIND_ORDER[a.match] - KIND_ORDER[b.match];
          if (k) return k;
          if (a.match === 'column') return byName(a.text, b.text);
          if (a.match === 'code') return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
          return 0;
        });
      }
    }
  }
  return list;
}

export interface ResultTotals {
  matches: number;
  objects: number;
  connections: number;
}

export function totals(groups: readonly ConnGroup[]): ResultTotals {
  let matches = 0;
  let objects = 0;
  let connections = 0;
  for (const c of groups) {
    if (c.count) connections++;
    matches += c.count;
    for (const s of c.schemas) objects += s.objects.length;
  }
  return { matches, objects, connections };
}

export type ResultRow =
  | { kind: 'conn'; key: string; depth: 0; group: ConnGroup; expanded: boolean }
  | { kind: 'schema'; key: string; depth: 1; group: SchemaGroup; expanded: boolean; parent: string }
  | { kind: 'object'; key: string; depth: 2; group: ObjectGroup; expanded: boolean; expandable: boolean; parent: string }
  | { kind: 'hit'; key: string; depth: 3; hit: SearchHitItem; object: ObjectGroup; parent: string }
  | { kind: 'error'; key: string; depth: 1; error: SearchErrorItem; parent: string };

/** The visible rows: every group is expanded unless its key is in `collapsed`. */
export function flattenGroups(groups: readonly ConnGroup[], collapsed: ReadonlySet<string>): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const c of groups) {
    const cOpen = !collapsed.has(c.key);
    rows.push({ kind: 'conn', key: c.key, depth: 0, group: c, expanded: cOpen });
    if (!cOpen) continue;
    c.errors.forEach((e, i) => rows.push({ kind: 'error', key: `e|${c.connectionId}|${i}`, depth: 1, error: e, parent: c.key }));
    for (const s of c.schemas) {
      const sOpen = !collapsed.has(s.key);
      rows.push({ kind: 'schema', key: s.key, depth: 1, group: s, expanded: sOpen, parent: c.key });
      if (!sOpen) continue;
      for (const o of s.objects) {
        const expandable = o.hits.length > 0;
        const oOpen = expandable && !collapsed.has(o.key);
        rows.push({ kind: 'object', key: o.key, depth: 2, group: o, expanded: oOpen, expandable, parent: s.key });
        if (!oOpen) continue;
        o.hits.forEach((h, i) => rows.push({ kind: 'hit', key: `${o.key}|${i}`, depth: 3, hit: h, object: o, parent: o.key }));
      }
    }
  }
  return rows;
}

/** Text split into plain and matched parts for highlighting. */
export function segments(text: string, ranges: readonly (readonly [number, number])[] | null | undefined): { text: string; hit: boolean }[] {
  if (!ranges?.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, length] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at || length <= 0 || start >= text.length) continue;
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, start + length), hit: true });
    at = start + length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The matched text of a hit (opening a data hit without a key filters on it; a code hit reveals it). */
export function matchedText(h: Pick<SearchHitItem, 'text' | 'ranges'>): string | null {
  const r = h.ranges?.[0];
  return r ? h.text.slice(r[0], r[0] + r[1]) : null;
}

/** "Id = 7, Line = 2". */
export function keyLabel(key: SearchHitItem['key']): string {
  return (key ?? []).map((k) => `${k.column} = ${k.value === null ? 'NULL' : String(k.value)}`).join(', ');
}

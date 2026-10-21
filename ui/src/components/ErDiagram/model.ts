// ER diagram model (docs/PLAN-M2.md section 3): the graph of one diagram built from the catalog snapshot only
// (CatalogObject c / pk / fk), so it works the same for tsql, plsql, sqlite and pgsql catalogs, plus the card geometry
// that both the renderer and the edge router use (rows are fixed-height, so an edge anchors at its column row without
// measuring the DOM).
import type { CatalogForeignKey, CatalogObject, CatalogSchema, DiagramScope, DiagramViewOptions } from '../../api/types';

export type ErObjectType = 'table' | 'view' | 'mview';
const TABULAR = new Set<string>(['table', 'view', 'mview']);

export interface ErColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: boolean;
}

export interface ErNode {
  /** `schema.table` (the layout key). */
  key: string;
  schema: string;
  name: string;
  type: ErObjectType;
  /** Card title: the bare name in the diagram's main schema, `schema.name` elsewhere. */
  label: string;
  columns: ErColumn[];
  pk: string[];
  fks: CatalogForeignKey[];
  comment: string | null;
  /** Not part of the diagram: drawn greyed because a diagram table references it (or is referenced by it). */
  ghost: boolean;
  /** Ghost whose schema is not loaded: only the name is known. */
  unresolved?: boolean;
}

export interface ErEdge {
  id: string;
  /** Referencing table (the many side). */
  from: string;
  /** Referenced table (the one side). */
  to: string;
  name: string;
  cols: string[];
  rcols: string[];
  /** Every FK column is nullable: the relationship is optional (dashed). */
  optional: boolean;
  self: boolean;
  /** One end is a ghost card. */
  ghost: boolean;
}

export interface DiagramModel {
  nodes: ErNode[];
  byKey: Map<string, ErNode>;
  edges: ErEdge[];
  /** Diagram members (not ghosts), in model order. */
  memberCount: number;
  mainSchema: string | null;
}

export type ColumnMode = NonNullable<DiagramViewOptions['columns']>;

export interface ModelInput {
  schemas: readonly CatalogSchema[];
  defaultSchema: string | null;
  scope: DiagramScope;
  added?: readonly string[] | null;
  hidden?: readonly string[] | null;
  hideViews?: boolean;
  onlyConnected?: boolean;
}

export const tableKey = (schema: string | null | undefined, name: string) => `${schema ?? ''}.${name}`;

/** Splits a `schema.table` key (the schema never contains a dot in the supported catalogs; the table may). */
export function splitKey(key: string): { schema: string; name: string } {
  const i = key.indexOf('.');
  return i < 0 ? { schema: '', name: key } : { schema: key.slice(0, i), name: key.slice(i + 1) };
}

interface Universe {
  objects: Map<string, { schema: string; o: CatalogObject }>;
  lower: Map<string, string>;
  /** Lower-cased table name → keys (SQLite REFERENCES without schema, case-insensitive names). */
  byName: Map<string, string[]>;
}

function universeOf(schemas: readonly CatalogSchema[]): Universe {
  const objects = new Map<string, { schema: string; o: CatalogObject }>();
  const lower = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const s of schemas) {
    for (const o of s.objects) {
      if (!TABULAR.has(o.t)) continue;
      const key = tableKey(s.name, o.n);
      objects.set(key, { schema: s.name, o });
      if (!lower.has(key.toLowerCase())) lower.set(key.toLowerCase(), key);
      const n = o.n.toLowerCase();
      byName.set(n, [...(byName.get(n) ?? []), key]);
    }
  }
  return { objects, lower, byName };
}

/** Key of the table an FK references: exact `schema.table`, then case-insensitive, else the unresolved name. */
function resolveRef(u: Universe, fromSchema: string, fk: CatalogForeignKey): { key: string; known: boolean } {
  const schema = fk.rs ?? fromSchema;
  const exact = tableKey(schema, fk.rt);
  if (u.objects.has(exact)) return { key: exact, known: true };
  const ci = u.lower.get(exact.toLowerCase());
  if (ci) return { key: ci, known: true };
  if (!fk.rs) {
    const same = u.byName.get(fk.rt.toLowerCase());
    if (same?.length) return { key: same.find((k) => splitKey(k).schema === fromSchema) ?? same[0], known: true };
  }
  return { key: exact, known: false };
}

function nodeOf(key: string, schema: string, o: CatalogObject, mainSchema: string | null, ghost: boolean): ErNode {
  const fkCols = new Set((o.fk ?? []).flatMap((f) => f.cols));
  const pk = o.pk ?? (o.c ?? []).filter((c) => c[3] === 1).map((c) => c[0]);
  const pkSet = new Set(pk);
  return {
    key, schema, name: o.n, type: o.t as ErObjectType, label: schema === mainSchema ? o.n : `${schema}.${o.n}`,
    columns: (o.c ?? []).filter((c) => !(c[4] & 4)).map((c) => ({ name: c[0], type: c[1], nullable: c[2] === 1, pk: pkSet.has(c[0]) || c[3] === 1, fk: fkCols.has(c[0]) })),
    pk, fks: o.fk ?? [], comment: o.cm ?? null, ghost,
  };
}

/** Schemas whose catalog a scope needs (the scope schema, the schemas of its tables and added tables). */
export function schemasOfScope(scope: DiagramScope, added: readonly string[] = []): string[] {
  const out = new Set<string>();
  if (scope.schema) out.add(scope.schema);
  for (const t of [...(scope.tables ?? []), ...added]) out.add(splitKey(t).schema);
  return [...out].filter(Boolean);
}

/**
 * The diagram graph: members are the scope's tables (a schema's tabular objects, or the listed tables) plus `added`,
 * minus `hidden` (and views / unconnected tables when filtered). Every FK between a member and a non-member that is
 * not hidden adds that table as a ghost card (cross-schema references, the next hop of a "related" diagram).
 */
export function buildModel(input: ModelInput): DiagramModel {
  const u = universeOf(input.schemas);
  const hidden = new Set(input.hidden ?? []);
  const mainSchema = input.scope.schema ?? (input.scope.tables?.length ? splitKey(input.scope.tables[0]).schema : input.defaultSchema);
  const memberKeys: string[] = [];
  const seen = new Set<string>();
  const addMember = (key: string) => {
    const k = u.objects.has(key) ? key : u.lower.get(key.toLowerCase());
    if (!k || seen.has(k) || hidden.has(k)) return;
    const { o } = u.objects.get(k)!;
    if (input.hideViews && o.t !== 'table') return;
    seen.add(k);
    memberKeys.push(k);
  };
  if (input.scope.schema) {
    const s = input.schemas.find((x) => x.name === input.scope.schema);
    for (const o of s?.objects ?? []) if (TABULAR.has(o.t)) addMember(tableKey(s!.name, o.n));
  }
  for (const t of input.scope.tables ?? []) addMember(t);
  for (const t of input.added ?? []) addMember(t);

  const members = new Set(memberKeys);
  const byKey = new Map<string, ErNode>();
  for (const k of memberKeys) {
    const { schema, o } = u.objects.get(k)!;
    byKey.set(k, nodeOf(k, schema, o, mainSchema, false));
  }

  const edges: ErEdge[] = [];
  const ghosts = new Map<string, ErNode>();
  const ghost = (key: string, known: boolean, fallback?: { schema: string; name: string }) => {
    if (byKey.has(key) || ghosts.has(key)) return;
    if (known) {
      const { schema, o } = u.objects.get(key)!;
      ghosts.set(key, nodeOf(key, schema, o, mainSchema, true));
    } else {
      const { schema, name } = fallback ?? splitKey(key);
      ghosts.set(key, { key, schema, name, type: 'table', label: schema === mainSchema ? name : `${schema}.${name}`, columns: [], pk: [], fks: [], comment: null, ghost: true, unresolved: true });
    }
  };
  const edgeIds = new Set<string>();
  const pushEdge = (fromKey: string, toKey: string, fk: CatalogForeignKey, fromCols: ErColumn[], ghostEdge: boolean) => {
    const id = `${fromKey}|${fk.n}|${toKey}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    const colInfo = new Map(fromCols.map((c) => [c.name, c]));
    const optional = fk.cols.length > 0 && fk.cols.every((c) => colInfo.get(c)?.nullable ?? false);
    edges.push({ id, from: fromKey, to: toKey, name: fk.n, cols: fk.cols, rcols: fk.rcols, optional, self: fromKey === toKey, ghost: ghostEdge });
  };

  // outgoing FKs of members
  for (const k of memberKeys) {
    const n = byKey.get(k)!;
    for (const fk of n.fks) {
      const ref = resolveRef(u, n.schema, fk);
      if (hidden.has(ref.key)) continue;
      if (members.has(ref.key)) pushEdge(k, ref.key, fk, n.columns, false);
      else {
        ghost(ref.key, ref.known, { schema: fk.rs ?? n.schema, name: fk.rt });
        pushEdge(k, ref.key, fk, n.columns, true);
      }
    }
  }
  // incoming FKs from loaded non-members (other schemas, the next hop)
  for (const [k, { schema, o }] of u.objects) {
    if (members.has(k) || hidden.has(k) || !o.fk?.length) continue;
    for (const fk of o.fk) {
      const ref = resolveRef(u, schema, fk);
      if (!members.has(ref.key)) continue;
      ghost(k, true);
      const g = ghosts.get(k)!;
      pushEdge(k, ref.key, fk, g.columns, true);
    }
  }

  let nodes = [...byKey.values()];
  if (input.onlyConnected) {
    const linked = new Set(edges.filter((e) => !e.self).flatMap((e) => [e.from, e.to]));
    nodes = nodes.filter((n) => linked.has(n.key));
  }
  const kept = new Set(nodes.map((n) => n.key));
  const ghostList = [...ghosts.values()].filter((g) => edges.some((e) => (e.from === g.key && kept.has(e.to)) || (e.to === g.key && kept.has(e.from))));
  const all = [...nodes, ...ghostList];
  const finalKeys = new Set(all.map((n) => n.key));
  return {
    nodes: all,
    byKey: new Map(all.map((n) => [n.key, n])),
    edges: edges.filter((e) => finalKeys.has(e.from) && finalKeys.has(e.to)),
    memberCount: nodes.length,
    mainSchema,
  };
}

/** Tables one FK hop away from `key` (both directions) in the loaded schemas, `key` first. */
export function relatedTables(schemas: readonly CatalogSchema[], key: string, extraIncoming: readonly string[] = []): string[] {
  const u = universeOf(schemas);
  const root = u.objects.has(key) ? key : u.lower.get(key.toLowerCase()) ?? key;
  const out = new Set<string>([root]);
  const self = u.objects.get(root);
  for (const fk of self?.o.fk ?? []) out.add(resolveRef(u, self!.schema, fk).key);
  for (const [k, { schema, o }] of u.objects) {
    for (const fk of o.fk ?? []) if (resolveRef(u, schema, fk).key === root) out.add(k);
  }
  for (const k of extraIncoming) out.add(k);
  return [...out];
}

// ---------------------------------------------------------------- card geometry

export const CARD = {
  headerH: 34,
  rowH: 22,
  padY: 4,
  minW: 184,
  maxW: 340,
  maxRows: 25,
  ghostW: 168,
} as const;

export interface CardRow {
  col: ErColumn;
  /** Index in the node's column list. */
  index: number;
}

export interface CardGeom {
  w: number;
  h: number;
  rows: CardRow[];
  /** Columns not shown (truncated at 25, or filtered by the column mode). */
  more: number;
  /** "+N more" row is drawn (truncation, expandable). */
  moreRow: boolean;
}

export interface GeomOptions {
  columns: ColumnMode;
  types: boolean;
  /** Keys of cards expanded past the 25-column limit. */
  expanded?: ReadonlySet<string>;
}

const CHAR_NAME = 7.1;
const CHAR_TYPE = 6.2;
const CHAR_HEAD = 7.6;

export function cardGeom(n: ErNode, opts: GeomOptions): CardGeom {
  if (n.ghost || opts.columns === 'none') {
    const w = Math.round(Math.min(CARD.maxW, Math.max(n.ghost ? CARD.ghostW : CARD.minW, n.label.length * CHAR_HEAD + 56)));
    return { w, h: CARD.headerH, rows: [], more: 0, moreRow: false };
  }
  // an expanded card shows every column (past the 25-row limit and the "keys only" filter)
  const expanded = !!opts.expanded?.has(n.key);
  const all = n.columns.map((col, index) => ({ col, index }));
  const shown = expanded ? all : all.filter((r) => opts.columns === 'all' || r.col.pk || r.col.fk);
  const filtered = n.columns.length - shown.length;
  const rows = shown.length > CARD.maxRows && !expanded ? shown.slice(0, CARD.maxRows) : shown;
  const truncated = shown.length - rows.length;
  let w = n.label.length * CHAR_HEAD + 64;
  for (const r of rows) {
    const tw = opts.types ? r.col.type.length * CHAR_TYPE + 14 : 0;
    w = Math.max(w, 44 + r.col.name.length * CHAR_NAME + tw + 22);
  }
  w = Math.round(Math.min(CARD.maxW, Math.max(CARD.minW, w)));
  const collapsible = expanded && (n.columns.length > CARD.maxRows || (opts.columns === 'keys' && n.columns.some((c) => !c.pk && !c.fk)));
  const moreRow = truncated > 0 || filtered > 0 || collapsible;
  const h = CARD.headerH + CARD.padY * 2 + (rows.length + (moreRow ? 1 : 0)) * CARD.rowH;
  return { w, h, rows, more: truncated + filtered, moreRow };
}

/** Y offset (from the card top) of a column's row centre; the header centre when the column is not drawn. */
export function rowAnchorY(g: CardGeom, column: string | undefined): number {
  if (column !== undefined) {
    const i = g.rows.findIndex((r) => r.col.name === column);
    if (i >= 0) return CARD.headerH + CARD.padY + i * CARD.rowH + CARD.rowH / 2;
    if (g.moreRow) return CARD.headerH + CARD.padY + g.rows.length * CARD.rowH + CARD.rowH / 2;
  }
  return CARD.headerH / 2;
}

export function geometryOf(model: DiagramModel, opts: GeomOptions): Map<string, CardGeom> {
  const out = new Map<string, CardGeom>();
  for (const n of model.nodes) out.set(n.key, cardGeom(n, opts));
  return out;
}

/** Reading order of cards (rows of cards top to bottom, then left to right), used by Tab / Shift+Tab. */
export function readingOrder(keys: readonly string[], positions: Readonly<Record<string, readonly [number, number]>>, geom: ReadonlyMap<string, CardGeom>): string[] {
  const items = keys.filter((k) => positions[k]).map((k) => ({ k, x: positions[k][0], y: positions[k][1], h: geom.get(k)?.h ?? CARD.headerH }));
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  // band: cards whose top lies within the first card's header height count as one row
  const out: string[] = [];
  let i = 0;
  while (i < items.length) {
    const top = items[i].y;
    const band: typeof items = [];
    while (i < items.length && items[i].y < top + CARD.headerH * 2) band.push(items[i++]);
    band.sort((a, b) => a.x - b.x);
    out.push(...band.map((b) => b.k));
  }
  return out;
}

/** Name of a table as SQL users read it ("Sales.Orders"; SQLite main tables without schema). */
export function displayName(n: Pick<ErNode, 'schema' | 'name'>, dialectHasSchemas: boolean): string {
  return dialectHasSchemas && n.schema ? `${n.schema}.${n.name}` : n.name;
}

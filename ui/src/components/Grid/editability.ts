// Can a result set be edited in place? (PLAN-M1.5 A1: single-table SELECT with every key column present.)
import type { CatalogObject, CatalogSnapshot, ColumnInfo, ConnectionProfile } from '../../api/types';
import type { TableTarget } from '../../data/sqlgen';

export interface Editability {
  editable: boolean;
  /** Why editing is off (badge text), when not editable. */
  reason: string | null;
  target: TableTarget | null;
  /** Ordinals of columns that can be written (base columns of the table, not computed/aliased). */
  editableColumns: Set<number>;
  /** Ordinals of the key columns in the result. */
  keyOrdinals: number[];
}

const NOT = (reason: string): Editability => ({ editable: false, reason, target: null, editableColumns: new Set(), keyOrdinals: [] });

export function findTable(snapshot: CatalogSnapshot | null | undefined, schema: string | null, name: string): { schema: string; obj: CatalogObject } | null {
  if (!snapshot) return null;
  const low = name.toLowerCase();
  const schemas = schema
    ? snapshot.schemas.filter((s) => s.name.toLowerCase() === schema.toLowerCase())
    : [...snapshot.schemas].sort((a, b) => (a.name === snapshot.defaultSchema ? -1 : b.name === snapshot.defaultSchema ? 1 : 0));
  for (const s of schemas) {
    const obj = s.objects.find((o) => (o.t === 'table' || o.t === 'view') && o.n.toLowerCase() === low);
    if (obj) return { schema: s.name, obj };
  }
  return null;
}

/** Editability of a table/view opened in a Data tab (columns known from the first page). */
export function tableEditability(
  columns: readonly ColumnInfo[], schema: string | null, name: string, snapshot: CatalogSnapshot | null | undefined,
  conn: ConnectionProfile | undefined, isView = false,
): Editability {
  if (conn?.readOnly) return NOT('Read-only connection');
  const found = findTable(snapshot, schema, name);
  const pk = found?.obj.pk?.length ? found.obj.pk : columns.filter((c) => c.isKey).map((c) => c.name);
  if (!pk.length) return NOT(isView ? 'View without a key: read-only' : 'No primary key: read-only');
  return finish(columns, { schema: found?.schema ?? schema, name: found?.obj.n ?? name, keyColumns: pk }, found?.obj, snapshot);
}

/** Editability of a console result set. */
export function resultEditability(
  columns: readonly ColumnInfo[], opts: { singleSelect: boolean; snapshot: CatalogSnapshot | null | undefined; conn: ConnectionProfile | undefined },
): Editability {
  if (opts.conn?.readOnly) return NOT('Read-only connection');
  if (!opts.singleSelect) return NOT('Only results of a single SELECT can be edited');
  const tables = new Map<string, { schema: string | null; table: string }>();
  for (const c of columns) if (c.table) tables.set(`${(c.schema ?? '').toLowerCase()}.${c.table.toLowerCase()}`, { schema: c.schema, table: c.table });
  if (tables.size === 0) return NOT('Columns are not from a table');
  if (tables.size > 1) return NOT('Results of a JOIN are not editable');
  const [{ schema, table }] = [...tables.values()];
  const found = findTable(opts.snapshot, schema, table);
  const pk = found?.obj.pk?.length ? found.obj.pk : columns.filter((c) => c.isKey && c.table).map((c) => c.name);
  if (!pk.length) return NOT(`${table} has no primary key`);
  const missing = pk.filter((k) => !columns.some((c) => c.name.toLowerCase() === k.toLowerCase()));
  if (missing.length) return NOT(`Add the key column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} to edit`);
  return finish(columns, { schema: found?.schema ?? schema, name: found?.obj.n ?? table, keyColumns: pk }, found?.obj, opts.snapshot);
}

function finish(columns: readonly ColumnInfo[], t: TableTarget, obj: CatalogObject | undefined, snapshot: CatalogSnapshot | null | undefined): Editability {
  const tuples = obj?.c ?? null;
  const identity = tuples ? tuples.filter((c) => (c[4] & 1) === 1).map((c) => c[0]) : [];
  const computed = new Set(tuples ? tuples.filter((c) => (c[4] & 2) === 2).map((c) => c[0].toLowerCase()) : []);
  const known = tuples ? new Set(tuples.map((c) => c[0].toLowerCase())) : null;
  const editableColumns = new Set<number>();
  columns.forEach((c, i) => {
    const n = c.name.toLowerCase();
    if (known && !known.has(n)) return; // alias or expression
    if (!known && !c.table) return;
    if (computed.has(n) || c.kind === 'cursor' || c.kind === 'binary') return;
    editableColumns.add(i);
  });
  const keyOrdinals = t.keyColumns.map((k) => columns.findIndex((c) => c.name.toLowerCase() === k.toLowerCase()));
  if (keyOrdinals.some((i) => i < 0)) return NOT(`Add the key columns ${t.keyColumns.join(', ')} to edit`);
  return {
    editable: true, reason: null, editableColumns, keyOrdinals,
    target: { ...t, keyColumns: keyOrdinals.map((i) => columns[i].name), identityColumns: identity, defaultSchema: snapshot?.defaultSchema ?? null },
  };
}

export interface FkLink {
  /** Constraint name. */
  name: string;
  /** Ordinals of the FK columns in the result. */
  ordinals: number[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

/** Foreign keys of the table whose columns are all present in the result. */
export function foreignKeys(columns: readonly ColumnInfo[], schema: string | null, table: string | null, snapshot: CatalogSnapshot | null | undefined): FkLink[] {
  if (!table) return [];
  const found = findTable(snapshot, schema, table);
  if (!found?.obj.fk?.length) return [];
  const out: FkLink[] = [];
  for (const fk of found.obj.fk) {
    const ordinals = fk.cols.map((c) => columns.findIndex((x) => x.name.toLowerCase() === c.toLowerCase()));
    if (ordinals.some((i) => i < 0)) continue;
    out.push({ name: fk.n, ordinals, refSchema: fk.rs, refTable: fk.rt, refColumns: fk.rcols });
  }
  return out;
}

export interface ReferencingTable {
  schema: string;
  table: string;
  constraint: string;
  columns: string[];
  refColumns: string[];
}

/** Tables (in the loaded catalog) with a foreign key to this table. */
export function referencingTables(schema: string | null, table: string, snapshot: CatalogSnapshot | null | undefined): ReferencingTable[] {
  if (!snapshot) return [];
  const low = table.toLowerCase();
  const out: ReferencingTable[] = [];
  for (const s of snapshot.schemas) {
    for (const o of s.objects) {
      for (const fk of o.fk ?? []) {
        if (fk.rt.toLowerCase() !== low) continue;
        if (schema && fk.rs && fk.rs.toLowerCase() !== schema.toLowerCase()) continue;
        out.push({ schema: s.name, table: o.n, constraint: fk.n, columns: fk.cols, refColumns: fk.rcols });
      }
    }
  }
  return out;
}

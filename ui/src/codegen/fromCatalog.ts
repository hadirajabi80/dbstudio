// Adapters from engine/catalog shapes to the codegen input model.
import type { CatalogObject, CatalogSnapshot, ColumnInfo, Dialect, ObjectDetails, ObjectRef } from '../api/types';
import type { CgColumn, CgObject, CgPackage, CgQuery, CgQueryParam, CgRoutine, CgTable } from './model';
import { detectQueryParams } from './sqlgen';

export function findCatalogObject(snap: CatalogSnapshot | null, ref: Pick<ObjectRef, 'schema' | 'name' | 'type'>): CatalogObject | null {
  if (!snap) return null;
  const schema = snap.schemas.find((s) => s.name === (ref.schema ?? snap.defaultSchema)) ?? snap.schemas.find((s) => s.name.toLowerCase() === (ref.schema ?? '').toLowerCase());
  return schema?.objects.find((o) => o.n === ref.name && (o.t === ref.type || ref.type === undefined)) ?? null;
}

/** Catalog object (+ optional details with defaults/comments) → codegen object. Null for unsupported types. */
export function fromCatalogObject(o: CatalogObject, schema: string | null, details?: ObjectDetails | null): CgObject | null {
  switch (o.t) {
    case 'table':
    case 'view':
    case 'mview':
      return tableFrom(o, schema, details);
    case 'proc':
    case 'func':
    case 'tablefunc':
      return {
        kind: o.t === 'proc' ? 'proc' : 'func', schema, package: null, name: o.n, resultColumns: null,
        params: (o.p ?? []).map(([name, type, direction, hasDefault]) => ({ name, dbType: type, direction, hasDefault: hasDefault === 1 })),
      };
    case 'package':
      return {
        kind: 'package', schema, name: o.n,
        members: (o.members ?? []).map((m): CgRoutine => ({
          kind: m.k, schema, package: o.n, name: m.n, overload: m.ov, resultColumns: null,
          params: m.p.map(([name, type, direction, hasDefault]) => ({ name, dbType: type, direction, hasDefault: hasDefault === 1 })),
        })),
      } satisfies CgPackage;
    default:
      return null;
  }
}

function tableFrom(o: CatalogObject, schema: string | null, details?: ObjectDetails | null): CgTable {
  const byName = new Map((details?.columns ?? []).map((c) => [c.name, c]));
  const columns: CgColumn[] = (o.c ?? [])
    .filter(([, , , , flags]) => (flags & 4) === 0)
    .map(([name, type, nullable, isPk, flags, comment]) => {
      const d = byName.get(name);
      return {
        name, dbType: type, nullable: nullable === 1, pk: isPk === 1,
        identity: (flags & 1) === 1 || !!d?.isIdentity, computed: (flags & 2) === 2 || !!d?.isComputed,
        hasDefault: d ? d.default !== null : undefined, comment: comment ?? d?.comment ?? null,
      };
    });
  const pk = o.pk?.length ? o.pk : columns.filter((c) => c.pk).map((c) => c.name);
  return {
    kind: o.t === 'table' ? 'table' : 'view', schema, name: o.n, comment: o.cm ?? null, columns, primaryKey: o.t === 'table' ? pk : [],
    foreignKeys: (o.fk ?? []).map((f) => ({ name: f.n, columns: f.cols, refSchema: f.rs, refTable: f.rt, refColumns: f.rcols })),
  };
}

/** Result-set columns (ColumnInfo from a run or /describe) → codegen columns. */
export function fromColumnInfos(cols: ColumnInfo[]): CgColumn[] {
  return cols.map((c) => ({
    name: c.name || `column${c.ordinal + 1}`,
    dbType: typeTextOf(c),
    nullable: c.nullable,
    pk: c.isKey,
    identity: false,
    computed: false,
    kind: c.kind,
  }));
}

function typeTextOf(c: ColumnInfo): string {
  const t = c.dbType || c.kind;
  if (/\(/.test(t)) return t;
  if (c.precision != null && c.precision > 0 && (c.kind === 'decimal' || /number|decimal|numeric/i.test(t))) return `${t}(${c.precision},${c.scale ?? 0})`;
  if (c.size != null && c.size > 0 && c.kind === 'string') return `${t}(${c.size})`;
  return t;
}

export function queryObject(
  name: string, sql: string, dialect: Dialect, columns: CgColumn[], paramTypes: Record<string, CgQueryParam['type']> = {},
): CgQuery {
  return { kind: 'query', name, sql, params: detectQueryParams(sql, dialect, paramTypes), columns };
}

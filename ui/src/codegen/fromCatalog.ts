// Adapters from engine/catalog shapes to the codegen input model.
import type { CatalogObject, CatalogSnapshot, ColumnInfo, Dialect, ObjectDetails, ObjectRef } from '../api/types';
import type { CgColumn, CgObject, CgPackage, CgQuery, CgQueryParam, CgRoutine, CgTable } from './model';
import { detectQueryParams } from './sqlgen';
import { resolveType } from './types';

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
        kind: o.t === 'proc' ? 'proc' : 'func', schema, package: null, name: o.n,
        // A table function's catalog columns (PostgreSQL RETURNS TABLE / OUT columns, SQL Server TVFs) are its result shape.
        resultColumns: o.t === 'tablefunc' && o.c?.length
          ? o.c.map(([name, type, nullable]) => ({ name, dbType: type, nullable: nullable === 1, pk: false, identity: false, computed: false }))
          : null,
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

/** PostgreSQL user types of the loaded schemas: enums (labels) and domains (base type), keyed by bare and qualified name. */
export interface UserTypes {
  enums: Map<string, { schema: string; name: string; labels: string[] }>;
  domains: Map<string, string>;
}

export function userTypesOf(snap: Pick<CatalogSnapshot, 'schemas' | 'defaultSchema' | 'dialect'> | null | undefined): UserTypes {
  const out: UserTypes = { enums: new Map(), domains: new Map() };
  if (!snap || snap.dialect !== 'pgsql') return out;
  for (const s of snap.schemas) {
    for (const o of s.objects) {
      if (o.t !== 'type') continue;
      const keys = [`${s.name}.${o.n}`.toLowerCase(), ...(s.name === snap.defaultSchema ? [o.n.toLowerCase()] : [])];
      const labels = (o.c ?? []).filter((c) => c[1] === 'enum label').map((c) => c[0]);
      const domain = domainBaseOf(o.cm);
      for (const k of keys) {
        if (labels.length) {
          // A bare name binds to the first schema that defines it (search_path order is the snapshot's schema order).
          if (!out.enums.has(k)) out.enums.set(k, { schema: s.name, name: o.n, labels });
        } else if (domain && !out.domains.has(k)) out.domains.set(k, domain);
      }
    }
  }
  return out;
}

/** `domain over character varying(254) Valid e-mail` → `character varying(254)` (the longest known type prefix). */
function domainBaseOf(comment: string | null | undefined): string | null {
  const m = /^domain over\s+(.+)$/i.exec((comment ?? '').split('\n')[0].trim());
  if (!m) return null;
  const words = m[1].split(/\s+/);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const text = words.slice(0, n).join(' ').replace(/[.,;:]+$/, '');
    if (resolveType('pgsql', text).known) return text;
  }
  return words[0];
}

function userTypeKey(dbType: string): string {
  return dbType.trim().replace(/(\s*\[\s*\d*\s*\])+$/, '').replace(/"/g, '').toLowerCase();
}

/** Attach enum labels / domain base types to the columns of PostgreSQL tables and queries (no-op elsewhere). */
export function attachUserTypes(objects: CgObject[], types: UserTypes): CgObject[] {
  if (!types.enums.size && !types.domains.size) return objects;
  const fix = (c: CgColumn): CgColumn => {
    const k = userTypeKey(c.dbType);
    const e = types.enums.get(k);
    if (e) return { ...c, enumLabels: e.labels };
    const d = types.domains.get(k);
    return d ? { ...c, domainBase: d } : c;
  };
  return objects.map((o) => {
    if (o.kind === 'table' || o.kind === 'view' || o.kind === 'query') return { ...o, columns: o.columns.map(fix) };
    if ((o.kind === 'proc' || o.kind === 'func') && o.resultColumns) return { ...o, resultColumns: o.resultColumns.map(fix) };
    return o;
  });
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

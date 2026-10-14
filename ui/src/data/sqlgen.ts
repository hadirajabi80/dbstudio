// SQL generation for the data grid (PLAN-M1.5 A1): UPDATE / INSERT / DELETE per change, paging, COUNT and
// refetch-by-key, for T-SQL, Oracle and SQLite. Every value is a bind parameter; identifiers go through quoteIdent.
import type { CellValue, ColumnInfo, ColumnKind, Dialect } from '../api/types';
import { ParamBuilder, inlineParams } from '../filter/sql';
import type { ExecParam, ParamKind } from '../filter/wire';
import { qualifiedName, quoteIdent } from '../lib/sql';

export interface TableTarget {
  schema: string | null;
  name: string;
  /** Primary key column names (all must be present in the result to edit). */
  keyColumns: string[];
  /** Identity / autoincrement columns: left out of INSERT unless the user typed a value. */
  identityColumns?: string[];
  /** Default schema of the session (left unqualified in generated SQL when equal, except on T-SQL). */
  defaultSchema?: string | null;
}

export interface ColumnValue {
  column: ColumnInfo;
  value: CellValue;
}

export type RowChange =
  | { kind: 'update'; ref: string; key: ColumnValue[]; set: (ColumnValue & { old: CellValue })[] }
  | { kind: 'insert'; ref: string; values: ColumnValue[] }
  | { kind: 'delete'; ref: string; key: ColumnValue[]; original?: ColumnValue[] };

export interface GenStatement {
  kind: RowChange['kind'];
  /** Row reference from the change (source row index or temp id) so results map back to the grid. */
  ref: string;
  sql: string;
  params: ExecParam[];
  /** Key columns the statement returns (INSERT … OUTPUT / RETURNING): a result set, or out binds on Oracle. */
  returning: string[];
  /** SQLite < 3.35: run this right after the INSERT on the same session to learn the new rowid. */
  followUp?: string;
  /** UPDATE/DELETE must affect exactly one row; 0 = conflict. */
  expectOne: boolean;
}

export interface GenOptions {
  /** Add `AND col = @old` for every edited column (optimistic concurrency). */
  verifyUnchanged?: boolean;
  /** SQLite version, e.g. "3.46.1" (RETURNING needs 3.35). */
  sqliteVersion?: string | null;
}

export function tableSql(t: TableTarget, dialect: Dialect): string {
  return qualifiedName({ schema: t.schema, name: t.name }, dialect, { defaultSchema: t.defaultSchema ?? null, always: dialect === 'tsql' && !!t.schema });
}

/** Wire parameter kind for a column value. */
export function paramKindFor(kind: ColumnKind, value: CellValue, dialect: Dialect): ParamKind {
  if (value === null) return kind === 'binary' ? 'binary' : kindToParam(kind, dialect);
  if (typeof value === 'boolean') return dialect === 'tsql' ? 'bool' : 'int';
  return kindToParam(kind, dialect);
}

function kindToParam(kind: ColumnKind, dialect: Dialect): ParamKind {
  switch (kind) {
    case 'int': return 'int';
    case 'float': return 'float';
    case 'decimal': return dialect === 'sqlite' ? 'float' : 'decimal';
    case 'bool': return dialect === 'tsql' ? 'bool' : 'int';
    // SQLite has no date type: keep the text exactly as typed.
    case 'date': return dialect === 'sqlite' ? 'string' : 'date';
    case 'datetime': return dialect === 'sqlite' ? 'string' : 'datetime';
    case 'datetimeoffset': return dialect === 'sqlite' ? 'string' : 'datetimeoffset';
    case 'time': return dialect === 'sqlite' || dialect === 'plsql' ? 'string' : 'time';
    case 'guid': return dialect === 'tsql' ? 'guid' : 'string';
    case 'binary': return 'binary';
    default: return 'string';
  }
}

/** Grid cell → bind value (booleans become 1/0 where the dialect has no boolean). */
export function bindValue(kind: ColumnKind, value: CellValue, dialect: Dialect): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return dialect === 'tsql' ? value : value ? 1 : 0;
  if (typeof value === 'object') {
    if ('$bin' in value) return value.$bin;
    if ('$trunc' in value) return value.$trunc;
    return null;
  }
  if (kind === 'bool' && dialect !== 'tsql' && typeof value === 'string') return /^(1|true|y|yes)$/i.test(value) ? 1 : 0;
  return value;
}

function versionAtLeast(v: string | null | undefined, min: [number, number]): boolean {
  if (!v) return true;
  const m = /(\d+)\.(\d+)/.exec(v);
  if (!m) return true;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > min[0] || (a === min[0] && b >= min[1]);
}

function keyWhere(pb: ParamBuilder, key: ColumnValue[], dialect: Dialect): string {
  return key.map((k) => {
    const c = quoteIdent(k.column.name, dialect);
    if (k.value === null) return `${c} IS NULL`;
    return `${c} = ${pb.add(paramKindFor(k.column.kind, k.value, dialect), bindValue(k.column.kind, k.value, dialect))}`;
  }).join(' AND ');
}

export function generateChange(change: RowChange, t: TableTarget, dialect: Dialect, opts: GenOptions = {}): GenStatement {
  const pb = new ParamBuilder(dialect, 'p');
  const table = tableSql(t, dialect);
  const q = (n: string) => quoteIdent(n, dialect);
  const bind = (cv: ColumnValue) => pb.add(paramKindFor(cv.column.kind, cv.value, dialect), bindValue(cv.column.kind, cv.value, dialect));

  if (change.kind === 'update') {
    const sets = change.set.map((s) => `${q(s.column.name)} = ${bind(s)}`).join(', ');
    let where = keyWhere(pb, change.key, dialect);
    if (opts.verifyUnchanged) {
      const checks = change.set
        .filter((s) => !change.key.some((k) => k.column.name === s.column.name))
        .map((s) => (s.old === null ? `${q(s.column.name)} IS NULL` : `${q(s.column.name)} = ${pb.add(paramKindFor(s.column.kind, s.old, dialect), bindValue(s.column.kind, s.old, dialect))}`));
      if (checks.length) where += ` AND ${checks.join(' AND ')}`;
    }
    return { kind: 'update', ref: change.ref, sql: `UPDATE ${table} SET ${sets} WHERE ${where}`, params: pb.params, returning: [], expectOne: true };
  }

  if (change.kind === 'delete') {
    let where = keyWhere(pb, change.key, dialect);
    if (opts.verifyUnchanged && change.original?.length) {
      const checks = change.original
        .filter((o) => !change.key.some((k) => k.column.name === o.column.name) && isComparable(o))
        .map((o) => (o.value === null ? `${q(o.column.name)} IS NULL` : `${q(o.column.name)} = ${bind(o)}`));
      if (checks.length) where += ` AND ${checks.join(' AND ')}`;
    }
    return { kind: 'delete', ref: change.ref, sql: `DELETE FROM ${table} WHERE ${where}`, params: pb.params, returning: [], expectOne: true };
  }

  // INSERT: identity columns are omitted unless the user typed a value; unset columns get their DEFAULT.
  const identity = new Set((t.identityColumns ?? []).map((s) => s.toLowerCase()));
  const values = change.values.filter((v) => !(identity.has(v.column.name.toLowerCase()) && v.value === null));
  const returning = t.keyColumns.filter((k) => !values.some((v) => v.column.name.toLowerCase() === k.toLowerCase() && v.value !== null));
  const cols = values.map((v) => q(v.column.name)).join(', ');
  const vals = values.map((v) => bind(v)).join(', ');
  let sql: string;
  let followUp: string | undefined;
  const ret = returning.length ? returning : [];
  if (dialect === 'tsql') {
    const output = ret.length ? ` OUTPUT ${ret.map((k) => `INSERTED.${q(k)}`).join(', ')}` : '';
    sql = values.length ? `INSERT INTO ${table} (${cols})${output} VALUES (${vals})` : `INSERT INTO ${table}${output} DEFAULT VALUES`;
  } else if (dialect === 'plsql') {
    const head = values.length ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} (${q(t.keyColumns[0] ?? change.values[0]?.column.name ?? 'ID')}) VALUES (DEFAULT)`;
    if (ret.length) {
      const outs = ret.map((k, i) => {
        const name = `out${i + 1}`;
        const kc = change.values.find((v) => v.column.name.toLowerCase() === k.toLowerCase())?.column;
        pb.params.push({ name, kind: kc ? kindToParam(kc.kind, dialect) : 'decimal', value: null, direction: 'out' });
        return `:${name}`;
      });
      sql = `${head} RETURNING ${ret.map(q).join(', ')} INTO ${outs.join(', ')}`;
    } else sql = head;
  } else {
    const head = values.length ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} DEFAULT VALUES`;
    if (ret.length && versionAtLeast(opts.sqliteVersion, [3, 35])) sql = `${head} RETURNING ${ret.map(q).join(', ')}`;
    else {
      sql = head;
      if (ret.length === 1) followUp = `SELECT last_insert_rowid() AS ${q(ret[0])}`;
    }
  }
  return { kind: 'insert', ref: change.ref, sql, params: pb.params, returning: ret, followUp, expectOne: false };
}

function isComparable(cv: ColumnValue): boolean {
  const k = cv.column.kind;
  if (k === 'binary' || k === 'json' || k === 'xml' || k === 'float' || k === 'cursor' || k === 'other') return false;
  return cv.value === null || typeof cv.value !== 'object';
}

/** One statement per change, in the order: deletes, updates, inserts (frees unique keys before reusing them). */
export function generateChanges(changes: RowChange[], t: TableTarget, dialect: Dialect, opts: GenOptions = {}): GenStatement[] {
  const order = { delete: 0, update: 1, insert: 2 } as const;
  return [...changes].sort((a, b) => order[a.kind] - order[b.kind]).map((c) => generateChange(c, t, dialect, opts));
}

/** Readable script for the preview / "Copy SQL" (parameters shown as literals). */
export function previewScript(stmts: GenStatement[], dialect: Dialect): string {
  return stmts.map((s) => `${inlineParams(s.sql, s.params.filter((p) => p.direction !== 'out'), dialect)};`).join('\n');
}

// ---------------------------------------------------------------- reading

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export interface PageOptions {
  where?: string | null;
  sort?: SortSpec[];
  offset: number;
  limit: number;
  /** "16.0.4145.4" / "11.2.0.4" / "3.46.1": picks OFFSET/FETCH vs TOP/ROWNUM. */
  serverVersion?: string | null;
}

export interface PageSql {
  sql: string;
  /** False on old servers (no OFFSET/FETCH): only the first page can be read. */
  pageable: boolean;
}

function majorOf(v: string | null | undefined): number | null {
  const m = v ? /^(\d+)/.exec(v) : null;
  return m ? Number(m[1]) : null;
}

export function orderByClause(sort: SortSpec[] | undefined, keyColumns: string[], dialect: Dialect): string | null {
  const items = sort?.length ? sort : keyColumns.map((k) => ({ column: k, dir: 'asc' as const }));
  if (!items.length) return null;
  const all = [...items];
  // Stable paging: append the key when sorting by another column.
  for (const k of keyColumns) if (!all.some((s) => s.column.toLowerCase() === k.toLowerCase())) all.push({ column: k, dir: 'asc' });
  return all.map((s) => `${quoteIdent(s.column, dialect)}${s.dir === 'desc' ? ' DESC' : ''}`).join(', ');
}

/** `SELECT * FROM t [WHERE …] ORDER BY … OFFSET/FETCH | LIMIT/OFFSET` (row counts are generated integers). */
export function selectPageSql(t: TableTarget, dialect: Dialect, o: PageOptions): PageSql {
  const table = tableSql(t, dialect);
  const where = o.where ? `\nWHERE ${o.where}` : '';
  const order = orderByClause(o.sort, t.keyColumns, dialect);
  const limit = Math.max(1, Math.floor(o.limit));
  const offset = Math.max(0, Math.floor(o.offset));
  const major = majorOf(o.serverVersion);
  if (dialect === 'tsql') {
    if (major !== null && major < 11) {
      return { sql: `SELECT TOP ${limit} *\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}`, pageable: false };
    }
    return { sql: `SELECT *\nFROM ${table}${where}\nORDER BY ${order ?? '(SELECT NULL)'}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`, pageable: true };
  }
  if (dialect === 'plsql') {
    if (major !== null && major < 12) {
      const inner = `SELECT *\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}`;
      return { sql: `SELECT * FROM (\n${inner}\n)\nWHERE ROWNUM <= ${limit}`, pageable: false };
    }
    return { sql: `SELECT *\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`, pageable: true };
  }
  return { sql: `SELECT *\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}\nLIMIT ${limit} OFFSET ${offset}`, pageable: true };
}

export function countSql(t: TableTarget, dialect: Dialect, where?: string | null): string {
  return `SELECT COUNT(*) AS ${quoteIdent('row_count', dialect)}\nFROM ${tableSql(t, dialect)}${where ? `\nWHERE ${where}` : ''}`;
}

/** Top-N distinct values of a column with counts (header "Show only distinct values"). */
export function distinctSql(t: TableTarget, dialect: Dialect, column: string, where?: string | null, limit = 500): string {
  const c = quoteIdent(column, dialect);
  const cnt = quoteIdent('cnt', dialect);
  const body = `SELECT ${c}, COUNT(*) AS ${cnt}\nFROM ${tableSql(t, dialect)}${where ? `\nWHERE ${where}` : ''}\nGROUP BY ${c}\nORDER BY COUNT(*) DESC`;
  if (dialect === 'tsql') return body.replace(/^SELECT /, `SELECT TOP ${limit} `);
  if (dialect === 'plsql') return `${body}\nFETCH FIRST ${limit} ROWS ONLY`;
  return `${body}\nLIMIT ${limit}`;
}

/** Columns-only probe used before the first page when an initial filter needs column kinds. */
export function describeSql(t: TableTarget, dialect: Dialect): string {
  return `SELECT *\nFROM ${tableSql(t, dialect)}\nWHERE 1 = 0`;
}

/** `SELECT * FROM t WHERE (k1 = @p1 AND k2 = @p2) OR (…)` to show identities/defaults/trigger effects after submit. */
export function refetchSql(t: TableTarget, dialect: Dialect, keys: ColumnValue[][]): { sql: string; params: ExecParam[] } {
  const pb = new ParamBuilder(dialect, 'k');
  const parts = keys.map((k) => keyWhere(pb, k, dialect));
  const where = parts.length === 1 ? parts[0] : parts.map((p) => (k1(p) ? p : `(${p})`)).join(' OR ');
  return { sql: `SELECT *\nFROM ${tableSql(t, dialect)}\nWHERE ${where}`, params: pb.params };
}

const k1 = (p: string) => !p.includes(' AND ');

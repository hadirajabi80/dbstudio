// SQL generation for the data grid (PLAN-M1.5 A1): UPDATE / INSERT / DELETE per change, paging, COUNT and
// refetch-by-key, for T-SQL, Oracle, SQLite and PostgreSQL. Every value is a bind parameter; identifiers go through quoteIdent.
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
  /**
   * Deterministic ORDER BY when the table has no key (see `noKeyOrder`): `rowid` (SQLite), `ROWID` (Oracle) or every
   * orderable column (T-SQL heaps, views). Without it OFFSET paging can repeat or skip rows.
   */
  orderFallback?: string[];
  /**
   * Oracle table without a primary key: every read also selects the ROWID pseudo-column (named `ROWID`, last column),
   * which is then the row identity of UPDATE / DELETE / refetch and is returned by INSERT … RETURNING (like SQL
   * Developer and Navicat). The data tab hides that column.
   */
  rowid?: boolean;
}

/** Name of the hidden Oracle ROWID column of a keyless table (see `TableTarget.rowid`). */
export const ROWID_COLUMN = 'ROWID';

/** The Oracle ROWID column (`SELECT t.*, ROWID`): never written, never shown as a data column of the table. */
export const isRowidColumn = (c: Pick<ColumnInfo, 'name'>, dialect: Dialect | null | undefined): boolean =>
  dialect === 'plsql' && c.name.toUpperCase() === ROWID_COLUMN;

/** `t.*, ROWID` (or `*`): the select list of a read of the target. */
function selectList(t: TableTarget, dialect: Dialect, table: string): string {
  return t.rowid && dialect === 'plsql' ? `${table}.*, ${ROWID_COLUMN}` : '*';
}

/**
 * Column types a WHERE cannot compare with `=`: Oracle LOBs (ORA-22848, ORA-00932), LONG, BFILE, XMLType; T-SQL
 * text / ntext / image (Msg 402); PostgreSQL json (no equality operator).
 */
const NOT_COMPARABLE_TYPE: Partial<Record<Dialect, RegExp>> = {
  plsql: /^(n?clob|blob|bfile|long( raw)?|(sys\.)?xmltype|json)$/i,
  tsql: /^(n?text|image|xml|geography|geometry)$/i,
  pgsql: /^(json|xml|point|line|lseg|box|path|polygon|circle)$/i,
};

/** Can `col = :old` be used for this column in an optimistic-concurrency check? */
export function isComparableColumn(c: ColumnInfo, dialect: Dialect): boolean {
  const k = c.kind;
  if (k === 'binary' || k === 'json' || k === 'xml' || k === 'cursor' || k === 'other') return false;
  return !NOT_COMPARABLE_TYPE[dialect]?.test(c.dbType.trim());
}

/** Oracle stores '' as NULL: an old value '' can only be matched with IS NULL. */
const isNullValue = (v: CellValue, dialect: Dialect) => v === null || v === undefined || (dialect === 'plsql' && v === '');

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
  /** Columns of the result (T-SQL INSERT: the key types for the `@ins` table variable). */
  columns?: readonly ColumnInfo[];
}

const TSQL_PLAIN_TYPES = new Set([
  'int', 'bigint', 'smallint', 'tinyint', 'bit', 'uniqueidentifier', 'date', 'datetime', 'smalldatetime', 'money', 'smallmoney',
  'float', 'real', 'sql_variant',
]);

/** T-SQL type declaration for a key column (DECLARE @ins TABLE …), or null when it cannot be derived reliably. */
export function tsqlDeclaredType(c: ColumnInfo): string | null {
  const t = c.dbType.trim().toLowerCase();
  if (!t || !/^[a-z0-9_]+(\s*\(\s*(max|\d+)(\s*,\s*\d+)?\s*\))?$/.test(t)) return null;
  if (t.includes('(')) return t;
  const size = c.size ?? -1;
  switch (t) {
    case 'varchar': case 'varbinary': return size > 0 && size <= 8000 ? `${t}(${size})` : `${t}(max)`;
    case 'nvarchar': return size > 0 && size <= 4000 ? `${t}(${size})` : 'nvarchar(max)';
    case 'char': case 'binary': return size > 0 && size <= 8000 ? `${t}(${size})` : null;
    case 'nchar': return size > 0 && size <= 4000 ? `${t}(${size})` : null;
    case 'decimal': case 'numeric': return c.precision ? `${t}(${c.precision}, ${c.scale ?? 0})` : `${t}(38, 0)`;
    case 'datetime2': case 'time': case 'datetimeoffset': return c.scale !== null && c.scale >= 0 && c.scale <= 7 ? `${t}(${c.scale})` : t;
    case 'timestamp': case 'rowversion': return 'binary(8)';
    default: return TSQL_PLAIN_TYPES.has(t) ? t : null;
  }
}

/** The column fallback of `noKeyOrder` orders by at most this many columns. */
export const NO_KEY_ORDER_MAX_COLUMNS = 8;
/**
 * Keyless paging sorts by the column fallback only up to this many rows (features-r1-04): above it (or while the count
 * is unknown) every page would be a full scan plus sort, so pages are read without ORDER BY and the UI says so.
 */
export const NO_KEY_ORDER_MAX_ROWS = 500_000;

const isOrderable = (c: ColumnInfo, dialect?: Dialect) => {
  if (!c.name || c.kind === 'binary' || c.kind === 'xml' || c.kind === 'cursor' || c.kind === 'other') return false;
  // PostgreSQL text is an ordinary ordered type (T-SQL text/ntext are not); json / point / … have no ordering operator.
  if (dialect === 'pgsql' && /^text$/i.test(c.dbType.trim())) return true;
  return !/^(n?text|image|xml|json|point|line|lseg|box|path|polygon|circle|geography|geometry|hierarchyid|sql_variant|clob|nclob|blob|long( raw)?|bfile)$/i.test(c.dbType.trim());
};

/** Pseudo-columns / columns that make paging deterministic for a table or view without a key. */
export function noKeyOrder(dialect: Dialect, columns: readonly ColumnInfo[], isView: boolean): string[] {
  if (!isView && dialect === 'sqlite') return ['rowid'];
  if (!isView && dialect === 'plsql') return ['ROWID'];
  return columns.filter((c) => isOrderable(c, dialect)).slice(0, NO_KEY_ORDER_MAX_COLUMNS).map((c) => c.name);
}

/**
 * ORDER BY fallback of a keyless table or view, or null to page without ORDER BY (features-r1-04):
 * - a SQLite table pages by `rowid` (its storage order: free);
 * - otherwise (views, T-SQL heaps, Oracle ROWID) the fallback costs a full sort, so it is used only when `rowCount`
 *   (COUNT(*) of the current query) is known and at most NO_KEY_ORDER_MAX_ROWS.
 */
export function keylessOrder(dialect: Dialect, columns: readonly ColumnInfo[], isView: boolean, rowCount: number | null): string[] | null {
  if (!isView && dialect === 'sqlite') return ['rowid'];
  if (rowCount === null || rowCount > NO_KEY_ORDER_MAX_ROWS) return null;
  const order = noKeyOrder(dialect, columns, isView);
  return order.length ? order : null;
}

/**
 * Columns of a unique index or constraint that can order a table without a primary key: every column must be in
 * the result and orderable. Prefers indexes whose columns are all NOT NULL (several NULLs can tie), then the fewest
 * columns. Returns the result's own spelling of the names, or null.
 */
export function uniqueOrderKey(
  indexes: readonly { unique: boolean; columns: string[]; isPrimaryKey?: boolean }[] | null | undefined,
  columns: readonly ColumnInfo[],
): string[] | null {
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  let best: { cols: ColumnInfo[]; score: number } | null = null;
  for (const ix of indexes ?? []) {
    if (!ix.unique || !ix.columns.length || ix.columns.length > NO_KEY_ORDER_MAX_COLUMNS) continue;
    const cols = ix.columns.map((n) => byName.get(n.toLowerCase()));
    if (cols.some((c) => !c || !isOrderable(c))) continue;
    const list = cols as ColumnInfo[];
    const score = (list.some((c) => c.nullable) ? 100 : 0) + list.length;
    if (!best || score < best.score) best = { cols: list, score };
  }
  return best ? best.cols.map((c) => c.name) : null;
}

export function tableSql(t: TableTarget, dialect: Dialect): string {
  return qualifiedName({ schema: t.schema, name: t.name }, dialect, { defaultSchema: t.defaultSchema ?? null, always: dialect === 'tsql' && !!t.schema });
}

/** Wire parameter kind for a column value. */
export function paramKindFor(kind: ColumnKind, value: CellValue, dialect: Dialect): ParamKind {
  if (value === null) return kind === 'binary' ? 'binary' : kindToParam(kind, dialect);
  if (typeof value === 'boolean') return hasBool(dialect) ? 'bool' : 'int';
  return kindToParam(kind, dialect);
}

/** Dialects with a native boolean bind (T-SQL bit, PostgreSQL boolean); the others take 1/0. */
const hasBool = (d: Dialect) => d === 'tsql' || d === 'pgsql';

/**
 * PostgreSQL keeps native kinds (bool, guid, time, decimal, dates); json / xml / enum / array / other columns bind as
 * 'string', which the engine sends untyped so the server casts the text like a quoted literal.
 */
function kindToParam(kind: ColumnKind, dialect: Dialect): ParamKind {
  switch (kind) {
    case 'int': return 'int';
    case 'float': return 'float';
    case 'decimal': return dialect === 'sqlite' ? 'float' : 'decimal';
    case 'bool': return hasBool(dialect) ? 'bool' : 'int';
    // SQLite has no date type: keep the text exactly as typed.
    case 'date': return dialect === 'sqlite' ? 'string' : 'date';
    case 'datetime': return dialect === 'sqlite' ? 'string' : 'datetime';
    case 'datetimeoffset': return dialect === 'sqlite' ? 'string' : 'datetimeoffset';
    case 'time': return dialect === 'sqlite' || dialect === 'plsql' ? 'string' : 'time';
    case 'guid': return dialect === 'tsql' || dialect === 'pgsql' ? 'guid' : 'string';
    case 'binary': return 'binary';
    default: return 'string';
  }
}

/** Grid cell → bind value (booleans become 1/0 where the dialect has no boolean). */
export function bindValue(kind: ColumnKind, value: CellValue, dialect: Dialect): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return hasBool(dialect) ? value : value ? 1 : 0;
  if (typeof value === 'object') {
    if ('$bin' in value) return value.$bin;
    if ('$trunc' in value) return value.$trunc;
    return null;
  }
  if (kind === 'bool' && typeof value === 'string') {
    if (dialect === 'pgsql') return /^(1|true|t|y|yes|on)$/i.test(value.trim());
    if (dialect !== 'tsql') return /^(1|true|y|yes)$/i.test(value) ? 1 : 0;
  }
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
    if (isNullValue(k.value, dialect)) return `${c} IS NULL`;
    return `${c} = ${pb.add(paramKindFor(k.column.kind, k.value, dialect), bindValue(k.column.kind, k.value, dialect))}`;
  }).join(' AND ');
}

export function generateChange(change: RowChange, t: TableTarget, dialect: Dialect, opts: GenOptions = {}): GenStatement {
  // PostgreSQL statements carry only our own binds, so they use native $1, $2, … placeholders.
  const pb = new ParamBuilder(dialect, 'p', 1, { positional: true });
  const table = tableSql(t, dialect);
  const q = (n: string) => quoteIdent(n, dialect);
  const bind = (cv: ColumnValue) => pb.add(paramKindFor(cv.column.kind, cv.value, dialect), bindValue(cv.column.kind, cv.value, dialect));

  if (change.kind === 'update') {
    const sets = change.set.map((s) => `${q(s.column.name)} = ${bind(s)}`).join(', ');
    let where = keyWhere(pb, change.key, dialect);
    if (opts.verifyUnchanged) {
      // LOB / text / json columns cannot be compared with `=` (ORA-22848), and approximate numbers not reliably (a
      // BINARY_FLOAT / real 0.1 read back as 0.1 is not the stored single-precision value): written, not verified.
      const checks = change.set
        .filter((s) => !change.key.some((k) => k.column.name === s.column.name) && isComparable({ column: s.column, value: s.old }, dialect))
        .map((s) => (isNullValue(s.old, dialect) ? `${q(s.column.name)} IS NULL` : `${q(s.column.name)} = ${pb.add(paramKindFor(s.column.kind, s.old, dialect), bindValue(s.column.kind, s.old, dialect))}`));
      if (checks.length) where += ` AND ${checks.join(' AND ')}`;
    }
    return { kind: 'update', ref: change.ref, sql: `UPDATE ${table} SET ${sets} WHERE ${where}`, params: pb.params, returning: [], expectOne: true };
  }

  if (change.kind === 'delete') {
    let where = keyWhere(pb, change.key, dialect);
    if (opts.verifyUnchanged && change.original?.length) {
      const checks = change.original
        .filter((o) => !change.key.some((k) => k.column.name === o.column.name) && isComparable(o, dialect) && !isRowidColumn(o.column, dialect))
        .map((o) => (isNullValue(o.value, dialect) ? `${q(o.column.name)} IS NULL` : `${q(o.column.name)} = ${bind(o)}`));
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
    // OUTPUT without INTO is rejected on tables with enabled triggers (Msg 334), so the key goes through a table
    // variable and comes back as a result set: DECLARE @ins TABLE (…); INSERT … OUTPUT INSERTED.k INTO @ins …; SELECT.
    const body = (output: string) => (values.length ? `INSERT INTO ${table} (${cols})${output} VALUES (${vals})` : `INSERT INTO ${table}${output} DEFAULT VALUES`);
    if (!ret.length) sql = body('');
    else {
      const info = (k: string) =>
        opts.columns?.find((c) => c.name.toLowerCase() === k.toLowerCase()) ?? change.values.find((v) => v.column.name.toLowerCase() === k.toLowerCase())?.column;
      const types = ret.map((k) => {
        const c = info(k);
        return c ? tsqlDeclaredType(c) : null;
      });
      const identity = new Set((t.identityColumns ?? []).map((s) => s.toLowerCase()));
      if (ret.length === 1 && types[0] === null && identity.has(ret[0].toLowerCase())) {
        // Type unknown, single identity key: SCOPE_IDENTITY() is scoped to this batch (unaffected by triggers).
        sql = `${body('')};\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS ${q(ret[0])};`;
      } else {
        const decl = ret.map((k, i) => `${q(k)} ${types[i] ?? 'sql_variant'}`).join(', ');
        const output = ` OUTPUT ${ret.map((k) => `INSERTED.${q(k)}`).join(', ')} INTO @ins`;
        sql = `DECLARE @ins TABLE (${decl});\n${body(output)};\nSELECT * FROM @ins;`;
      }
    }
  } else if (dialect === 'plsql') {
    // Nothing typed: one column set to its DEFAULT (never the ROWID pseudo-column).
    const defaultCol = [...t.keyColumns, ...(opts.columns ?? []).map((c) => c.name), ...change.values.map((v) => v.column.name)]
      .find((n) => !isRowidColumn({ name: n }, dialect)) ?? 'ID';
    const head = values.length ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} (${q(defaultCol)}) VALUES (DEFAULT)`;
    if (ret.length) {
      const outs = ret.map((k, i) => {
        const name = `out${i + 1}`;
        const same = (c: ColumnInfo) => c.name.toLowerCase() === k.toLowerCase();
        const kc = change.values.find((v) => same(v.column))?.column ?? opts.columns?.find(same);
        // ROWID comes back as text (it is compared as text in the WHERE of later statements).
        const kind: ParamKind = isRowidColumn({ name: k }, dialect) ? 'string' : kc ? kindToParam(kc.kind, dialect) : 'decimal';
        pb.params.push({ name, kind, value: null, direction: 'out' });
        return `:${name}`;
      });
      sql = `${head} RETURNING ${ret.map(q).join(', ')} INTO ${outs.join(', ')}`;
    } else sql = head;
  } else if (dialect === 'pgsql') {
    const head = values.length ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} DEFAULT VALUES`;
    sql = ret.length ? `${head} RETURNING ${ret.map(q).join(', ')}` : head;
  } else if (dialect === 'mysql') {
    // MySQL / MariaDB: no DEFAULT VALUES; the generated key of the row comes back through LAST_INSERT_ID().
    sql = values.length ? `INSERT INTO ${table} (${cols}) VALUES (${vals})` : `INSERT INTO ${table} () VALUES ()`;
    if (ret.length === 1 && identity.has(ret[0].toLowerCase())) followUp = `SELECT LAST_INSERT_ID() AS ${q(ret[0])}`;
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

function isComparable(cv: ColumnValue, dialect: Dialect): boolean {
  if (cv.column.kind === 'float' || !isComparableColumn(cv.column, dialect)) return false;
  return cv.value === null || typeof cv.value !== 'object';
}

/** One statement per change, in the order: deletes, updates, inserts (frees unique keys before reusing them). */
export function generateChanges(changes: RowChange[], t: TableTarget, dialect: Dialect, opts: GenOptions = {}): GenStatement[] {
  const order = { delete: 0, update: 1, insert: 2 } as const;
  return [...changes].sort((a, b) => order[a.kind] - order[b.kind]).map((c) => generateChange(c, t, dialect, opts));
}

/** Savepoint used when a grid submit joins a transaction the user already has open (manual mode). */
export const EDIT_SAVEPOINT = 'dbs_edit';

export function savepointSql(dialect: Dialect, name = EDIT_SAVEPOINT): string {
  return dialect === 'tsql' ? `SAVE TRANSACTION ${name}` : `SAVEPOINT ${name}`;
}

export function rollbackToSavepointSql(dialect: Dialect, name = EDIT_SAVEPOINT): string {
  return dialect === 'tsql' ? `ROLLBACK TRANSACTION ${name}` : `ROLLBACK TO SAVEPOINT ${name}`;
}

/** SQLite / PostgreSQL / MySQL: drop the savepoint after a successful submit (Oracle/T-SQL have no RELEASE). */
export function releaseSavepointSql(dialect: Dialect, name = EDIT_SAVEPOINT): string | null {
  return dialect === 'sqlite' || dialect === 'pgsql' || dialect === 'mysql' ? `RELEASE SAVEPOINT ${name}` : null;
}

/** Readable script for the preview / "Copy SQL" (parameters shown as literals). */
export function previewScript(stmts: GenStatement[], dialect: Dialect): string {
  return stmts.map((s) => `${inlineParams(s.sql, s.params.filter((p) => p.direction !== 'out'), dialect).replace(/;\s*$/, '')};`).join('\n');
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

export function orderByClause(sort: SortSpec[] | undefined, keyColumns: string[], dialect: Dialect, fallback: string[] = []): string | null {
  // Without a key, a pseudo-column (rowid / ROWID) or every orderable column keeps OFFSET pages deterministic.
  const stable = keyColumns.length ? keyColumns : fallback;
  const items = sort?.length ? sort : stable.map((k) => ({ column: k, dir: 'asc' as const }));
  if (!items.length) return null;
  const all = [...items];
  // Stable paging: append the key when sorting by another column.
  for (const k of stable) if (!all.some((s) => s.column.toLowerCase() === k.toLowerCase())) all.push({ column: k, dir: 'asc' });
  return all.map((s) => `${quoteIdent(s.column, dialect)}${s.dir === 'desc' ? ' DESC' : ''}`).join(', ');
}

/** `SELECT * FROM t [WHERE …] ORDER BY … OFFSET/FETCH | LIMIT/OFFSET` (row counts are generated integers). */
export function selectPageSql(t: TableTarget, dialect: Dialect, o: PageOptions): PageSql {
  const table = tableSql(t, dialect);
  const cols = selectList(t, dialect, table);
  const where = o.where ? `\nWHERE ${o.where}` : '';
  const order = orderByClause(o.sort, t.keyColumns, dialect, t.orderFallback);
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
      const inner = `SELECT ${cols}\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}`;
      return { sql: `SELECT * FROM (\n${inner}\n)\nWHERE ROWNUM <= ${limit}`, pageable: false };
    }
    return { sql: `SELECT ${cols}\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`, pageable: true };
  }
  return { sql: `SELECT *\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}\nLIMIT ${limit} OFFSET ${offset}`, pageable: true };
}

export function countSql(t: TableTarget, dialect: Dialect, where?: string | null): string {
  return `SELECT COUNT(*) AS ${quoteIdent('row_count', dialect)}\nFROM ${tableSql(t, dialect)}${where ? `\nWHERE ${where}` : ''}`;
}

/** Top-N distinct values of a column with counts (header "Show only distinct values"). */
export function distinctSql(t: TableTarget, dialect: Dialect, column: string, where?: string | null, limit = 500, serverVersion?: string | null): string {
  const c = quoteIdent(column, dialect);
  const cnt = quoteIdent('cnt', dialect);
  const body = `SELECT ${c}, COUNT(*) AS ${cnt}\nFROM ${tableSql(t, dialect)}${where ? `\nWHERE ${where}` : ''}\nGROUP BY ${c}\nORDER BY COUNT(*) DESC`;
  if (dialect === 'tsql') return body.replace(/^SELECT /, `SELECT TOP ${limit} `);
  if (dialect === 'plsql') {
    const major = majorOf(serverVersion);
    // FETCH FIRST needs 12c; older servers get the ROWNUM wrapper (as selectPageSql does).
    if (major !== null && major < 12) return `SELECT * FROM (\n${body}\n)\nWHERE ROWNUM <= ${limit}`;
    return `${body}\nFETCH FIRST ${limit} ROWS ONLY`;
  }
  return `${body}\nLIMIT ${limit}`;
}

/** Columns-only probe used before the first page when an initial filter needs column kinds. */
export function describeSql(t: TableTarget, dialect: Dialect): string {
  return `SELECT *\nFROM ${tableSql(t, dialect)}\nWHERE 1 = 0`;
}

/** `SELECT * FROM t WHERE (k1 = @p1 AND k2 = @p2) OR (…)` to show identities/defaults/trigger effects after submit. */
export function refetchSql(t: TableTarget, dialect: Dialect, keys: ColumnValue[][]): { sql: string; params: ExecParam[] } {
  const pb = new ParamBuilder(dialect, 'k', 1, { positional: true });
  const parts = keys.map((k) => keyWhere(pb, k, dialect));
  const where = parts.length === 1 ? parts[0] : parts.map((p) => (k1(p) ? p : `(${p})`)).join(' OR ');
  const table = tableSql(t, dialect);
  return { sql: `SELECT ${selectList(t, dialect, table)}\nFROM ${table}\nWHERE ${where}`, params: pb.params };
}

const k1 = (p: string) => !p.includes(' AND ');

// SQL text shared by every generator: CRUD statements per dialect with driver placeholders, and
// detection/rewriting of the parameters of a user query. Values are always bound, never concatenated.
import type { Dialect } from '../api/types';
import { getSpec } from '../intel/dialect';
import { tokenize } from '../intel/lexer/lexer';
import { qualifiedName, quoteIdent } from '../lib/sql';
import type { CgColumn, CgQueryParam, CgTable } from './model';
import { resolveType } from './types';

/** Placeholder for the bind parameter `name`, 1-based position `index` in the statement. */
export type Placeholder = (name: string, index: number) => string;

export const PH = {
  /** `@Name` — SqlClient, Dapper, node-mssql, Microsoft.Data.Sqlite. */
  at: ((n) => `@${n}`) as Placeholder,
  /** `:Name` — ODP.NET, node-oracledb, python-oracledb, sqlite3 named. */
  colon: ((n) => `:${n}`) as Placeholder,
  /** `?` — JDBC, pyodbc, sqlite positional. */
  q: (() => '?') as Placeholder,
  /** `@p1` — go-mssqldb ordinal. */
  atP: ((_, i) => `@p${i}`) as Placeholder,
  /** `:1` — godror ordinal. */
  colonN: ((_, i) => `:${i}`) as Placeholder,
};

export function tableName(t: Pick<CgTable, 'schema' | 'name'>, dialect: Dialect): string {
  return qualifiedName({ schema: t.schema, name: t.name }, dialect, { always: dialect !== 'sqlite' });
}

export const qi = quoteIdent;

export function isWritable(c: CgColumn, dialect: Dialect): boolean {
  if (c.identity || c.computed) return false;
  return resolveType(dialect, c.dbType).logical !== 'rowversion';
}

export interface BoundSql {
  sql: string;
  /** Columns bound, in placeholder order. */
  params: CgColumn[];
}

export interface InsertSql extends BoundSql {
  /** Identity column the statement returns (OUTPUT / RETURNING), if any. */
  returning: CgColumn | null;
  /** How `returning` comes back: a result row, an Oracle OUT bind, or not at all. */
  returningKind: 'row' | 'outBind' | 'none';
  /** Oracle OUT bind placeholder name for `returning`. */
  returningBind: string | null;
}

export interface CrudSql {
  table: string;
  /** `SELECT cols FROM t`. */
  selectAll: string;
  selectByPk: BoundSql | null;
  insert: InsertSql | null;
  update: BoundSql | null;
  delete: BoundSql | null;
  pk: CgColumn[];
}

export interface CrudOptions {
  placeholder: Placeholder;
  /** Bind name for a column (`Name`, `name`, `customer_id`). */
  bindName: (c: CgColumn) => string;
  /** Result alias for a column when the property differs from the column (Dapper / TS drivers); null = no alias. */
  alias?: (c: CgColumn) => string | null;
  /**
   * How an identity value is returned from INSERT: 'auto' = OUTPUT (T-SQL), RETURNING INTO (Oracle), RETURNING (SQLite);
   * 'none' = plain INSERT (the caller uses LastInsertId / getGeneratedKeys).
   */
  identityReturn?: 'auto' | 'none';
  /** Line break + indent between clauses ('' keeps statements on one line). */
  newline?: string;
}

function selectList(t: CgTable, dialect: Dialect, alias?: (c: CgColumn) => string | null): string {
  return t.columns
    .map((c) => {
      const a = alias?.(c);
      return a ? `${qi(c.name, dialect)} AS ${quoteAlias(a, dialect)}` : qi(c.name, dialect);
    })
    .join(', ');
}

/** Aliases must keep their case for drivers that return rows keyed by name. */
export function quoteAlias(alias: string, dialect: Dialect): string {
  if (dialect === 'tsql') return quoteIdent(alias, dialect);
  // Oracle folds unquoted aliases to upper case; SQLite keeps case but quote reserved words.
  if (dialect === 'plsql') return /^[A-Z][A-Z0-9_$#]*$/.test(alias) ? alias : `"${alias.replace(/"/g, '""')}"`;
  return quoteIdent(alias, dialect);
}

export function crudSql(t: CgTable, dialect: Dialect, o: CrudOptions): CrudSql {
  const nl = o.newline ?? ' ';
  const table = tableName(t, dialect);
  const pk = t.primaryKey.map((n) => t.columns.find((c) => c.name === n)).filter((c): c is CgColumn => !!c);
  const cols = selectList(t, dialect, o.alias);
  const selectAll = `SELECT ${cols}${nl}FROM ${table}`;

  const where = (start: number, params: CgColumn[]) =>
    pk
      .map((c, i) => {
        params.push(c);
        return `${qi(c.name, dialect)} = ${o.placeholder(o.bindName(c), start + i)}`;
      })
      .join(' AND ');

  let selectByPk: BoundSql | null = null;
  let update: BoundSql | null = null;
  let del: BoundSql | null = null;
  if (pk.length && t.kind === 'table') {
    const p1: CgColumn[] = [];
    selectByPk = { sql: `${selectAll}${nl}WHERE ${where(1, p1)}`, params: p1 };
    const p3: CgColumn[] = [];
    del = { sql: `DELETE FROM ${table}${nl}WHERE ${where(1, p3)}`, params: p3 };
    const setCols = t.columns.filter((c) => !t.primaryKey.includes(c.name) && isWritable(c, dialect));
    if (setCols.length) {
      const p2: CgColumn[] = [];
      const set = setCols
        .map((c, i) => {
          p2.push(c);
          return `${qi(c.name, dialect)} = ${o.placeholder(o.bindName(c), i + 1)}`;
        })
        .join(', ');
      update = { sql: `UPDATE ${table}${nl}SET ${set}${nl}WHERE ${where(setCols.length + 1, p2)}`, params: p2 };
    }
  }

  let insert: InsertSql | null = null;
  if (t.kind === 'table') {
    const ins = t.columns.filter((c) => isWritable(c, dialect));
    const identity = t.columns.find((c) => c.identity) ?? null;
    const params: CgColumn[] = [];
    const values = ins.map((c, i) => {
      params.push(c);
      return o.placeholder(o.bindName(c), i + 1);
    });
    const colList = ins.map((c) => qi(c.name, dialect)).join(', ');
    const mode = o.identityReturn ?? 'auto';
    let sql: string;
    let returningKind: InsertSql['returningKind'] = 'none';
    let returningBind: string | null = null;
    const head = ins.length ? `INSERT INTO ${table} (${colList})` : `INSERT INTO ${table}`;
    const vals = ins.length ? `VALUES (${values.join(', ')})` : dialect === 'plsql' ? 'VALUES (DEFAULT)' : 'DEFAULT VALUES';
    if (identity && mode === 'auto') {
      if (dialect === 'tsql') {
        sql = `${head}${nl}OUTPUT INSERTED.${qi(identity.name, dialect)}${nl}${vals}`;
        returningKind = 'row';
      } else if (dialect === 'plsql') {
        returningBind = o.bindName(identity);
        sql = `${head}${nl}${vals}${nl}RETURNING ${qi(identity.name, dialect)} INTO ${o.placeholder(returningBind, ins.length + 1)}`;
        returningKind = 'outBind';
      } else {
        sql = `${head}${nl}${vals}${nl}RETURNING ${qi(identity.name, dialect)}`;
        returningKind = 'row';
      }
    } else {
      sql = `${head}${nl}${vals}`;
    }
    insert = { sql, params, returning: identity && mode === 'auto' ? identity : null, returningKind, returningBind };
  }

  return { table, selectAll, selectByPk, insert, update, delete: del, pk };
}

// ---------------- query parameters ----------------

interface ParamToken {
  start: number;
  end: number;
  /** Name without prefix; positional `?` → p1, p2, ... */
  name: string;
  positional: boolean;
}

function declaredTsqlVariables(sql: string): Set<string> {
  const out = new Set<string>();
  const toks = tokenize(sql, getSpec('tsql')).filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].upper !== 'DECLARE') continue;
    // DECLARE @a int, @b nvarchar(10) = 'x', @t TABLE (...)
    let depth = 0;
    for (let j = i + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
      else if (depth === 0 && t.text === ';') break;
      else if (depth === 0 && t.kind === 'keyword' && /^(SELECT|SET|IF|WHILE|BEGIN|INSERT|UPDATE|DELETE|EXEC|EXECUTE|RETURN|DECLARE)$/.test(t.upper) && j > i + 2) break;
      if (t.kind === 'param' && (j === i + 1 || toks[j - 1].text === ',')) out.add(t.text.slice(1).toLowerCase());
    }
  }
  return out;
}

function paramTokens(sql: string, dialect: Dialect): ParamToken[] {
  const toks = tokenize(sql, getSpec(dialect));
  const declared = dialect === 'tsql' ? declaredTsqlVariables(sql) : new Set<string>();
  const out: ParamToken[] = [];
  let q = 0;
  for (const t of toks) {
    if (t.kind !== 'param') continue;
    const text = t.text;
    if (dialect === 'tsql') {
      if (text.startsWith('@@')) continue;
      if (declared.has(text.slice(1).toLowerCase())) continue;
    }
    if (dialect === 'plsql' && text.startsWith('&')) continue; // SQL*Plus substitution variable
    if (text === '?') {
      out.push({ start: t.start, end: t.end, name: `p${++q}`, positional: true });
    } else if (/^\?\d+$/.test(text)) {
      out.push({ start: t.start, end: t.end, name: `p${text.slice(1)}`, positional: true });
    } else {
      let name = text.slice(1);
      if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
      if (/^\d+$/.test(name)) name = `p${name}`;
      out.push({ start: t.start, end: t.end, name, positional: false });
    }
  }
  return out;
}

/** Unique parameters of a query in first-occurrence order (type defaults to `string`). */
export function detectQueryParams(sql: string, dialect: Dialect, types: Record<string, CgQueryParam['type']> = {}): CgQueryParam[] {
  const seen = new Map<string, CgQueryParam>();
  for (const p of paramTokens(sql, dialect)) {
    const key = p.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, { name: p.name, positional: p.positional, type: types[p.name] ?? types[key] ?? 'string' });
  }
  return [...seen.values()];
}

export type ParamStyle = 'keep' | 'q' | 'atP' | 'colonN' | 'at' | 'colon';

/**
 * Rewrite the query's parameter tokens for a driver. Returns the SQL and the parameter name bound at each
 * placeholder (repeated names appear repeatedly for positional styles).
 */
export function rewriteQuery(sql: string, dialect: Dialect, style: ParamStyle): { sql: string; order: string[] } {
  const toks = paramTokens(sql, dialect);
  const order: string[] = [];
  if (style === 'keep') return { sql, order: toks.map((t) => t.name) };
  let out = '';
  let last = 0;
  const firstIndex = new Map<string, number>();
  toks.forEach((t, i) => {
    out += sql.slice(last, t.start);
    let ph: string;
    switch (style) {
      case 'q':
        ph = '?';
        order.push(t.name);
        break;
      case 'atP':
      case 'colonN': {
        // Named-by-number styles can reuse the same index for repeated names.
        const key = t.name.toLowerCase();
        let n = firstIndex.get(key);
        if (n === undefined) {
          n = firstIndex.size + 1;
          firstIndex.set(key, n);
          order.push(t.name);
        }
        ph = style === 'atP' ? `@p${n}` : `:${n}`;
        break;
      }
      case 'at':
        ph = `@${t.name}`;
        if (!order.includes(t.name)) order.push(t.name);
        break;
      default:
        ph = `:${t.name}`;
        if (!order.includes(t.name)) order.push(t.name);
    }
    void i;
    out += ph;
    last = t.end;
  });
  out += sql.slice(last);
  return { sql: out, order };
}

/** Strip a trailing `;` (and whitespace); drivers reject it for single statements (Oracle). */
export function trimStatement(sql: string): string {
  return sql.trim().replace(/;\s*$/, '').trim();
}

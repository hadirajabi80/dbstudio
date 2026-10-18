// Filter tree → parameterized SQL predicate per dialect (PLAN-M1.5 1.1.1 "Push filter to server").
// Values are always bind parameters, never inlined; identifiers go through quoteIdent.
import type { ColumnInfo, Dialect } from '../api/types';
import { quoteIdent } from '../lib/sql';
import { kindClass, resolveColumn, type FilterCondition, type FilterGroup, type FilterNode, type FilterValue } from './model';
import { OPERATOR_INFO } from './operators';
import {
  addDays, conditionProblem, filledValues, isDateOnly, parseDateOperand, parseNumber, parsePeriod, parseTimeOperand,
  periodBounds,
} from './values';
import type { ExecParam, ParamKind } from './wire';

/** Allocates bind parameters and renders their placeholder for the dialect. */
export class ParamBuilder {
  readonly params: ExecParam[] = [];
  private readonly dialect: Dialect;
  private readonly prefix: string;
  private seq: number;

  constructor(dialect: Dialect, prefix = 'p', start = 1) {
    this.dialect = dialect;
    this.prefix = prefix;
    this.seq = start - 1;
  }

  add(kind: ParamKind, value: FilterValue): string {
    const name = `${this.prefix}${++this.seq}`;
    this.params.push({ name, kind, value });
    return placeholder(name, this.dialect);
  }
}

export function placeholder(name: string, dialect: Dialect): string {
  return dialect === 'plsql' ? `:${name}` : `@${name}`;
}

export interface PredicateOptions {
  /** Table alias to qualify columns with (e.g. "q" for the wrapped statement); null = unqualified. */
  alias?: string | null;
  now?: Date;
  /** Bind name prefix (default "fp", so filter binds never collide with user binds). */
  paramPrefix?: string;
}

export interface PredicateResult {
  /** SQL predicate, or null when nothing can be pushed. */
  where: string | null;
  params: ExecParam[];
  /** Part of the filter that must still run client-side (regex, OR groups containing regex). */
  clientOnly: FilterGroup | null;
  /** Number of conditions turned into SQL. */
  serverConditions: number;
  warnings: string[];
}

const LIKE_ESCAPE = "ESCAPE '\\'";

function escapeLike(v: string, dialect: Dialect): string {
  const re = dialect === 'tsql' ? /[\\%_[]/g : /[\\%_]/g;
  return v.replace(re, (m) => `\\${m}`);
}

function concat(dialect: Dialect, parts: string[]): string {
  return dialect === 'tsql' ? parts.join(' + ') : parts.join(' || ');
}

interface Ctx {
  dialect: Dialect;
  columns: readonly ColumnInfo[];
  pb: ParamBuilder;
  alias: string | null;
  now?: Date;
  warnings: string[];
  count: number;
}

/**
 * A rendered predicate piece. `compound` = it has a top-level AND/OR, so it needs parentheses when it is combined
 * with anything else (never guessed from the text: `(A) OR (B)` starts with "(" and ends with ")" but is compound).
 */
interface Piece {
  sql: string;
  compound: boolean;
}

const atom = (sql: string): Piece => ({ sql, compound: false });
const compound = (sql: string): Piece => ({ sql, compound: true });

/** Join pieces with AND/OR, parenthesizing compound ones. */
function joinPieces(pieces: Piece[], glue: ' AND ' | ' OR '): Piece {
  if (pieces.length === 1) return pieces[0];
  return compound(pieces.map((p) => (p.compound ? `(${p.sql})` : p.sql)).join(glue));
}

function colRef(ctx: Ctx, c: ColumnInfo): string {
  // Oracle: result column names are exact (case-sensitive), so they are always quoted, whatever their case.
  const id = quoteIdent(c.name, ctx.dialect, ctx.dialect === 'plsql');
  return ctx.alias ? `${ctx.alias}.${id}` : id;
}

function numberParam(ctx: Ctx, kind: ColumnInfo['kind'], v: FilterValue): string {
  const n = parseNumber(v)!;
  if (ctx.dialect === 'sqlite') return ctx.pb.add(Number.isInteger(n.num) ? 'int' : 'float', n.num);
  if (kind === 'float') return ctx.pb.add('float', n.num);
  if (Number.isSafeInteger(n.num) && !n.str.includes('.')) return ctx.pb.add('int', n.num);
  return ctx.pb.add('decimal', n.str);
}

/** Datetime operand as a bind; SQLite stores dates as text, so it gets normalized text. */
function dateParam(ctx: Ctx, iso: string): string {
  if (ctx.dialect === 'sqlite') return ctx.pb.add('string', iso.length === 10 ? iso : iso.replace('T', ' ').slice(0, 19));
  return ctx.pb.add('datetime', iso.length === 10 ? `${iso}T00:00:00` : iso);
}

function conditionSql(ctx: Ctx, cond: FilterCondition): Piece | null {
  const r = conditionText(ctx, cond);
  return r === null ? null : typeof r === 'string' ? atom(r) : r;
}

/** A condition as SQL text (atomic) or as a Piece (date ranges may be compound). */
function conditionText(ctx: Ctx, cond: FilterCondition): string | Piece | null {
  const ci = resolveColumn(ctx.columns, cond.column, cond.ordinal);
  if (ci < 0) {
    ctx.warnings.push(`Column “${cond.column}” is not in the result; condition ignored`);
    return null;
  }
  const col = ctx.columns[ci];
  if (cond.enabled === false || conditionProblem(cond, col.kind)) return null;
  const d = ctx.dialect;
  const cls = kindClass(col.kind);
  let c = colRef(ctx, col);
  if (d === 'tsql' && (col.kind === 'xml' || col.kind === 'json') && cls === 'string') c = `CAST(${c} AS NVARCHAR(MAX))`;
  const cs = !!cond.caseSensitive;
  const v = cond.values;
  ctx.count++;

  const strParam = (s: string) => ctx.pb.add('string', s);
  // Column expression and operand wrapper for case handling in = / IN.
  const ciEq = (): { left: string; wrap: (p: string) => string; suffix: string } => {
    if (d === 'tsql') return { left: cs ? `${c} COLLATE Latin1_General_CS_AS` : c, wrap: (p) => p, suffix: '' };
    if (d === 'plsql') return cs ? { left: c, wrap: (p) => p, suffix: '' } : { left: `UPPER(${c})`, wrap: (p) => `UPPER(${p})`, suffix: '' };
    return { left: c, wrap: (p) => p, suffix: cs ? '' : ' COLLATE NOCASE' };
  };

  switch (cond.op) {
    case 'isNull': return `${c} IS NULL`;
    case 'isNotNull': return `${c} IS NOT NULL`;
    case 'isTrue': return `${c} = 1`;
    case 'isFalse': return `${c} = 0`;
    case 'isEmpty':
      if (d === 'plsql') {
        ctx.warnings.push('Oracle stores empty strings as NULL: “is empty” matches NULL');
        return `${c} IS NULL`;
      }
      return `${c} = ''`;
    case 'regex':
      return null; // client-only (never reached: filtered out before)
    case 'contains': case 'notContains': case 'startsWith': case 'endsWith': {
      const raw = String(v[0]);
      const pre = cond.op === 'contains' || cond.op === 'notContains' || cond.op === 'endsWith';
      const post = cond.op === 'contains' || cond.op === 'notContains' || cond.op === 'startsWith';
      let expr: string;
      if (d === 'sqlite' && cs) {
        const p = strParam(raw);
        expr = cond.op === 'startsWith' ? `substr(${c}, 1, length(${p})) = ${p}`
          : cond.op === 'endsWith' ? `substr(${c}, -length(${p})) = ${p}`
            : `instr(${c}, ${p}) > 0`;
      } else {
        const p = strParam(escapeLike(raw, d));
        const operand = d === 'plsql' && !cs ? `UPPER(${p})` : p;
        const pattern = concat(d, [...(pre ? ["'%'"] : []), operand, ...(post ? ["'%'"] : [])]);
        const left = d === 'tsql' && cs ? `${c} COLLATE Latin1_General_CS_AS` : d === 'plsql' && !cs ? `UPPER(${c})` : c;
        expr = `${left} LIKE ${pattern} ${LIKE_ESCAPE}`;
      }
      return cond.op === 'notContains' ? `NOT (${expr})` : expr;
    }
    case 'in': case 'notIn': {
      const vals = filledValues(cond);
      const neg = cond.op === 'notIn' ? 'NOT ' : '';
      if (cls === 'number') return `${c} ${neg}IN (${vals.map((x) => numberParam(ctx, col.kind, x)).join(', ')})`;
      const e = ciEq();
      const left = d === 'sqlite' && e.suffix ? `${c}${e.suffix}` : e.left;
      return `${left} ${neg}IN (${vals.map((x) => e.wrap(strParam(String(x)))).join(', ')})`;
    }
  }

  // comparisons
  if (cls === 'number' || cls === 'bool') {
    const op = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[cond.op as 'eq'];
    if (cond.op === 'between') return `${c} BETWEEN ${numberParam(ctx, col.kind, v[0])} AND ${numberParam(ctx, col.kind, v[1])}`;
    return op ? `${c} ${op} ${numberParam(ctx, col.kind, v[0])}` : null;
  }
  if (cls === 'date') return dateSql(ctx, cond, c);
  if (cls === 'time') {
    const t = (i: number) => parseTimeOperand(v[i])!;
    const left = d === 'sqlite' ? `time(${c})` : d === 'plsql' ? `TO_CHAR(${c}, 'HH24:MI:SS')` : c;
    const p = (i: number) => ctx.pb.add(d === 'tsql' ? 'time' : 'string', t(i).slice(0, 8));
    if (cond.op === 'before') return `${left} < ${p(0)}`;
    if (cond.op === 'after') return `${left} > ${p(0)}`;
    if (cond.op === 'between') return `${left} BETWEEN ${p(0)} AND ${p(1)}`;
  }
  // text comparisons
  const e = ciEq();
  const op = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[cond.op as 'eq'];
  if (cond.op === 'between') return `${e.left} BETWEEN ${e.wrap(strParam(String(v[0])))}${e.suffix} AND ${e.wrap(strParam(String(v[1])))}${e.suffix}`;
  if (!op) return null;
  return `${e.left} ${op} ${e.wrap(strParam(String(v[0])))}${e.suffix}`;
}

function dateSql(ctx: Ctx, cond: FilterCondition, c: string): Piece | null {
  const d = ctx.dialect;
  const v = cond.values;
  if (cond.op === 'last' || cond.op === 'next') {
    const p = parsePeriod(v)!;
    const b = periodBounds(cond.op, p.count, p.unit, ctx.now);
    const left = d === 'sqlite' ? `datetime(${c})` : c;
    return compound(`${left} >= ${dateParam(ctx, b.from)} AND ${left} ${cond.op === 'last' ? '<=' : '<'} ${dateParam(ctx, b.to)}`);
  }
  const ops = cond.op === 'between' ? [0, 1] : [0];
  const vals = ops.map((i) => parseDateOperand(v[i])!);
  const dateOnly = cond.op === 'onDate' || vals.every(isDateOnly);
  // Mixed precision ("2024-01-01 10:00" .. "2024-01-02"): a date-only upper bound means "through that whole day",
  // exactly like the grid evaluator (evaluate.ts dateCondition), so "Apply on server" keeps the row count.
  const dayUpper = cond.op === 'between' && !dateOnly && isDateOnly(vals[1]);
  if (d === 'sqlite') {
    const left = dateOnly ? `date(${c})` : `datetime(${c})`;
    const p = (s: string) => dateParam(ctx, dateOnly ? s.slice(0, 10) : s);
    switch (cond.op) {
      case 'onDate': case 'eq': return atom(`${left} = ${p(vals[0])}`);
      case 'neq': return atom(`${left} <> ${p(vals[0])}`);
      case 'before': case 'lt': return atom(`${left} < ${p(vals[0])}`);
      case 'lte': return atom(`${left} <= ${p(vals[0])}`);
      case 'after': case 'gt': return atom(`${left} > ${p(vals[0])}`);
      case 'gte': return atom(`${left} >= ${p(vals[0])}`);
      case 'between':
        if (dayUpper) return compound(`${left} >= ${p(vals[0])} AND ${left} < ${dateParam(ctx, addDays(vals[1], 1))}`);
        return atom(`${left} BETWEEN ${p(vals[0])} AND ${p(vals[1])}`);
    }
    return null;
  }
  // T-SQL / Oracle: sargable half-open ranges on the raw column.
  const day = (s: string) => s.slice(0, 10);
  if (dateOnly) {
    switch (cond.op) {
      case 'onDate': case 'eq': return compound(`${c} >= ${dateParam(ctx, day(vals[0]))} AND ${c} < ${dateParam(ctx, addDays(vals[0], 1))}`);
      case 'neq': return atom(`NOT (${c} >= ${dateParam(ctx, day(vals[0]))} AND ${c} < ${dateParam(ctx, addDays(vals[0], 1))})`);
      case 'before': case 'lt': return atom(`${c} < ${dateParam(ctx, day(vals[0]))}`);
      case 'lte': return atom(`${c} < ${dateParam(ctx, addDays(vals[0], 1))}`);
      case 'after': case 'gt': return atom(`${c} >= ${dateParam(ctx, addDays(vals[0], 1))}`);
      case 'gte': return atom(`${c} >= ${dateParam(ctx, day(vals[0]))}`);
      case 'between': return compound(`${c} >= ${dateParam(ctx, day(vals[0]))} AND ${c} < ${dateParam(ctx, addDays(vals[1], 1))}`);
    }
    return null;
  }
  const op = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', before: '<', after: '>' }[cond.op as 'eq'];
  if (cond.op === 'between') {
    if (dayUpper) return compound(`${c} >= ${dateParam(ctx, vals[0])} AND ${c} < ${dateParam(ctx, addDays(vals[1], 1))}`);
    return atom(`${c} BETWEEN ${dateParam(ctx, vals[0])} AND ${dateParam(ctx, vals[1])}`);
  }
  return op ? atom(`${c} ${op} ${dateParam(ctx, vals[0])}`) : null;
}

interface Split {
  server: FilterNode | null;
  client: FilterNode | null;
}

/** Separate what SQL can express from what must stay client-side, preserving AND/OR semantics. */
export function splitForServer(node: FilterNode | null, columns: readonly ColumnInfo[]): Split {
  if (!node) return { server: null, client: null };
  if (node.kind === 'condition') {
    if (node.enabled === false) return { server: null, client: null };
    const ci = resolveColumn(columns, node.column, node.ordinal);
    if (ci < 0 || conditionProblem(node, columns[ci].kind)) return { server: null, client: null };
    return OPERATOR_INFO[node.op]?.server ? { server: node, client: null } : { server: null, client: node };
  }
  const parts = node.items.map((i) => splitForServer(i, columns));
  const servers = parts.map((p) => p.server).filter((x): x is FilterNode => x !== null);
  const clients = parts.map((p) => p.client).filter((x): x is FilterNode => x !== null);
  if (node.logic === 'and' && !node.negate) {
    return {
      server: servers.length ? { ...node, items: servers } : null,
      client: clients.length ? { ...node, items: clients } : null,
    };
  }
  // OR / NOT: only all-or-nothing is equivalent.
  if (clients.length === 0) return { server: servers.length ? { ...node, items: servers } : null, client: null };
  return { server: null, client: node };
}

function nodeSql(ctx: Ctx, n: FilterNode, top: boolean): Piece | null {
  if (n.kind === 'condition') return conditionSql(ctx, n);
  const parts = n.items.map((i) => nodeSql(ctx, i, false)).filter((x): x is Piece => !!x);
  if (parts.length === 0) return null;
  const joined = joinPieces(parts, n.logic === 'and' ? ' AND ' : ' OR ');
  if (n.negate) return atom(`NOT (${joined.sql})`);
  // Nested groups carry their own parentheses (readable SQL); the top level is wrapped by the caller when needed.
  if (!top && parts.length > 1) return atom(`(${joined.sql})`);
  return joined;
}

/** Free-text search pushed as OR of LIKEs over the string columns. */
function quickSql(ctx: Ctx, quick: string): Piece | null {
  const q = quick.trim();
  if (!q) return null;
  const cols = ctx.columns.filter((c) => kindClass(c.kind) === 'string' && c.kind !== 'guid');
  if (cols.length === 0) return null;
  const d = ctx.dialect;
  const p = ctx.pb.add('string', escapeLike(q, d));
  const pattern = concat(d, ["'%'", d === 'plsql' ? `UPPER(${p})` : p, "'%'"]);
  const parts = cols.map((c) => {
    let ref = colRef(ctx, c);
    if (d === 'tsql' && (c.kind === 'xml' || c.kind === 'json')) ref = `CAST(${ref} AS NVARCHAR(MAX))`;
    return `${d === 'plsql' ? `UPPER(${ref})` : ref} LIKE ${pattern} ${LIKE_ESCAPE}`;
  });
  return atom(parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`);
}

export function buildPredicate(
  filter: FilterGroup | null,
  columns: readonly ColumnInfo[],
  dialect: Dialect,
  opts: PredicateOptions & { quick?: string; builder?: ParamBuilder } = {},
): PredicateResult {
  const pb = opts.builder ?? new ParamBuilder(dialect, opts.paramPrefix ?? 'fp');
  const ctx: Ctx = { dialect, columns, pb, alias: opts.alias ?? null, now: opts.now, warnings: [], count: 0 };
  const { server, client } = splitForServer(filter, columns);
  const parts: Piece[] = [];
  const main = server ? nodeSql(ctx, server, true) : null;
  if (main) parts.push(main);
  const quick = opts.quick ? quickSql(ctx, opts.quick) : null;
  if (quick) parts.push(quick);
  const where = parts.length === 0 ? null : joinPieces(parts, ' AND ').sql;
  const clientOnly: FilterGroup | null = !client ? null : client.kind === 'group' ? client : { kind: 'group', id: 'client', logic: 'and', items: [client] };
  if (clientOnly) ctx.warnings.push('Regular expressions are applied in the grid after the server filter');
  return { where, params: pb.params, clientOnly, serverConditions: ctx.count, warnings: ctx.warnings };
}

/** Human-readable SQL with parameters substituted (preview/tooltips only; never executed). */
export function inlineParams(sql: string, params: readonly ExecParam[], dialect: Dialect): string {
  const byName = new Map(params.map((p) => [p.name, p]));
  const re = dialect === 'plsql' ? /:([A-Za-z_][\w$#]*)/g : /@([A-Za-z_][\w$#]*)/g;
  return sql.replace(re, (m, name: string) => {
    const p = byName.get(name);
    if (!p) return m;
    return literal(p.value, p.kind, dialect);
  });
}

export function literal(v: FilterValue, kind: ParamKind, dialect: Dialect): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  if (kind === 'int' || kind === 'float' || kind === 'decimal') return v;
  const s = `'${v.replace(/'/g, "''")}'`;
  if (dialect === 'tsql' && kind === 'string') return `N${s}`;
  if (dialect === 'plsql' && (kind === 'datetime' || kind === 'date')) return `TIMESTAMP '${v.replace('T', ' ')}'`;
  return s;
}

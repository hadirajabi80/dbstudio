// The statement behind a result grid (console result set, Data tab page): shown under the grid, copied with its bind
// values inlined as literals of the dialect (runnable as is), or with its placeholders kept ("Copy with parameters"),
// and opened in a new console. Grids publish their query here under their grid key; the results.* commands
// (./commands.ts) act on the grid named by `args.gridKey`, else on the grid that last had focus.
import type { Dialect, QueryParam } from '../../api/types';
import { copyText, newConsole } from '../../app/actions';
import { literal } from '../../filter/sql';
import { getSpec, tokenize, type Token } from '../../intel';
import { splitStatements } from '../../intel/split/splitter';
import { base64ToHex } from '../../lib/format';
import type { ExecutionState, ResultSetState } from '../../store/resultsReducer';
import { activeGridController } from '../Grid/controller';

export interface ExecutedQuery {
  /** The statement as sent to the engine (placeholders intact). */
  sql: string;
  /** Bind values it ran with (empty when none). */
  params: readonly QueryParam[];
  dialect: Dialect;
  connectionId: string;
  database: string | null;
}

export interface InlinedSql {
  sql: string;
  /** At least one placeholder was replaced by a literal. */
  inlined: boolean;
}

/** SQL literal of one bind value: the filter builder's literal(), plus the kinds it does not cover for every dialect. */
export function bindLiteral(p: Pick<QueryParam, 'kind' | 'value'>, dialect: Dialect): string {
  const v = p.value;
  if (v === null || v === undefined || p.kind === 'null') return 'NULL';
  if (typeof v === 'string') {
    // A numeric kind carrying a non-numeric text is quoted, never pasted into the statement raw.
    if ((p.kind === 'int' || p.kind === 'float' || p.kind === 'decimal') && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) {
      return literal(v, 'string', dialect);
    }
    if (p.kind === 'binary' && dialect !== 'pgsql') {
      const hex = base64ToHex(v).replace(/\s+/g, '').toUpperCase();
      if (dialect === 'tsql') return `0x${hex}`;
      if (dialect === 'sqlite') return `X'${hex}'`;
      return `HEXTORAW('${hex}')`;
    }
    if (dialect === 'plsql' && p.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `DATE '${v}'`;
    if (dialect === 'plsql' && p.kind === 'datetimeoffset') return `TIMESTAMP '${v.replace('T', ' ').replace(/Z$/, ' +00:00').replace(/'/g, "''")}'`;
    if (p.kind === 'bool' && /^(true|false|1|0)$/i.test(v)) return literal(/^(true|1)$/i.test(v), 'bool', dialect);
  }
  return literal(v, p.kind, dialect);
}

const SIG = (t: Token) => t.kind !== 'ws' && t.kind !== 'comment' && t.kind !== 'eof';
const bare = (name: string) => name.replace(/^[@:$?]/, '').replace(/^"|"$/g, '');

/**
 * Replace the bind placeholders of `sql` by literals of their values (strings quoted with doubled quotes, N'' for
 * T-SQL text, NULL, numbers, booleans, dates per dialect). Uses the intel lexer, so placeholders inside strings and
 * comments are left alone, as are names without a value (T-SQL variables DECLAREd in the batch, `@@ROWCOUNT`,
 * `::type` casts), out parameters and ref cursors. Placeholders: `@name` (T-SQL, SQLite, PostgreSQL), `:name`
 * (Oracle, SQLite, PostgreSQL), `$n` (PostgreSQL), `$name` / `?` / `?n` (SQLite), `?` (positional elsewhere but
 * PostgreSQL, where it is a jsonb operator).
 */
export function inlineBinds(sql: string, params: readonly QueryParam[], dialect: Dialect): InlinedSql {
  const values = params.filter((p) => p.direction !== 'out' && p.kind !== 'refcursor');
  if (!values.length || !sql) return { sql, inlined: false };
  const exact = new Map<string, QueryParam>();
  const folded = new Map<string, QueryParam>();
  for (const p of values) {
    const n = bare(p.name);
    if (!exact.has(n)) exact.set(n, p);
    if (!folded.has(n.toUpperCase())) folded.set(n.toUpperCase(), p);
  }
  const lookup = (name: string) => exact.get(name) ?? folded.get(name.toUpperCase());
  let positional = 0;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const t of tokenize(sql, getSpec(dialect)).filter(SIG)) {
    let p: QueryParam | undefined;
    const text = t.text;
    if (t.kind === 'param') {
      if (text.startsWith('@@') || text.startsWith('&')) continue;
      if (text.startsWith(':') && sql[t.start - 1] === ':') continue; // x::type
      if (text.startsWith('?')) {
        if (dialect === 'pgsql') continue;
        p = text.length > 1 ? lookup(text.slice(1)) : lookup(String(++positional));
      } else if (text.startsWith('$') && dialect === 'pgsql' && !/^\$\d+$/.test(text)) continue;
      else p = lookup(bare(text));
    } else if (text === '?' && dialect !== 'pgsql') {
      p = lookup(String(++positional));
    }
    if (p) edits.push({ start: t.start, end: t.end, text: bindLiteral(p, dialect) });
  }
  if (!edits.length) return { sql, inlined: false };
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += sql.slice(at, e.start) + e.text;
    at = e.end;
  }
  return { sql: out + sql.slice(at), inlined: true };
}

/** What "Copy query" puts on the clipboard (values inlined when the statement had binds). */
export function runnableSql(q: ExecutedQuery): InlinedSql {
  return inlineBinds(q.sql, q.params, q.dialect);
}

/** True when the statement ran with bind values ("Copy with parameters" is then a different text). */
export function hasBinds(q: ExecutedQuery): boolean {
  return q.params.some((p) => p.direction !== 'out');
}

/** "Copy with parameters": the statement as sent, its bind values listed after it as a comment. */
export function parameterisedSql(q: ExecutedQuery): string {
  const binds = q.params.filter((p) => p.direction !== 'out' && p.kind !== 'refcursor');
  if (!binds.length) return q.sql;
  const prefix = (n: string) => (/^[@:$?]/.test(n) ? n : /^\d+$/.test(n) ? (q.dialect === 'pgsql' ? `$${n}` : `?${n}`) : `${q.dialect === 'plsql' ? ':' : '@'}${n}`);
  const lines = binds.map((p) => `--   ${prefix(p.name)} (${p.kind}) = ${bindLiteral(p, q.dialect)}`);
  return `${q.sql.replace(/\s+$/, '')}\n-- Parameters:\n${lines.join('\n')}`;
}

/**
 * The statement that produced `rs`: its batch as sent (with a server filter: the rewritten statement that ran). A
 * T-SQL batch (GO-delimited) may hold several statements: when it returned several result sets and has exactly as
 * many SELECTs, the one matching the result set's position is picked; otherwise the whole batch.
 */
export function resultStatement(
  exec: Pick<ExecutionState, 'batches'> & { resultSets: readonly Pick<ResultSetState, 'id' | 'batchIndex'>[] },
  rs: Pick<ResultSetState, 'id' | 'batchIndex'>,
  dialect: Dialect,
): string | null {
  const batch = exec.batches[rs.batchIndex] ?? (exec.batches.length === 1 ? exec.batches[0] : undefined);
  if (!batch) return null;
  const sql = batch.sql.trim();
  const siblings = exec.resultSets.filter((r) => r.batchIndex === rs.batchIndex);
  if (siblings.length <= 1) return sql;
  const spec = getSpec(dialect);
  const selects = splitStatements(tokenize(sql, spec), sql, spec, { blankLineSplitsStatements: false }).statements.filter((s) => s.kind.startsWith('select'));
  const at = siblings.findIndex((r) => r.id === rs.id);
  return selects.length === siblings.length && at >= 0 ? selects[at].text : sql;
}

// ---------------- grid key → query ----------------

const queries = new Map<string, ExecutedQuery>();

/** A grid publishes (or withdraws, with null) the statement behind its rows. */
export function setExecutedQuery(gridKey: string, q: ExecutedQuery | null): void {
  if (q) queries.set(gridKey, q);
  else queries.delete(gridKey);
}

/** The query of the grid named by `args.gridKey`, else of the grid that last had focus. */
export function executedQueryOf(args?: unknown): ExecutedQuery | undefined {
  const k = args && typeof args === 'object' ? (args as { gridKey?: unknown }).gridKey : undefined;
  const key = typeof k === 'string' ? k : activeGridController()?.key;
  return key ? queries.get(key) : undefined;
}

export async function copyExecutedQuery(q: ExecutedQuery, withParams = false): Promise<void> {
  if (withParams) return copyText(parameterisedSql(q), 'Copied the query with its parameters');
  const r = runnableSql(q);
  return copyText(r.sql, r.inlined ? 'Copied the query (values inlined)' : 'Copied the query');
}

/** A new console on the grid's connection and database with the runnable statement. Returns the new tab id. */
export function openExecutedQueryInConsole(q: ExecutedQuery): string {
  const sql = runnableSql(q).sql.replace(/\s+$/, '');
  return newConsole(q.connectionId, q.database, `${sql}\n`);
}

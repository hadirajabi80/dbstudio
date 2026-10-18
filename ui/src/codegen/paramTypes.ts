// Types of a query's bind parameters inferred from the columns they are compared with (`WHERE c.Id = @id`,
// `o.Total > ?`, `CountryId IN (:a, :b)`, `BETWEEN :from AND :to`, `INSERT INTO t (a, b) VALUES (?, ?)`,
// `SET Name = :name`), resolved through the FROM/JOIN/UPDATE/INTO aliases against the catalog snapshot.
// Parameters with nothing to go on stay out of the result (callers default them to string). Pure TypeScript.
import type { CatalogObject, CatalogSnapshot, Dialect } from '../api/types';
import { getSpec } from '../intel/dialect';
import { tokenize } from '../intel/lexer/lexer';
import type { Token } from '../intel/types';
import type { QueryParamType } from './model';
import { paramTokens } from './sqlgen';
import { resolveType, type Logical } from './types';

const LOGICAL_PARAM: Partial<Record<Logical, QueryParamType>> = {
  bool: 'bool', uint8: 'int', int16: 'int', int32: 'int', int64: 'long', decimal: 'decimal', float32: 'float', float64: 'float',
  string: 'string', xml: 'string', json: 'string', date: 'date', datetime: 'datetime', datetimeoffset: 'datetimeoffset', time: 'time',
  guid: 'guid', binary: 'binary', rowversion: 'binary',
};

/** Query parameter type for a column's database type text. */
export function paramTypeOfColumn(dialect: Dialect, dbType: string): QueryParamType {
  return LOGICAL_PARAM[resolveType(dialect, dbType).logical] ?? 'string';
}

const COMPARE = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '==']);
const COMPARE_WORDS = new Set(['LIKE']);
const COUNT_WORDS = new Set(['LIMIT', 'OFFSET', 'TOP', 'FETCH']);
const ALIAS_STOP = new Set([
  'WHERE', 'ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL', 'GROUP', 'ORDER', 'HAVING', 'LIMIT',
  'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'MINUS', 'SET', 'VALUES', 'SELECT', 'USING', 'WITH', 'OUTPUT', 'RETURNING', 'FETCH',
  'FOR', 'WINDOW', 'APPLY', 'PIVOT', 'UNPIVOT', 'DEFAULT', 'AS',
]);

interface TableRef {
  schema: string | null;
  name: string;
  alias: string | null;
}

const unquote = (t: Token) => (t.kind === 'quotedIdent' ? t.text.slice(1, -1).replace(/""/g, '"').replace(/]]/g, ']') : t.text);
const isName = (t: Token | undefined) => !!t && (t.kind === 'ident' || t.kind === 'quotedIdent');

/** Infer the type of every parameter compared with (or assigned to) a known column. Keys are codegen parameter names. */
export function inferQueryParamTypes(sql: string, dialect: Dialect, snapshot: Pick<CatalogSnapshot, 'schemas' | 'defaultSchema'> | null): Record<string, QueryParamType> {
  if (!snapshot) return {};
  const all = tokenize(sql, getSpec(dialect));
  const toks = all.filter((t) => t.kind !== 'ws' && t.kind !== 'comment' && t.kind !== 'eof');
  const params = paramTokens(sql, dialect);
  if (!params.length) return {};
  const nameAt = new Map(params.map((p) => [p.start, p.name]));
  const refs = tableRefs(toks);
  const lookup = (qualifier: string | null, column: string) => columnType(snapshot, dialect, refs, qualifier, column);
  const out: Record<string, QueryParamType> = {};
  const put = (name: string | undefined, t: QueryParamType | null) => {
    if (name && t && !out[name]) out[name] = t;
  };

  /** `[q .] col` ending at index k (inclusive) → [qualifier, column] or null. */
  const colEndingAt = (k: number): [string | null, string] | null => {
    if (!isName(toks[k])) return null;
    if (toks[k - 1]?.text === '.' && isName(toks[k - 2])) return [unquote(toks[k - 2]), unquote(toks[k])];
    return [null, unquote(toks[k])];
  };
  /** `[q .] col` starting at index k → [qualifier, column] or null. */
  const colStartingAt = (k: number): [string | null, string] | null => {
    if (!isName(toks[k])) return null;
    if (toks[k + 1]?.text === '.' && isName(toks[k + 2])) return [unquote(toks[k]), unquote(toks[k + 2])];
    return [null, unquote(toks[k])];
  };
  const typeOf = (c: [string | null, string] | null) => (c ? lookup(c[0], c[1]) : null);

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'param') continue;
    const name = nameAt.get(t.start);
    if (!name) continue;
    const prev = toks[i - 1], next = toks[i + 1];
    // col <op> param / param <op> col
    if (prev && (COMPARE.has(prev.text) || COMPARE_WORDS.has(prev.upper))) {
      let k = i - 2;
      if (prev.upper === 'LIKE' && toks[k]?.upper === 'NOT') k--;
      put(name, typeOf(colEndingAt(k)));
    }
    if (next && COMPARE.has(next.text)) put(name, typeOf(colStartingAt(i + 2)));
    // LIMIT ? / OFFSET ? / TOP (?) / FETCH NEXT ? ROWS
    if (prev && (COUNT_WORDS.has(prev.upper) || (prev.text === '(' && toks[i - 2]?.upper === 'TOP') || prev.upper === 'NEXT' || prev.upper === 'FIRST')) put(name, 'int');
    // col BETWEEN p AND p2
    const between = prev?.upper === 'BETWEEN' ? i - 1 : prev?.upper === 'AND' && toks[i - 3]?.upper === 'BETWEEN' ? i - 3 : -1;
    if (between > 0) put(name, typeOf(colEndingAt(between - 1)));
    // col IN (p1, p2, ...)
    if (prev && (prev.text === '(' || prev.text === ',')) {
      let k = i - 1;
      while (k > 0 && toks[k].text === ',' && (toks[k - 1].kind === 'param' || toks[k - 1].kind === 'string' || toks[k - 1].kind === 'number')) k -= 2;
      if (toks[k]?.text === '(' && toks[k - 1]?.upper === 'IN') {
        let c = k - 2;
        if (toks[c]?.upper === 'NOT') c--;
        put(name, typeOf(colEndingAt(c)));
      }
    }
  }
  inferInsertValues(toks, nameAt, lookup, put);
  return out;
}

/** INSERT INTO t (a, b, c) VALUES (?, :b, @c): the n-th value takes the n-th column's type. */
function inferInsertValues(
  toks: Token[], nameAt: Map<number, string>, lookup: (q: string | null, c: string) => QueryParamType | null,
  put: (name: string | undefined, t: QueryParamType | null) => void,
): void {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].upper !== 'INTO') continue;
    let k = i + 1;
    while (isName(toks[k]) && toks[k + 1]?.text === '.') k += 2;
    if (!isName(toks[k])) continue;
    const table = unquote(toks[k]);
    k++;
    if (toks[k]?.text !== '(') continue;
    const cols: string[] = [];
    k++;
    while (k < toks.length && toks[k].text !== ')') {
      if (isName(toks[k])) cols.push(unquote(toks[k]));
      k++;
    }
    k++;
    if (toks[k]?.upper !== 'VALUES' || toks[k + 1]?.text !== '(') continue;
    k += 2;
    let n = 0;
    let depth = 0;
    for (; k < toks.length; k++) {
      const t = toks[k];
      if (t.text === '(') depth++;
      else if (t.text === ')') {
        if (depth === 0) break;
        depth--;
      } else if (t.text === ',' && depth === 0) n++;
      else if (t.kind === 'param' && depth === 0 && (toks[k - 1].text === '(' || toks[k - 1].text === ',') && (toks[k + 1]?.text === ',' || toks[k + 1]?.text === ')')) {
        const col = cols[n];
        if (col) put(nameAt.get(t.start), lookup(table, col));
      }
    }
  }
}

/** Tables named after FROM / JOIN / UPDATE / INTO (and comma lists after FROM), with their aliases. */
function tableRefs(toks: Token[]): TableRef[] {
  const out: TableRef[] = [];
  const parse = (k: number): number => {
    if (!isName(toks[k])) return k;
    const parts = [unquote(toks[k])];
    while (toks[k + 1]?.text === '.' && isName(toks[k + 2])) {
      parts.push(unquote(toks[k + 2]));
      k += 2;
    }
    k++;
    if (toks[k]?.text === '(') return k; // table-valued function: no columns known
    let alias: string | null = null;
    if (toks[k]?.upper === 'AS' && isName(toks[k + 1])) {
      alias = unquote(toks[k + 1]);
      k += 2;
    } else if (isName(toks[k]) && !ALIAS_STOP.has(toks[k].upper)) {
      alias = unquote(toks[k]);
      k++;
    }
    const name = parts[parts.length - 1];
    out.push({ schema: parts.length > 1 ? parts[parts.length - 2] : null, name, alias });
    return k;
  };
  for (let i = 0; i < toks.length; i++) {
    const u = toks[i].upper;
    if (u === 'FROM' || u === 'JOIN' || u === 'UPDATE' || u === 'INTO') {
      let k = parse(i + 1);
      if (u === 'FROM') while (toks[k]?.text === ',') k = parse(k + 1);
    }
  }
  return out;
}

function findObject(snapshot: Pick<CatalogSnapshot, 'schemas' | 'defaultSchema'>, schema: string | null, name: string): CatalogObject | null {
  const key = name.toLowerCase();
  const schemas = schema
    ? snapshot.schemas.filter((s) => s.name.toLowerCase() === schema.toLowerCase())
    : [...snapshot.schemas.filter((s) => s.name === snapshot.defaultSchema), ...snapshot.schemas.filter((s) => s.name !== snapshot.defaultSchema)];
  for (const s of schemas) {
    const o = s.objects.find((x) => (x.t === 'table' || x.t === 'view' || x.t === 'mview') && x.n.toLowerCase() === key);
    if (o) return o;
  }
  return null;
}

function columnType(
  snapshot: Pick<CatalogSnapshot, 'schemas' | 'defaultSchema'>, dialect: Dialect, refs: TableRef[], qualifier: string | null, column: string,
): QueryParamType | null {
  const col = column.toLowerCase();
  const candidates = qualifier
    ? refs.filter((r) => (r.alias ?? r.name).toLowerCase() === qualifier.toLowerCase() || r.name.toLowerCase() === qualifier.toLowerCase())
    : refs;
  // A qualifier that is not an alias in this statement may still be a table name (`Customers.Id`).
  const list = candidates.length || !qualifier ? candidates : [{ schema: null, name: qualifier, alias: null }];
  for (const r of list) {
    const o = findObject(snapshot, r.schema, r.name);
    const c = o?.c?.find((x) => x[0].toLowerCase() === col);
    if (c) return paramTypeOfColumn(dialect, c[1]);
  }
  return null;
}

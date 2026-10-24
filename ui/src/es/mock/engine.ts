// A small in-memory Elasticsearch for the mock engine (dev:mock, MSW tests): indices with mappings and versioned
// documents, a query DSL evaluator (match_all, match, match_phrase, multi_match, query_string, term(s), range, exists,
// prefix, wildcard, ids, bool, nested, constant_score), sort, paging, _source filtering, highlighting, aggregations
// (terms, metrics, stats, cardinality, histogram, date_histogram, range, filter(s), nested, top_hits, missing), the
// `_cat` APIs, a tiny SQL subset and a Dev Tools dispatcher. Responses mirror Elasticsearch 8.15. Not a search engine:
// enough to make the UI realistic.
import type {
  EsAlias, EsCluster, EsConsoleResponse, EsField, EsHit, EsIndexDetail, EsIndexSummary, EsNode, EsSearchResponse, EsShard, EsSqlResponse, EsTask,
} from '../../api/types.es';
import { isPlainObject } from '../json';
import { MOCK_TEMPLATES, seedIndices, type Source } from './data';

export interface MockDoc { id: string; source: Source; seqNo: number; primaryTerm: number; version: number }
export interface MockIndex {
  name: string;
  uuid: string;
  mappings: Source;
  settings: { shards: number; replicas: number; refreshInterval: string; maxResultWindow: number };
  aliases: Map<string, { isWriteIndex: boolean | null; filter: unknown }>;
  docs: Map<string, MockDoc>;
  status: 'open' | 'close';
  hidden: boolean;
  dataStream: string | null;
  createdAt: number;
  seq: number;
  stats: { indexTotal: number; queryTotal: number; getTotal: number };
}

export class EsMockError extends Error {
  readonly status: number;
  readonly esType: string;

  constructor(status: number, esType: string, reason: string) {
    super(reason);
    this.status = status;
    this.esType = esType;
  }

  body() {
    return { error: { root_cause: [{ type: this.esType, reason: this.message }], type: this.esType, reason: this.message }, status: this.status };
  }
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
let uuidSeq = 0;
const uuid = () => `mOck${(++uuidSeq).toString(36).padStart(4, '0')}Uu1dX${'abcdefgh'[uuidSeq % 8]}Q`;

/** Values at a dotted path; arrays flatten. `.keyword` multi-field suffixes resolve to the parent value. */
export function valuesAt(src: unknown, path: string): unknown[] {
  const parts = path.split('.');
  let cur: unknown[] = [src];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next: unknown[] = [];
    for (const c of cur) {
      if (Array.isArray(c)) {
        for (const x of c) if (isPlainObject(x) && part in x) next.push(x[part]);
      } else if (isPlainObject(c) && part in c) next.push(c[part]);
    }
    if (!next.length && (part === 'keyword' || part === 'raw') && i === parts.length - 1) return cur.flat().filter((x) => x !== undefined && x !== null);
    cur = next;
  }
  return cur.flat().filter((x) => x !== undefined && x !== null);
}

const isDateLike = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
const comparable = (v: unknown): number | string => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (v === 'now') return Date.now();
    const m = /^now([+-])(\d+)([dhmMyw])/.exec(v);
    if (m) {
      const unit = { d: 864e5, h: 36e5, m: 6e4, M: 30 * 864e5, y: 365 * 864e5, w: 7 * 864e5 }[m[3] as 'd'];
      return Date.now() + (m[1] === '-' ? -1 : 1) * Number(m[2]) * unit;
    }
    if (isDateLike(v)) return Date.parse(v);
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : v;
  }
  return String(v);
};

function cmp(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y));
}

function wildcardRe(p: string, ci = false): RegExp {
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, ci ? 'i' : '');
}

// ---------------------------------------------------------------- query evaluation

/** Score > 0 when `doc` matches `q`. */
function evalQuery(q: unknown, src: Source, ctx: { allFields: string[] }): number {
  if (!isPlainObject(q) || Object.keys(q).length === 0) return 1;
  const [kind, body] = Object.entries(q)[0];
  const b = body as Record<string, unknown>;
  switch (kind) {
    case 'match_all': return 1;
    case 'match_none': return 0;
    case 'match':
    case 'match_phrase':
    case 'match_phrase_prefix':
    case 'match_bool_prefix': {
      const [field, spec] = Object.entries(b)[0] ?? [];
      if (!field) return 1;
      const opts = isPlainObject(spec) ? spec : { query: spec };
      const query = String(opts.query ?? '');
      const vals = valuesAt(src, field).map(String);
      if (kind !== 'match') {
        const needle = query.toLowerCase();
        return vals.some((v) => (kind === 'match_phrase' ? v.toLowerCase().includes(needle) : v.toLowerCase().split(/\s+/).some((_w, i, all) => all.slice(i).join(' ').startsWith(needle)))) ? 2 : 0;
      }
      const qt = tokenize(query);
      if (!qt.length) return opts.zero_terms_query === 'all' ? 1 : 0;
      const vt = new Set(vals.flatMap(tokenize));
      const hits = qt.filter((t) => vt.has(t)).length;
      const and = String(opts.operator ?? 'or').toLowerCase() === 'and';
      if (and ? hits < qt.length : hits === 0) return 0;
      return 1 + hits / Math.max(1, vt.size);
    }
    case 'multi_match':
    case 'combined_fields': {
      const fields = Array.isArray(b.fields) && b.fields.length ? (b.fields as string[]).map((f) => f.replace(/\^.*$/, '')) : ctx.allFields;
      let best = 0;
      for (const f of fields) {
        const s = f.includes('*') ? Math.max(0, ...ctx.allFields.filter((x) => wildcardRe(f).test(x)).map((x) => evalQuery({ match: { [x]: { query: b.query, operator: b.operator } } }, src, ctx)))
          : evalQuery({ match: { [f]: { query: b.query, operator: b.operator } } }, src, ctx);
        best = Math.max(best, s);
      }
      return best;
    }
    case 'query_string':
    case 'simple_query_string':
      return queryString(String(b.query ?? ''), src, ctx, String(b.default_operator ?? 'OR').toUpperCase() === 'AND', b.default_field as string | undefined) ? 1 : 0;
    case 'term': {
      const [field, spec] = Object.entries(b)[0] ?? [];
      const value = isPlainObject(spec) ? spec.value : spec;
      const ci = isPlainObject(spec) && spec.case_insensitive === true;
      return valuesAt(src, field).some((v) => (ci ? String(v).toLowerCase() === String(value).toLowerCase() : v === value || String(v) === String(value))) ? 1 : 0;
    }
    case 'terms': {
      const [field, list] = Object.entries(b).find(([k]) => k !== 'boost') ?? [];
      const wanted = new Set((Array.isArray(list) ? list : []).map(String));
      return valuesAt(src, String(field ?? '')).some((v) => wanted.has(String(v))) ? 1 : 0;
    }
    case 'ids': return Array.isArray(b.values) && (b.values as string[]).includes(String(src.__id)) ? 1 : 0;
    case 'range': {
      const [field, spec] = Object.entries(b)[0] ?? [];
      const r = (spec ?? {}) as Record<string, unknown>;
      return valuesAt(src, field).some((v) => (r.gte === undefined || cmp(v, r.gte) >= 0) && (r.gt === undefined || cmp(v, r.gt) > 0)
        && (r.lte === undefined || cmp(v, r.lte) <= 0) && (r.lt === undefined || cmp(v, r.lt) < 0)) ? 1 : 0;
    }
    case 'exists': return valuesAt(src, String(b.field)).length > 0 ? 1 : 0;
    case 'prefix': {
      const [field, spec] = Object.entries(b)[0] ?? [];
      const value = String(isPlainObject(spec) ? spec.value : spec);
      return valuesAt(src, field).some((v) => String(v).startsWith(value)) ? 1 : 0;
    }
    case 'wildcard':
    case 'regexp': {
      const [field, spec] = Object.entries(b)[0] ?? [];
      const value = String(isPlainObject(spec) ? spec.value ?? spec.wildcard : spec);
      const ci = isPlainObject(spec) && spec.case_insensitive === true;
      const re = kind === 'wildcard' ? wildcardRe(value, ci) : new RegExp(`^(?:${value})$`, ci ? 'i' : '');
      return valuesAt(src, field).some((v) => re.test(String(v))) ? 1 : 0;
    }
    case 'fuzzy': {
      const [field, spec] = Object.entries(b)[0] ?? [];
      const value = String(isPlainObject(spec) ? spec.value : spec).toLowerCase();
      return valuesAt(src, field).some((v) => tokenize(String(v)).some((t) => t.startsWith(value.slice(0, Math.max(1, value.length - 2))))) ? 1 : 0;
    }
    case 'bool': {
      const list = (x: unknown) => (Array.isArray(x) ? x : x ? [x] : []);
      const must = list(b.must);
      const filter = list(b.filter);
      const should = list(b.should);
      const not = list(b.must_not);
      let score = 0;
      for (const m of must) {
        const s = evalQuery(m, src, ctx);
        if (!s) return 0;
        score += s;
      }
      for (const f of filter) if (!evalQuery(f, src, ctx)) return 0;
      for (const n of not) if (evalQuery(n, src, ctx)) return 0;
      const shouldHits = should.map((s) => evalQuery(s, src, ctx)).filter((s) => s > 0);
      const min = b.minimum_should_match !== undefined ? Number(String(b.minimum_should_match).replace('%', '')) || 1 : must.length || filter.length ? 0 : should.length ? 1 : 0;
      if (shouldHits.length < Math.min(min, should.length)) return 0;
      score += shouldHits.reduce((a, s) => a + s, 0);
      return score || 1;
    }
    case 'nested': {
      const path = String(b.path);
      const items = valuesAt(src, path);
      let best = 0;
      for (const it of items) best = Math.max(best, evalQuery(b.query, nestAt(path, it), ctx));
      return best;
    }
    case 'constant_score': return evalQuery(b.filter, src, ctx) ? Number(b.boost ?? 1) : 0;
    case 'dis_max': return Math.max(0, ...((b.queries as unknown[]) ?? []).map((x) => evalQuery(x, src, ctx)));
    case 'function_score': return evalQuery(b.query ?? { match_all: {} }, src, ctx);
    case 'boosting': return evalQuery(b.positive, src, ctx) ? (evalQuery(b.negative, src, ctx) ? Number(b.negative_boost ?? 0.5) : 1) : 0;
    default:
      throw new EsMockError(400, 'parsing_exception', `unknown query [${kind}]`);
  }
}

/** `{ items: item }` so that `items.sku` resolves inside a nested query/aggregation. */
function nestAt(path: string, item: unknown): Source {
  const parts = path.split('.');
  let out: unknown = item;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i]]: out };
  return out as Source;
}

function queryString(q: string, src: Source, ctx: { allFields: string[] }, andDefault: boolean, defaultField?: string): boolean {
  const text = q.trim();
  if (!text || text === '*') return true;
  const groups = text.split(/\s+OR\s+/);
  if (groups.length > 1) return groups.some((g) => queryString(g, src, ctx, true, defaultField));
  const terms = text.match(/(-|\+|NOT\s+)?(?:[\w.@*]+:)?(?:"[^"]*"|\[[^\]]*\]|[^\s]+)/g) ?? [];
  const results: boolean[] = [];
  for (const raw of terms) {
    if (raw === 'AND') continue;
    const neg = /^(-|NOT\s+)/.test(raw);
    const t = raw.replace(/^(-|\+|NOT\s+)/, '');
    const m = /^([\w.@*]+):(.*)$/.exec(t);
    const field = m ? m[1] : defaultField;
    let value = m ? m[2] : t;
    let ok: boolean;
    const strVals = (f?: string) => (f ? valuesAt(src, f) : ctx.allFields.flatMap((x) => valuesAt(src, x))).map(String);
    if (/^\[.* TO .*\]$/.test(value)) {
      const [lo, hi] = value.slice(1, -1).split(' TO ').map((x) => x.trim());
      ok = !!field && valuesAt(src, field).some((v) => (lo === '*' || cmp(v, lo) >= 0) && (hi === '*' || cmp(v, hi) <= 0));
    } else if (/^(>=|<=|>|<)/.test(value)) {
      const op = /^(>=|<=|>|<)/.exec(value)![1];
      const x = value.slice(op.length);
      ok = !!field && valuesAt(src, field).some((v) => {
        const c = cmp(v, x);
        return op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0;
      });
    } else {
      const phrase = value.startsWith('"') && value.endsWith('"');
      value = value.replace(/^"|"$/g, '');
      if (value === '*') ok = strVals(field).length > 0;
      else if (value.includes('*') || value.includes('?')) {
        const re = wildcardRe(value, true);
        ok = strVals(field).some((v) => re.test(v) || tokenize(v).some((tok) => re.test(tok)));
      } else if (phrase) ok = strVals(field).some((v) => v.toLowerCase().includes(value.toLowerCase()));
      else {
        const qt = tokenize(value);
        ok = strVals(field).some((v) => v.toLowerCase() === value.toLowerCase() || (qt.length > 0 && qt.every((tok) => tokenize(v).includes(tok))));
      }
    }
    results.push(neg ? !ok : ok);
  }
  return andDefault ? results.every(Boolean) : results.some(Boolean) || results.length === 0;
}

// ---------------------------------------------------------------- aggregations

interface AggDoc { id: string; index: string; src: Source; score: number }

function aggregate(aggs: unknown, docs: AggDoc[], ctx: { allFields: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(aggs)) return out;
  for (const [name, def] of Object.entries(aggs)) {
    if (!isPlainObject(def)) continue;
    const sub = def.aggs ?? def.aggregations;
    const kind = Object.keys(def).find((k) => k !== 'aggs' && k !== 'aggregations' && k !== 'meta');
    if (!kind) continue;
    const b = def[kind] as Record<string, unknown>;
    const nums = (field: unknown) => docs.flatMap((d) => valuesAt(d.src, String(field)).map((v) => comparable(v)).filter((v): v is number => typeof v === 'number'));
    const withSub = (o: Record<string, unknown>, ds: AggDoc[]) => (sub ? { ...o, ...aggregate(sub, ds, ctx) } : o);
    switch (kind) {
      case 'terms':
      case 'significant_terms': {
        const counts = new Map<string, { key: unknown; docs: AggDoc[] }>();
        for (const d of docs) {
          const vals = valuesAt(d.src, String(b.field));
          const missing = vals.length === 0 && b.missing !== undefined ? [b.missing] : vals;
          for (const v of new Set(missing.map((x) => JSON.stringify(x)))) {
            const e: { key: unknown; docs: AggDoc[] } = counts.get(v) ?? { key: JSON.parse(v), docs: [] };
            e.docs.push(d);
            counts.set(v, e);
          }
        }
        const order = isPlainObject(b.order) ? Object.entries(b.order)[0] : ['_count', 'desc'];
        let list = [...counts.values()].filter((e) => e.docs.length >= Number(b.min_doc_count ?? 1));
        list.sort((x, y) => {
          const dir = order[1] === 'asc' ? 1 : -1;
          if (order[0] === '_key') return cmp(x.key, y.key) * dir;
          return (x.docs.length - y.docs.length) * dir || cmp(x.key, y.key);
        });
        const size = Number(b.size ?? 10);
        const other = list.slice(size).reduce((n, e) => n + e.docs.length, 0);
        list = list.slice(0, size);
        out[name] = {
          doc_count_error_upper_bound: 0, sum_other_doc_count: other,
          buckets: list.map((e) => withSub({ key: e.key, ...(isDateLike(e.key) ? { key_as_string: e.key } : {}), doc_count: e.docs.length }, e.docs)),
        };
        break;
      }
      case 'avg': case 'sum': case 'min': case 'max': case 'value_count': case 'cardinality': {
        const vals = kind === 'cardinality' || kind === 'value_count' ? docs.flatMap((d) => valuesAt(d.src, String(b.field))) : nums(b.field);
        let value: number | null;
        if (kind === 'value_count') value = vals.length;
        else if (kind === 'cardinality') value = new Set(vals.map((v) => JSON.stringify(v))).size;
        else if (!vals.length) value = kind === 'sum' ? 0 : null;
        else {
          const ns = vals as number[];
          value = kind === 'avg' ? ns.reduce((a, x) => a + x, 0) / ns.length : kind === 'sum' ? ns.reduce((a, x) => a + x, 0) : kind === 'min' ? Math.min(...ns) : Math.max(...ns);
        }
        const isDate = (kind === 'min' || kind === 'max') && docs.some((d) => valuesAt(d.src, String(b.field)).some(isDateLike));
        out[name] = { value: value === null ? null : Math.round(value * 1e6) / 1e6, ...(isDate && value !== null ? { value_as_string: new Date(value).toISOString() } : {}) };
        break;
      }
      case 'stats':
      case 'extended_stats': {
        const ns = nums(b.field);
        const sum = ns.reduce((a, x) => a + x, 0);
        const avg = ns.length ? sum / ns.length : null;
        const r = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
        const o: Record<string, unknown> = { count: ns.length, min: ns.length ? Math.min(...ns) : null, max: ns.length ? Math.max(...ns) : null, avg: r(avg), sum: r(sum) };
        if (kind === 'extended_stats' && avg !== null) {
          const variance = ns.reduce((a, x) => a + (x - avg) ** 2, 0) / ns.length;
          Object.assign(o, { sum_of_squares: r(ns.reduce((a, x) => a + x * x, 0)), variance: r(variance), std_deviation: r(Math.sqrt(variance)) });
        }
        out[name] = o;
        break;
      }
      case 'percentiles': {
        const ns = nums(b.field).sort((x, y) => x - y);
        const pct = (Array.isArray(b.percents) ? b.percents : [1, 5, 25, 50, 75, 95, 99]) as number[];
        out[name] = { values: Object.fromEntries(pct.map((p) => [p.toFixed(1), ns.length ? ns[Math.min(ns.length - 1, Math.floor((p / 100) * ns.length))] : null])) };
        break;
      }
      case 'histogram':
      case 'date_histogram':
      case 'auto_date_histogram': {
        const date = kind !== 'histogram';
        const step = date ? null : Number(b.interval ?? 10);
        const keyOf = (v: unknown): number => {
          const n = comparable(v) as number;
          if (!date) return Math.floor(n / step!) * step!;
          const d = new Date(n);
          const ci = String(b.calendar_interval ?? b.interval ?? (b.fixed_interval ? '' : 'month'));
          const fixed = /^(\d+)([dhm])$/.exec(String(b.fixed_interval ?? ''));
          if (fixed) {
            const ms = Number(fixed[1]) * { d: 864e5, h: 36e5, m: 6e4 }[fixed[2] as 'd'];
            return Math.floor(n / ms) * ms;
          }
          if (/^(1?y|year)/.test(ci)) return Date.UTC(d.getUTCFullYear(), 0, 1);
          if (/^(1?q|quarter)/.test(ci)) return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
          if (/^(1?M|month)/.test(ci)) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
          if (/^(1?w|week)/.test(ci)) {
            const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
            return day - ((d.getUTCDay() + 6) % 7) * 864e5;
          }
          if (/^(1?h|hour)/.test(ci)) return Math.floor(n / 36e5) * 36e5;
          return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        };
        const buckets = new Map<number, AggDoc[]>();
        for (const d of docs) for (const v of valuesAt(d.src, String(b.field))) {
          const k = keyOf(v);
          buckets.set(k, [...(buckets.get(k) ?? []), d]);
        }
        const keys = [...buckets.keys()].sort((x, y) => x - y);
        out[name] = {
          buckets: keys.filter((k) => (buckets.get(k)?.length ?? 0) >= Number(b.min_doc_count ?? 0)).map((k) => withSub({
            ...(date ? { key_as_string: new Date(k).toISOString() } : {}), key: k, doc_count: buckets.get(k)!.length,
          }, buckets.get(k)!)),
        };
        break;
      }
      case 'range':
      case 'date_range': {
        const ranges = (Array.isArray(b.ranges) ? b.ranges : []) as { from?: unknown; to?: unknown; key?: string }[];
        out[name] = {
          buckets: ranges.map((r) => {
            const ds = docs.filter((d) => valuesAt(d.src, String(b.field)).some((v) => (r.from === undefined || cmp(v, r.from) >= 0) && (r.to === undefined || cmp(v, r.to) < 0)));
            const key = r.key ?? `${r.from ?? '*'}-${r.to ?? '*'}`;
            return withSub({ key, ...(r.from !== undefined ? { from: r.from } : {}), ...(r.to !== undefined ? { to: r.to } : {}), doc_count: ds.length }, ds);
          }),
        };
        break;
      }
      case 'filter': {
        const ds = docs.filter((d) => evalQuery(b, d.src, ctx));
        out[name] = withSub({ doc_count: ds.length }, ds);
        break;
      }
      case 'filters': {
        const fs = isPlainObject(b.filters) ? b.filters : {};
        out[name] = { buckets: Object.fromEntries(Object.entries(fs).map(([k, f]) => {
          const ds = docs.filter((d) => evalQuery(f, d.src, ctx));
          return [k, withSub({ doc_count: ds.length }, ds)];
        })) };
        break;
      }
      case 'missing': {
        const ds = docs.filter((d) => valuesAt(d.src, String(b.field)).length === 0);
        out[name] = withSub({ doc_count: ds.length }, ds);
        break;
      }
      case 'nested': {
        const path = String(b.path);
        const ds = docs.flatMap((d) => valuesAt(d.src, path).map((it, i) => ({ ...d, id: `${d.id}#${i}`, src: nestAt(path, it) })));
        out[name] = withSub({ doc_count: ds.length }, ds);
        break;
      }
      case 'top_hits': {
        const ds = sortDocs(docs, b.sort).slice(0, Number(b.size ?? 3));
        out[name] = { hits: { total: { value: docs.length, relation: 'eq' }, max_score: null, hits: ds.map((d) => ({ _index: d.index, _id: d.id, _score: d.score, _source: filterSource(d.src, b._source) })) } };
        break;
      }
      default:
        throw new EsMockError(400, 'parsing_exception', `Unknown aggregation type [${kind}] (the mock supports terms, metrics, histograms, ranges, filters, nested and top_hits)`);
    }
  }
  return out;
}

function sortDocs<T extends { src: Source; score: number; id: string }>(docs: T[], sort: unknown): T[] {
  const specs: { field: string; dir: 1 | -1 }[] = [];
  const add = (field: string, order: unknown) => specs.push({ field, dir: String(isPlainObject(order) ? order.order ?? 'asc' : order ?? (field === '_score' ? 'desc' : 'asc')).toLowerCase() === 'desc' ? -1 : 1 });
  for (const s of Array.isArray(sort) ? sort : sort ? [sort] : []) {
    if (typeof s === 'string') add(s, undefined);
    else if (isPlainObject(s)) for (const [f, o] of Object.entries(s)) add(f, o);
  }
  if (!specs.length) return docs;
  const val = (d: T, f: string): unknown => (f === '_score' ? d.score : f === '_id' || f === '_doc' ? d.id : valuesAt(d.src, f)[0]);
  return [...docs].sort((a, b) => {
    for (const s of specs) {
      const x = val(a, s.field);
      const y = val(b, s.field);
      if (x === undefined && y === undefined) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      const c = cmp(x, y);
      if (c) return c * s.dir;
    }
    return 0;
  });
}

function filterSource(src: Source, spec: unknown): Source | undefined {
  if (spec === false) return undefined;
  if (spec === undefined || spec === true) return stripInternal(src);
  const inc = typeof spec === 'string' ? [spec] : Array.isArray(spec) ? (spec as string[]) : isPlainObject(spec) && Array.isArray(spec.includes) ? (spec.includes as string[]) : [];
  const exc = isPlainObject(spec) && Array.isArray(spec.excludes) ? (spec.excludes as string[]) : [];
  const out: Source = {};
  const clean = stripInternal(src);
  for (const [k, v] of Object.entries(clean)) {
    const keep = !inc.length || inc.some((p) => wildcardRe(p).test(k) || p.startsWith(`${k}.`));
    if (keep && !exc.some((p) => wildcardRe(p).test(k))) out[k] = v;
  }
  return out;
}

function stripInternal(src: Source): Source {
  if (!('__id' in src)) return src;
  const { __id: _drop, ...rest } = src;
  void _drop;
  return rest;
}

function queryTerms(q: unknown, acc: string[] = []): string[] {
  if (Array.isArray(q)) q.forEach((x) => queryTerms(x, acc));
  else if (isPlainObject(q)) {
    for (const [k, v] of Object.entries(q)) {
      if ((k === 'query' && typeof v === 'string') || ((k === 'match' || k === 'match_phrase' || k === 'term') && isPlainObject(v))) {
        if (typeof v === 'string') acc.push(...tokenize(v.replace(/\w+:/g, '')));
        else for (const x of Object.values(v)) acc.push(...tokenize(String(isPlainObject(x) ? x.query ?? x.value ?? '' : x)));
      } else queryTerms(v, acc);
    }
  }
  return acc;
}

function highlight(src: Source, spec: unknown, terms: string[]): Record<string, string[]> | null {
  if (!isPlainObject(spec) || !isPlainObject(spec.fields) || !terms.length) return null;
  const pre = Array.isArray(spec.pre_tags) ? String(spec.pre_tags[0]) : '<em>';
  const post = Array.isArray(spec.post_tags) ? String(spec.post_tags[0]) : '</em>';
  const out: Record<string, string[]> = {};
  const set = new Set(terms);
  for (const f of Object.keys(spec.fields)) {
    const frags = valuesAt(src, f).filter((v) => typeof v === 'string').map((v) => (v as string).replace(/[\p{L}\p{N}]+/gu, (w) => (set.has(w.toLowerCase()) ? `${pre}${w}${post}` : w)))
      .filter((v) => v.includes(pre));
    if (frags.length) out[f] = frags;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- the cluster

export interface MockTask { id: string; action: string; description: string; start: number; status: { total: number; created: number; updated: number; deleted: number; batches: number }; cancelled: boolean }

export class EsMock {
  readonly indices = new Map<string, MockIndex>();
  readonly tasks = new Map<string, MockTask>();
  readonly cursors = new Map<string, { columns: { name: string; type: string }[]; rows: unknown[][]; size: number }>();
  private taskSeq = 1000;
  private cursorSeq = 0;

  readonly flavor: 'elasticsearch' | 'opensearch';

  constructor(flavor: 'elasticsearch' | 'opensearch' = 'elasticsearch') {
    this.flavor = flavor;
    for (const s of seedIndices()) {
      const ix = this.createIndex(s.name, { mappings: s.mappings }, s.shards, s.replicas, true);
      ix.hidden = !!s.hidden;
      ix.dataStream = s.dataStream ?? null;
      ix.createdAt = Date.UTC(2026, 9, 1) + this.indices.size * 3600_000;
      for (const a of s.aliases) ix.aliases.set(a, { isWriteIndex: null, filter: undefined });
      for (const d of s.docs) this.putDoc(ix.name, d.id, d.source, {});
    }
  }

  // ---- names

  resolve(expr: string, opts: { hidden?: boolean; allowMissing?: boolean } = {}): MockIndex[] {
    const out = new Map<string, MockIndex>();
    for (const part of expr.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (part === '_all' || part === '*' || part.includes('*')) {
        const re = wildcardRe(part === '_all' ? '*' : part);
        for (const ix of this.indices.values()) {
          if ((ix.hidden && !opts.hidden && !part.startsWith('.')) || !(re.test(ix.name) || [...ix.aliases.keys()].some((a) => re.test(a)) || (ix.dataStream && re.test(ix.dataStream)))) continue;
          out.set(ix.name, ix);
        }
        continue;
      }
      const direct = this.indices.get(part);
      if (direct) {
        out.set(direct.name, direct);
        continue;
      }
      const viaAlias = [...this.indices.values()].filter((ix) => ix.aliases.has(part) || ix.dataStream === part);
      if (!viaAlias.length && !opts.allowMissing) throw new EsMockError(404, 'index_not_found_exception', `no such index [${part}]`);
      viaAlias.forEach((ix) => out.set(ix.name, ix));
    }
    return [...out.values()];
  }

  writeTarget(expr: string): MockIndex | null {
    const ix = this.indices.get(expr);
    if (ix) return ix;
    const viaAlias = [...this.indices.values()].filter((x) => x.aliases.has(expr) || x.dataStream === expr);
    if (viaAlias.length === 1) return viaAlias[0];
    const writer = viaAlias.find((x) => x.aliases.get(expr)?.isWriteIndex);
    if (writer) return writer;
    if (viaAlias.length > 1) throw new EsMockError(400, 'illegal_argument_exception', `no write index is defined for alias [${expr}]`);
    return null;
  }

  // ---- indices

  createIndex(name: string, body: Source = {}, shards = 1, replicas = 1, seeding = false): MockIndex {
    if (this.indices.has(name)) throw new EsMockError(400, 'resource_already_exists_exception', `index [${name}/${uuid()}] already exists`);
    if (!seeding && (name !== name.toLowerCase() || /[\\/*?"<>| ,#]/.test(name) || /^[-_+]/.test(name))) {
      throw new EsMockError(400, 'invalid_index_name_exception', `Invalid index name [${name}], must be lowercase`);
    }
    const settings = isPlainObject(body.settings) ? (isPlainObject(body.settings.index) ? body.settings.index : body.settings) : {};
    const ix: MockIndex = {
      name, uuid: uuid(), mappings: isPlainObject(body.mappings) ? (body.mappings as Source) : { properties: {} },
      settings: { shards: Number(settings.number_of_shards ?? shards), replicas: Number(settings.number_of_replicas ?? replicas), refreshInterval: String(settings.refresh_interval ?? '1s'), maxResultWindow: 10000 },
      aliases: new Map(), docs: new Map(), status: 'open', hidden: name.startsWith('.'), dataStream: null, createdAt: Date.now(), seq: 0,
      stats: { indexTotal: 0, queryTotal: 0, getTotal: 0 },
    };
    if (isPlainObject(body.aliases)) for (const [a, spec] of Object.entries(body.aliases)) ix.aliases.set(a, { isWriteIndex: isPlainObject(spec) ? (spec.is_write_index as boolean) ?? null : null, filter: isPlainObject(spec) ? spec.filter : undefined });
    this.indices.set(name, ix);
    return ix;
  }

  deleteIndex(name: string): void {
    if (name.includes('*') || name === '_all' || name.includes(',')) throw new EsMockError(400, 'illegal_argument_exception', 'Wildcard expressions or all indices are not allowed');
    if (!this.indices.delete(name)) throw new EsMockError(404, 'index_not_found_exception', `no such index [${name}]`);
  }

  /** Adds unmapped fields of a new document to the mapping (dynamic mapping). */
  private dynamicMap(ix: MockIndex, src: Source) {
    const walk = (props: Source, obj: Source) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined || k === '__id') continue;
        const cur = props[k] as Source | undefined;
        if (isPlainObject(v)) {
          const next = (cur ?? { properties: {} }) as Source;
          if (!cur) props[k] = next;
          if (!isPlainObject(next.properties)) next.properties = {};
          walk(next.properties as Source, v);
        } else if (!cur) {
          const sample = Array.isArray(v) ? v[0] : v;
          props[k] = typeof sample === 'number' ? { type: Number.isInteger(sample) ? 'long' : 'float' } : typeof sample === 'boolean' ? { type: 'boolean' }
            : isDateLike(sample) ? { type: 'date' } : { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } };
        }
      }
    };
    if (!isPlainObject(ix.mappings.properties)) ix.mappings.properties = {};
    walk(ix.mappings.properties as Source, src);
  }

  putDoc(target: string, id: string | null, source: Source, opts: { ifSeqNo?: number | null; ifPrimaryTerm?: number | null; create?: boolean }) {
    let ix = this.writeTarget(target);
    if (!ix) ix = this.createIndex(target);
    if (ix.status === 'close') throw new EsMockError(400, 'index_closed_exception', `closed index [${ix.name}]`);
    const docId = id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const cur = ix.docs.get(docId);
    if (opts.create && cur) throw new EsMockError(409, 'version_conflict_engine_exception', `[${docId}]: version conflict, document already exists (current version [${cur.version}])`);
    if (opts.ifSeqNo != null && (!cur || cur.seqNo !== opts.ifSeqNo || cur.primaryTerm !== (opts.ifPrimaryTerm ?? 1))) {
      throw new EsMockError(409, 'version_conflict_engine_exception',
        `[${docId}]: version conflict, required seqNo [${opts.ifSeqNo}], primary term [${opts.ifPrimaryTerm}]. ${cur ? `current document has seqNo [${cur.seqNo}] and primary term [${cur.primaryTerm}]` : 'but no document was found'}`);
    }
    const doc: MockDoc = { id: docId, source: structuredClone(source), seqNo: ix.seq++, primaryTerm: 1, version: (cur?.version ?? 0) + 1 };
    ix.docs.set(docId, doc);
    ix.stats.indexTotal++;
    this.dynamicMap(ix, source);
    return { index: ix.name, id: docId, result: cur ? 'updated' : 'created', seqNo: doc.seqNo, primaryTerm: doc.primaryTerm, version: doc.version };
  }

  deleteDoc(target: string, id: string, opts: { ifSeqNo?: number | null; ifPrimaryTerm?: number | null }) {
    const ix = this.writeTarget(target);
    if (!ix) throw new EsMockError(404, 'index_not_found_exception', `no such index [${target}]`);
    const cur = ix.docs.get(id);
    if (opts.ifSeqNo != null && (!cur || cur.seqNo !== opts.ifSeqNo)) {
      throw new EsMockError(409, 'version_conflict_engine_exception', `[${id}]: version conflict, required seqNo [${opts.ifSeqNo}], current document has seqNo [${cur?.seqNo ?? 'none'}]`);
    }
    ix.docs.delete(id);
    return { index: ix.name, id, result: cur ? 'deleted' : 'not_found', seqNo: ix.seq++, primaryTerm: 1, version: (cur?.version ?? 0) + 1 };
  }

  // ---- search

  fieldsOf(expr: string): EsField[] {
    const out = new Map<string, EsField>();
    const walk = (props: unknown, prefix: string) => {
      if (!isPlainObject(props)) return;
      for (const [k, def] of Object.entries(props)) {
        if (!isPlainObject(def)) continue;
        const path = prefix ? `${prefix}.${k}` : k;
        const type = String(def.type ?? (def.properties ? 'object' : 'object'));
        out.set(path, { path, type, parent: null, searchable: type !== 'object' && type !== 'binary', aggregatable: !['text', 'object', 'nested', 'binary', 'match_only_text'].includes(type) });
        if (isPlainObject(def.fields)) {
          for (const [sub, sd] of Object.entries(def.fields)) {
            const st = String((sd as Source).type ?? 'keyword');
            out.set(`${path}.${sub}`, { path: `${path}.${sub}`, type: st, parent: path, searchable: true, aggregatable: st !== 'text' });
          }
        }
        walk(def.properties, path);
      }
    };
    for (const ix of this.resolve(expr, { hidden: true, allowMissing: true })) walk(ix.mappings.properties, '');
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Raw `_search` response (Elasticsearch JSON). */
  search(expr: string, body: Source = {}, over: { from?: number | null; size?: number | null; searchAfter?: unknown[] | null } = {}): Source {
    const started = performance.now();
    const targets = this.resolve(expr || '_all');
    for (const t of targets) if (t.status === 'close') throw new EsMockError(400, 'index_closed_exception', `closed index [${t.name}]`);
    const allFields = [...new Set(targets.flatMap((t) => this.fieldsOf(t.name).filter((f) => f.type === 'text' || f.type === 'keyword').map((f) => f.path)))];
    const ctx = { allFields };
    const docs: AggDoc[] = [];
    const filterQ = isPlainObject(body.post_filter) ? body.post_filter : null;
    for (const ix of targets) {
      ix.stats.queryTotal++;
      for (const d of ix.docs.values()) {
        const src = { ...d.source, __id: d.id };
        const score = evalQuery(body.query ?? { match_all: {} }, src, ctx);
        if (score > 0 && (body.min_score === undefined || score >= Number(body.min_score))) docs.push({ id: d.id, index: ix.name, src, score: Math.round(score * 1e4) / 1e4 });
      }
    }
    const aggs = body.aggs ?? body.aggregations;
    const aggregations = aggs ? aggregate(aggs, docs, ctx) : undefined;
    let hits = filterQ ? docs.filter((d) => evalQuery(filterQ, d.src, ctx)) : docs;
    const sort = body.sort;
    hits = sort ? sortDocs(hits, sort) : [...hits].sort((a, b) => b.score - a.score);
    if (over.searchAfter?.length && sort) {
      const sortField = Object.keys(isPlainObject((sort as unknown[])[0]) ? ((sort as Source[])[0]) : { [String((sort as unknown[])[0])]: 1 })[0];
      const after = over.searchAfter[0];
      hits = hits.filter((h) => cmp(valuesAt(h.src, sortField)[0], after) > 0);
    }
    const from = Number(over.from ?? body.from ?? 0);
    const size = Number(over.size ?? body.size ?? 10);
    if (from + size > 10000) throw new EsMockError(400, 'illegal_argument_exception', `Result window is too large, from + size must be less than or equal to: [10000] but was [${from + size}].`);
    const page = hits.slice(from, from + size);
    const terms = queryTerms(body.query);
    const byKey = new Map(targets.map((t) => [t.name, t]));
    const trackTotal = body.track_total_hits;
    const total = trackTotal === false ? undefined : typeof trackTotal === 'number' && hits.length > trackTotal ? { value: trackTotal, relation: 'gte' } : { value: hits.length, relation: 'eq' };
    return {
      took: Math.max(1, Math.round(performance.now() - started)), timed_out: false,
      _shards: { total: targets.reduce((n, t) => n + t.settings.shards, 0), successful: targets.reduce((n, t) => n + t.settings.shards, 0), skipped: 0, failed: 0 },
      hits: {
        ...(total ? { total } : {}),
        max_score: sort ? null : page[0]?.score ?? null,
        hits: page.map((h) => {
          const d = byKey.get(h.index)!.docs.get(h.id)!;
          const hl = highlight(h.src, body.highlight, terms);
          return {
            _index: h.index, _id: h.id, _score: sort ? null : h.score, ...(body.seq_no_primary_term ? { _seq_no: d.seqNo, _primary_term: d.primaryTerm } : {}),
            ...(body.version ? { _version: d.version } : {}), _source: filterSource(d.source, body._source),
            ...(hl ? { highlight: hl } : {}),
            ...(sort ? { sort: (Array.isArray(sort) ? sort : [sort]).map((s) => {
              const f = typeof s === 'string' ? s : Object.keys(s as Source)[0];
              const v = f === '_score' ? h.score : valuesAt(h.src, f)[0];
              return isDateLike(v) ? Date.parse(String(v)) : v ?? null;
            }) } : {}),
            ...(body.explain ? { _explanation: { value: h.score, description: `sum of: (mock scoring of ${JSON.stringify(body.query ?? { match_all: {} }).slice(0, 80)})`, details: [{ value: h.score, description: 'matched terms / field length', details: [] }] } } : {}),
          };
        }),
      },
      ...(aggregations ? { aggregations } : {}),
    };
  }

  /** The engine's normalised `/search` response. */
  searchNormalised(expr: string, body: Source, over: { from?: number | null; size?: number | null; searchAfter?: unknown[] | null; trackTotalHits?: boolean | number | null }): EsSearchResponse {
    let capped = false;
    const final: Source = { ...body, seq_no_primary_term: true, track_total_hits: over.trackTotalHits ?? body.track_total_hits ?? true };
    if (over.size != null) final.size = over.size;
    if (over.from != null) final.from = over.from;
    if (typeof final.size === 'number' && final.size > 10000) {
      final.size = 10000;
      capped = true;
    }
    if (over.searchAfter) final.search_after = over.searchAfter;
    const started = performance.now();
    const raw = this.search(expr, final, { searchAfter: over.searchAfter });
    const hits = raw.hits as { total?: { value: number; relation: string }; max_score: number | null; hits: Source[] };
    return {
      took: raw.took as number, timedOut: false, total: hits.total?.value ?? null, totalRelation: (hits.total?.relation as 'eq' | 'gte') ?? 'eq', maxScore: hits.max_score,
      hits: hits.hits.map((h): EsHit => ({
        index: String(h._index), id: String(h._id), score: (h._score as number | null) ?? null, seqNo: (h._seq_no as number) ?? null, primaryTerm: (h._primary_term as number) ?? null,
        version: (h._version as number) ?? null, routing: null, source: h._source, fields: null, highlight: (h.highlight as Record<string, string[]>) ?? null,
        sort: (h.sort as unknown[]) ?? null, explanation: h._explanation ?? null, matchedQueries: null,
      })),
      aggregations: raw.aggregations ?? null, shards: raw._shards as EsSearchResponse['shards'], profile: null,
      elapsedMs: Math.max(1, Math.round(performance.now() - started)) + 3, capped, request: final,
    };
  }

  // ---- summaries

  summary(ix: MockIndex): EsIndexSummary {
    const bytes = this.storeBytes(ix);
    const healthOk = ix.settings.replicas === 0 || this.nodes().length > ix.settings.replicas;
    return {
      name: ix.name, uuid: ix.uuid, health: ix.status === 'close' ? null : healthOk ? 'green' : 'yellow', status: ix.status, primaries: ix.settings.shards, replicas: ix.settings.replicas,
      docsCount: ix.status === 'close' ? null : ix.docs.size, docsDeleted: 0, storeBytes: ix.status === 'close' ? null : bytes * (1 + ix.settings.replicas),
      priStoreBytes: ix.status === 'close' ? null : bytes, hidden: ix.hidden, system: ix.hidden && !ix.dataStream, aliases: [...ix.aliases.keys()].sort(), dataStream: ix.dataStream,
      createdAt: new Date(ix.createdAt).toISOString(),
    };
  }

  storeBytes(ix: MockIndex): number {
    let n = 2048;
    for (const d of ix.docs.values()) n += JSON.stringify(d.source).length * 1.4 + 60;
    return Math.round(n);
  }

  listIndices(hidden: boolean): EsIndexSummary[] {
    return [...this.indices.values()].filter((ix) => hidden || !ix.hidden).map((ix) => this.summary(ix)).sort((a, b) => a.name.localeCompare(b.name));
  }

  aliases(): EsAlias[] {
    const out: EsAlias[] = [];
    for (const ix of this.indices.values()) for (const [alias, a] of ix.aliases) out.push({ alias, index: ix.name, filter: !!a.filter, indexRouting: null, searchRouting: null, isWriteIndex: a.isWriteIndex });
    return out.sort((a, b) => a.alias.localeCompare(b.alias) || a.index.localeCompare(b.index));
  }

  nodes(): EsNode[] {
    return [
      { id: 'n1Xa7Qb2RkOsm0c4tYw9Lg', name: 'es-node-1', ip: '10.0.4.11', roles: ['master', 'data', 'ingest'], master: true, version: '8.15.3', heapPercent: 46, ramPercent: 71, cpu: 9, load1m: 0.42, diskUsedPercent: 38.2, diskUsedBytes: 41_000_000_000, diskTotalBytes: 107_000_000_000, uptime: '6.2d' },
      { id: 'n2Pq8Zd5HeLtv1b7uMx3Ka', name: 'es-node-2', ip: '10.0.4.12', roles: ['master', 'data'], master: false, version: '8.15.3', heapPercent: 61, ramPercent: 74, cpu: 14, load1m: 0.88, diskUsedPercent: 52.7, diskUsedBytes: 56_400_000_000, diskTotalBytes: 107_000_000_000, uptime: '6.2d' },
      { id: 'n3Jc2Ws9FbNyr4d8gVz6Qo', name: 'es-node-3', ip: '10.0.4.13', roles: ['data', 'ml', 'transform'], master: false, version: '8.15.3', heapPercent: 83, ramPercent: 79, cpu: 31, load1m: 1.67, diskUsedPercent: 77.4, diskUsedBytes: 82_800_000_000, diskTotalBytes: 107_000_000_000, uptime: '2.9d' },
    ];
  }

  cluster(): EsCluster {
    const list = [...this.indices.values()];
    const shards = list.filter((i) => i.status === 'open').reduce((n, i) => n + i.settings.shards * (1 + i.settings.replicas), 0);
    const primaries = list.filter((i) => i.status === 'open').reduce((n, i) => n + i.settings.shards, 0);
    const unassigned = list.filter((i) => i.status === 'open').reduce((n, i) => n + (i.settings.replicas >= this.nodes().length ? i.settings.shards * (i.settings.replicas - this.nodes().length + 1) : 0), 0);
    return {
      clusterName: 'rowlit-dev', clusterUuid: 'X7rQ2mWfTbu0sVn5Gd8aEw', flavor: this.flavor, version: this.flavor === 'opensearch' ? '2.17.1' : '8.15.3', luceneVersion: '9.11.1',
      status: unassigned ? 'yellow' : 'green', timedOut: false, nodes: 3, dataNodes: 3, activePrimaryShards: primaries, activeShards: shards - unassigned, relocatingShards: 0,
      initializingShards: 0, unassignedShards: unassigned, activeShardsPercent: shards ? ((shards - unassigned) / shards) * 100 : 100, pendingTasks: 0,
      indices: list.length, docs: list.reduce((n, i) => n + i.docs.size, 0), storeBytes: list.reduce((n, i) => n + this.storeBytes(i) * (1 + i.settings.replicas), 0),
      jvmHeapUsedBytes: 1_610_612_736, jvmHeapMaxBytes: 3_221_225_472, fsTotalBytes: 321_000_000_000, fsAvailableBytes: 140_800_000_000,
    };
  }

  shards(ix: MockIndex): EsShard[] {
    const nodes = this.nodes();
    const out: EsShard[] = [];
    const per = Math.ceil(ix.docs.size / ix.settings.shards);
    const bytes = this.storeBytes(ix) / ix.settings.shards;
    for (let s = 0; s < ix.settings.shards; s++) {
      for (let r = 0; r <= ix.settings.replicas; r++) {
        const node = r < nodes.length ? nodes[(s + r) % nodes.length] : null;
        out.push({
          shard: s, prirep: r === 0 ? 'p' : 'r', state: ix.status === 'close' ? 'CLOSED' : node ? 'STARTED' : 'UNASSIGNED', docs: node ? Math.min(per, ix.docs.size - per * s) : null,
          storeBytes: node ? Math.round(bytes) : null, ip: node?.ip ?? null, node: node?.name ?? null, unassignedReason: node ? null : 'INDEX_CREATED',
        });
      }
    }
    return out;
  }

  detail(expr: string): EsIndexDetail {
    const ix = this.resolve(expr, { hidden: true })[0];
    if (!ix) throw new EsMockError(404, 'index_not_found_exception', `no such index [${expr}]`);
    const sum = this.summary(ix);
    const stat = (copies: number) => ({
      docs: { count: ix.docs.size, deleted: 0 }, store: { size_in_bytes: this.storeBytes(ix) * copies }, indexing: { index_total: ix.stats.indexTotal * copies, index_time_in_millis: ix.stats.indexTotal * copies * 2 },
      search: { query_total: ix.stats.queryTotal, query_time_in_millis: ix.stats.queryTotal * 3, fetch_total: ix.stats.queryTotal }, get: { total: ix.stats.getTotal },
      segments: { count: 4 * ix.settings.shards * copies }, refresh: { total: 12 * copies }, merges: { total: 3 * copies }, query_cache: { memory_size_in_bytes: 8192 }, fielddata: { memory_size_in_bytes: 0 },
    });
    return {
      name: ix.name, mappings: structuredClone(ix.mappings),
      settings: { index: {
        number_of_shards: String(ix.settings.shards), number_of_replicas: String(ix.settings.replicas), refresh_interval: ix.settings.refreshInterval,
        creation_date: String(ix.createdAt), uuid: ix.uuid, provided_name: ix.name, version: { created: '8512000' }, ...(ix.hidden ? { hidden: 'true' } : {}),
        routing: { allocation: { include: { _tier_preference: 'data_content' } } },
      } },
      aliases: Object.fromEntries([...ix.aliases].map(([a, x]) => [a, { ...(x.isWriteIndex != null ? { is_write_index: x.isWriteIndex } : {}), ...(x.filter ? { filter: x.filter } : {}) }])),
      summary: sum, shards: this.shards(ix), stats: { primaries: stat(1), total: stat(1 + ix.settings.replicas) },
    };
  }

  dataStreams() {
    const map = new Map<string, MockIndex[]>();
    for (const ix of this.indices.values()) if (ix.dataStream) map.set(ix.dataStream, [...(map.get(ix.dataStream) ?? []), ix]);
    return [...map].map(([name, list]) => ({ name, status: 'green' as const, template: 'logs-app', generation: list.length, timestampField: '@timestamp', indices: list.map((i) => i.name) }));
  }

  templates() {
    return MOCK_TEMPLATES;
  }

  // ---- tasks

  startTask(action: string, description: string, total: number): MockTask {
    const t: MockTask = { id: `n1Xa7Qb2RkOsm0c4tYw9Lg:${++this.taskSeq}`, action, description, start: Date.now(), status: { total, created: 0, updated: 0, deleted: 0, batches: 0 }, cancelled: false };
    this.tasks.set(t.id, t);
    return t;
  }

  listTasks(): EsTask[] {
    const base: EsTask[] = [
      { id: 'n1Xa7Qb2RkOsm0c4tYw9Lg:77', node: 'n1Xa7Qb2RkOsm0c4tYw9Lg', action: 'cluster:monitor/tasks/lists', type: 'transport', description: '', startTime: new Date().toISOString(), runningTimeMs: 1, cancellable: false, cancelled: false, parentTaskId: null, status: null },
      { id: 'n3Jc2Ws9FbNyr4d8gVz6Qo:4410', node: 'n3Jc2Ws9FbNyr4d8gVz6Qo', action: 'indices:data/write/update/byquery', type: 'transport', description: 'update-by-query [shop-products] updated with Script{type=inline, lang=\'painless\', idOrCode=\'ctx._source.stock += 0\'}',
        startTime: new Date(Date.now() - 95_000).toISOString(), runningTimeMs: 95_000 + (Date.now() % 1000), cancellable: true, cancelled: false, parentTaskId: null,
        status: { total: 50, updated: Math.min(50, 20 + Math.floor((Date.now() / 1000) % 30)), created: 0, deleted: 0, batches: 1, version_conflicts: 0, noops: 0 } },
    ];
    return [...base, ...[...this.tasks.values()].map((t) => ({
      id: t.id, node: t.id.split(':')[0], action: t.action, type: 'transport', description: t.description, startTime: new Date(t.start).toISOString(), runningTimeMs: Date.now() - t.start,
      cancellable: true, cancelled: t.cancelled, parentTaskId: null, status: { ...t.status },
    }))];
  }

  cancelTask(id: string): boolean {
    const t = this.tasks.get(id);
    if (t) {
      t.cancelled = true;
      return true;
    }
    return id.startsWith('n3Jc2Ws9FbNyr4d8gVz6Qo:4410');
  }

  // ---- _cat

  cat(what: string, params: URLSearchParams): { json: unknown[]; text: string } {
    let rows: Record<string, unknown>[];
    switch (what) {
      case 'indices':
        rows = this.listIndices(params.get('expand_wildcards') === 'all').map((i) => ({ health: i.health ?? '', status: i.status, index: i.name, uuid: i.uuid, pri: String(i.primaries), rep: String(i.replicas), 'docs.count': String(i.docsCount ?? ''), 'docs.deleted': '0', 'store.size': fmt(i.storeBytes), 'pri.store.size': fmt(i.priStoreBytes) }));
        break;
      case 'health': {
        const c = this.cluster();
        rows = [{ epoch: String(Math.floor(Date.now() / 1000)), timestamp: new Date().toISOString().slice(11, 19), cluster: c.clusterName, status: c.status, 'node.total': '3', 'node.data': '3', shards: String(c.activeShards), pri: String(c.activePrimaryShards), relo: '0', init: '0', unassign: String(c.unassignedShards), active_shards_percent: `${c.activeShardsPercent.toFixed(1)}%` }];
        break;
      }
      case 'nodes':
        rows = this.nodes().map((n) => ({ ip: n.ip, 'heap.percent': String(n.heapPercent), 'ram.percent': String(n.ramPercent), cpu: String(n.cpu), load_1m: String(n.load1m), 'node.role': n.roles.map((r) => r[0]).join(''), master: n.master ? '*' : '-', name: n.name }));
        break;
      case 'aliases':
        rows = this.aliases().map((a) => ({ alias: a.alias, index: a.index, filter: a.filter ? '*' : '-', 'routing.index': '-', 'routing.search': '-', is_write_index: a.isWriteIndex == null ? '-' : String(a.isWriteIndex) }));
        break;
      case 'shards':
        rows = [...this.indices.values()].flatMap((ix) => this.shards(ix).map((s) => ({ index: ix.name, shard: String(s.shard), prirep: s.prirep, state: s.state, docs: String(s.docs ?? ''), store: fmt(s.storeBytes), ip: s.ip ?? '', node: s.node ?? '' })));
        break;
      case 'count':
        rows = [{ epoch: String(Math.floor(Date.now() / 1000)), timestamp: new Date().toISOString().slice(11, 19), count: String([...this.indices.values()].reduce((n, i) => n + i.docs.size, 0)) }];
        break;
      default:
        throw new EsMockError(400, 'illegal_argument_exception', `no handler found for uri [/_cat/${what}]`);
    }
    const s = params.get('s');
    if (s) rows.sort((a, b) => String(a[s] ?? '').localeCompare(String(b[s] ?? '')));
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const width = cols.map((c) => Math.max(params.has('v') ? c.length : 0, ...rows.map((r) => String(r[c] ?? '').length)));
    const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i])).join(' ').trimEnd();
    const text = [...(params.has('v') ? [line(cols)] : []), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ''))))].join('\n') + '\n';
    return { json: rows, text };
  }

  // ---- SQL

  sql(query: string, fetchSize = 1000): EsSqlResponse {
    const started = performance.now();
    const q = query.trim().replace(/;$/, '');
    let columns: { name: string; type: string }[];
    let rows: unknown[][];
    if (/^SHOW\s+TABLES/i.test(q)) {
      columns = [{ name: 'catalog', type: 'keyword' }, { name: 'name', type: 'keyword' }, { name: 'type', type: 'keyword' }, { name: 'kind', type: 'keyword' }];
      rows = [...this.listIndices(false).map((i) => ['rowlit-dev', i.name, 'TABLE', 'INDEX']), ...this.aliases().map((a) => ['rowlit-dev', a.alias, 'VIEW', 'ALIAS'])];
    } else if (/^(DESCRIBE|DESC|SHOW\s+COLUMNS\s+(FROM|IN))\s+/i.test(q)) {
      const target = unquote(q.replace(/^(DESCRIBE|DESC|SHOW\s+COLUMNS\s+(FROM|IN))\s+/i, ''));
      columns = [{ name: 'column', type: 'keyword' }, { name: 'type', type: 'keyword' }, { name: 'mapping', type: 'keyword' }];
      rows = this.fieldsOf(target).map((f) => [f.path, sqlType(f.type), f.type]);
    } else {
      ({ columns, rows } = this.select(q));
    }
    const page = rows.slice(0, fetchSize);
    let cursor: string | null = null;
    if (rows.length > fetchSize) {
      cursor = `c${++this.cursorSeq}`;
      this.cursors.set(cursor, { columns, rows: rows.slice(fetchSize), size: fetchSize });
    }
    return { columns, rows: page, cursor, elapsedMs: Math.max(1, Math.round(performance.now() - started)) + 4 };
  }

  sqlNext(cursor: string): EsSqlResponse {
    const c = this.cursors.get(cursor);
    if (!c) throw new EsMockError(400, 'illegal_argument_exception', 'Unknown or expired cursor');
    this.cursors.delete(cursor);
    const page = c.rows.slice(0, c.size);
    let next: string | null = null;
    if (c.rows.length > c.size) {
      next = `c${++this.cursorSeq}`;
      this.cursors.set(next, { ...c, rows: c.rows.slice(c.size) });
    }
    return { columns: c.columns, rows: page, cursor: next, elapsedMs: 3 };
  }

  private parseSelect(q: string) {
    const m = /^SELECT\s+([\s\S]+?)\s+FROM\s+("[^"]+"|`[^`]+`|[\w.*-]+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+))?$/i.exec(q);
    if (!m) throw new EsMockError(400, 'parsing_exception', `line 1:1: mismatched input; the mock understands SELECT … FROM … [WHERE] [GROUP BY] [ORDER BY] [LIMIT], SHOW TABLES and DESCRIBE`);
    const [, colsText, from, where, groupBy, orderBy, limit] = m;
    const cols = splitTop(colsText).map((c) => {
      const am = /^(.*?)\s+AS\s+("?[\w ]+"?)$/i.exec(c.trim());
      return { expr: (am ? am[1] : c).trim(), alias: am ? unquote(am[2]) : null };
    });
    return { cols, index: unquote(from), where, groupBy: groupBy ? splitTop(groupBy).map((g) => unquote(g.trim())) : [], orderBy, limit: limit ? Number(limit) : null };
  }

  private whereQuery(where: string | undefined): unknown {
    if (!where) return { match_all: {} };
    const filters = where.split(/\s+AND\s+/i).map((cond) => {
      const c = /^("?[\w.]+"?)\s*(=|!=|<>|>=|<=|>|<|LIKE)\s*(.+)$/i.exec(cond.trim());
      if (!c) throw new EsMockError(400, 'parsing_exception', `line 1: cannot parse condition [${cond.trim()}]`);
      const field = unquote(c[1]);
      const raw = c[3].trim();
      const value: unknown = /^'.*'$/.test(raw) ? raw.slice(1, -1) : Number(raw);
      switch (c[2].toUpperCase()) {
        case '=': return { term: { [field]: value } };
        case '!=': case '<>': return { bool: { must_not: { term: { [field]: value } } } };
        case '>': return { range: { [field]: { gt: value } } };
        case '>=': return { range: { [field]: { gte: value } } };
        case '<': return { range: { [field]: { lt: value } } };
        case '<=': return { range: { [field]: { lte: value } } };
        default: return { wildcard: { [field]: String(value).replace(/%/g, '*').replace(/_/g, '?') } };
      }
    });
    return { bool: { filter: filters } };
  }

  private select(q: string): { columns: { name: string; type: string }[]; rows: unknown[][] } {
    const p = this.parseSelect(q);
    const raw = this.search(p.index, { query: this.whereQuery(p.where), size: 10000 });
    const docs = ((raw.hits as Source).hits as Source[]).map((h) => h._source as Source);
    const fields = this.fieldsOf(p.index);
    const typeOf = (f: string) => sqlType(fields.find((x) => x.path === f)?.type ?? 'keyword');
    const agg = (expr: string, group: Source[]): unknown => {
      const fm = /^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|"?[\w.]+"?)\s*\)$/i.exec(expr);
      const rm = /^ROUND\s*\(([\s\S]+),\s*(\d+)\s*\)$/i.exec(expr);
      if (rm) {
        const v = agg(rm[1].trim(), group);
        return typeof v === 'number' ? Number(v.toFixed(Number(rm[2]))) : v;
      }
      if (!fm) return group[0] ? valuesAt(group[0], unquote(expr))[0] ?? null : null;
      const fn = fm[1].toUpperCase();
      if (fn === 'COUNT') return fm[2] === '*' ? group.length : group.filter((d) => valuesAt(d, unquote(fm[2])).length).length;
      const ns = group.flatMap((d) => valuesAt(d, unquote(fm[2]))).filter((v): v is number => typeof v === 'number');
      if (!ns.length) return null;
      if (fn === 'SUM') return Math.round(ns.reduce((a, x) => a + x, 0) * 100) / 100;
      if (fn === 'AVG') return ns.reduce((a, x) => a + x, 0) / ns.length;
      return fn === 'MIN' ? Math.min(...ns) : Math.max(...ns);
    };
    const isAgg = p.cols.some((c) => /^(COUNT|SUM|AVG|MIN|MAX|ROUND)\s*\(/i.test(c.expr));
    let columns: { name: string; type: string }[];
    let rows: unknown[][];
    if (p.cols.length === 1 && p.cols[0].expr === '*') {
      const names = fields.filter((f) => f.type !== 'object' && f.type !== 'nested' && !f.parent && !f.path.includes('items')).map((f) => f.path);
      columns = names.map((n) => ({ name: n, type: typeOf(n) }));
      rows = docs.map((d) => names.map((n) => valuesAt(d, n)[0] ?? null));
    } else if (p.groupBy.length || isAgg) {
      const groups = new Map<string, Source[]>();
      for (const d of docs) {
        const key = JSON.stringify(p.groupBy.map((g) => valuesAt(d, g)[0] ?? null));
        groups.set(key, [...(groups.get(key) ?? []), d]);
      }
      if (!p.groupBy.length && !groups.size) groups.set('[]', []);
      columns = p.cols.map((c) => ({ name: c.alias ?? c.expr, type: /^COUNT/i.test(c.expr) ? 'long' : /^(SUM|AVG|ROUND)/i.test(c.expr) ? 'double' : typeOf(unquote(c.expr)) }));
      rows = [...groups.values()].map((g) => p.cols.map((c) => agg(c.expr, g)));
    } else {
      columns = p.cols.map((c) => ({ name: c.alias ?? unquote(c.expr), type: typeOf(unquote(c.expr)) }));
      rows = docs.map((d) => p.cols.map((c) => {
        const v = valuesAt(d, unquote(c.expr));
        return v.length > 1 ? v : v[0] ?? null;
      }));
    }
    if (p.orderBy) {
      const om = /^("?[\w. ]+"?)(?:\s+(ASC|DESC))?$/i.exec(p.orderBy.trim());
      const name = om ? unquote(om[1]) : '';
      const i = columns.findIndex((c) => c.name === name);
      const dir = om?.[2]?.toUpperCase() === 'DESC' ? -1 : 1;
      if (i >= 0) rows.sort((a, b) => cmp(a[i], b[i]) * dir);
    }
    if (p.limit != null) rows = rows.slice(0, p.limit);
    return { columns, rows };
  }

  translate(q: string): unknown {
    const p = this.parseSelect(q.trim().replace(/;$/, ''));
    const plain = p.cols.filter((c) => !/\(/.test(c.expr)).map((c) => unquote(c.expr)).filter((c) => c !== '*');
    return {
      size: p.groupBy.length ? 0 : p.limit ?? 1000, query: this.whereQuery(p.where),
      ...(plain.length && !p.groupBy.length ? { _source: { includes: plain } } : { _source: false }),
      ...(p.groupBy.length ? { aggregations: { groupby: { composite: { size: 1000, sources: p.groupBy.map((g) => ({ [g]: { terms: { field: g, missing_bucket: true, order: 'asc' } } })) } } } } : {}),
      ...(p.orderBy && !p.groupBy.length ? { sort: [{ [unquote(p.orderBy.replace(/\s+(ASC|DESC)$/i, ''))]: { order: /DESC$/i.test(p.orderBy) ? 'desc' : 'asc', missing: '_last' } }] } : {}),
    };
  }

  // ---- Dev Tools

  console(method: string, rawPath: string, body: string | null, readOnly: boolean): EsConsoleResponse {
    const started = performance.now();
    const url = new URL(rawPath.startsWith('/') ? rawPath : `/${rawPath}`, 'http://es');
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const m = method.toUpperCase();
    const reply = (status: number, value: unknown, text?: string): EsConsoleResponse => ({
      status, statusText: STATUS_TEXT[status] ?? '', elapsedMs: Math.max(1, Math.round(performance.now() - started)) + 2,
      contentType: text !== undefined ? 'text/plain; charset=UTF-8' : 'application/json', body: text ?? JSON.stringify(value, null, 2), truncated: false,
    });
    const parsed = (): Source => {
      if (!body?.trim()) return {};
      try {
        return JSON.parse(body) as Source;
      } catch {
        throw new EsMockError(400, 'parsing_exception', 'Unexpected character in the request body: not valid JSON');
      }
    };
    try {
      const last = segs[segs.length - 1] ?? '';
      if (readOnly && m !== 'GET' && m !== 'HEAD' && !(m === 'POST' && /^(_search|_count|_msearch|_mget|_sql|_field_caps|_explain|_analyze|_validate|translate|query)$/.test(last) || segs.includes('_plugins'))) {
        throw Object.assign(new Error(`The connection is read-only: ${m} ${url.pathname} is not allowed.`), { readOnly: true });
      }
      if (!segs.length) {
        return reply(200, this.flavor === 'opensearch'
          ? { name: 'os-node-1', cluster_name: 'rowlit-dev', cluster_uuid: 'X7rQ2mWfTbu0sVn5Gd8aEw', version: { distribution: 'opensearch', number: '2.17.1', lucene_version: '9.11.1' }, tagline: 'The OpenSearch Project: https://opensearch.org/' }
          : { name: 'es-node-1', cluster_name: 'rowlit-dev', cluster_uuid: 'X7rQ2mWfTbu0sVn5Gd8aEw', version: { number: '8.15.3', build_flavor: 'default', build_type: 'docker', lucene_version: '9.11.1', minimum_wire_compatibility_version: '7.17.0' }, tagline: 'You Know, for Search' });
      }
      const [s0, s1, s2] = segs;
      if (s0 === '_cat') {
        const r = this.cat(s1 ?? '', url.searchParams);
        return url.searchParams.get('format') === 'json' ? reply(200, r.json) : reply(200, null, r.text);
      }
      if (s0 === '_cluster' && s1 === 'health') {
        const c = this.cluster();
        return reply(200, { cluster_name: c.clusterName, status: c.status, timed_out: false, number_of_nodes: 3, number_of_data_nodes: 3, active_primary_shards: c.activePrimaryShards, active_shards: c.activeShards, relocating_shards: 0, initializing_shards: 0, unassigned_shards: c.unassignedShards, delayed_unassigned_shards: 0, number_of_pending_tasks: 0, number_of_in_flight_fetch: 0, task_max_waiting_in_queue_millis: 0, active_shards_percent_as_number: c.activeShardsPercent });
      }
      if (s0 === '_cluster' && s1 === 'stats') return reply(200, { cluster_name: 'rowlit-dev', status: this.cluster().status, indices: { count: this.indices.size, docs: { count: this.cluster().docs } }, nodes: { count: { total: 3 } } });
      if (s0 === '_nodes') return reply(200, { _nodes: { total: 3, successful: 3, failed: 0 }, cluster_name: 'rowlit-dev', nodes: Object.fromEntries(this.nodes().map((n) => [n.id, { name: n.name, ip: n.ip, version: n.version, roles: n.roles }])) });
      if (s0 === '_tasks') return reply(200, { nodes: { n1Xa7Qb2RkOsm0c4tYw9Lg: { name: 'es-node-1', tasks: Object.fromEntries(this.listTasks().map((t) => [t.id, { node: t.node, id: Number(t.id.split(':')[1]), type: t.type, action: t.action, description: t.description, running_time_in_nanos: t.runningTimeMs * 1e6, cancellable: t.cancellable, status: t.status ?? undefined }])) } } });
      if (s0 === '_sql' || (s0 === '_plugins' && s1 === '_sql')) {
        if (s1 === 'translate' || s2 === '_explain') return reply(200, this.translate(String(parsed().query ?? '')));
        const r = this.sql(String(parsed().query ?? ''), Number(parsed().fetch_size ?? 1000));
        if (url.searchParams.get('format') === 'txt') {
          const w = r.columns.map((c, i) => Math.max(c.name.length, ...r.rows.map((row) => String(row[i] ?? 'null').length)));
          const ln = (vals: string[]) => vals.map((v, i) => v.padEnd(w[i])).join('|');
          return reply(200, null, `${ln(r.columns.map((c) => c.name))}\n${w.map((x) => '-'.repeat(x)).join('+')}\n${r.rows.map((row) => ln(row.map((v) => String(v ?? 'null')))).join('\n')}\n`);
        }
        return reply(200, { columns: r.columns, rows: r.rows, ...(r.cursor ? { cursor: r.cursor } : {}) });
      }
      if (s0 === '_search' || s1 === '_search' || s1 === '_count') {
        const target = s0 === '_search' ? '_all' : s0;
        const b = parsed();
        if (s1 === '_count') return reply(200, { count: ((this.search(target, { query: b.query, size: 0 }).hits as Source).total as Source).value, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } });
        return reply(200, this.search(target, { ...b, seq_no_primary_term: url.searchParams.get('seq_no_primary_term') === 'true' || b.seq_no_primary_term }, {
          size: url.searchParams.has('size') ? Number(url.searchParams.get('size')) : undefined,
        }));
      }
      if (s0 === '_bulk' || s1 === '_bulk') {
        const lines = (body ?? '').split('\n').filter((l) => l.trim());
        const items: Source[] = [];
        for (let i = 0; i < lines.length; i++) {
          const action = JSON.parse(lines[i]) as Record<string, Source>;
          const [op, meta] = Object.entries(action)[0];
          const index = String(meta._index ?? s0);
          if (op === 'delete') items.push({ delete: { ...this.deleteDoc(index, String(meta._id), {}), status: 200 } });
          else {
            const src = JSON.parse(lines[++i]) as Source;
            const r = this.putDoc(index, meta._id ? String(meta._id) : null, op === 'update' ? { ...(this.writeTarget(index)?.docs.get(String(meta._id))?.source ?? {}), ...(src.doc as Source) } : src, { create: op === 'create' });
            items.push({ [op]: { _index: r.index, _id: r.id, result: r.result, _seq_no: r.seqNo, _primary_term: 1, status: r.result === 'created' ? 201 : 200 } });
          }
        }
        return reply(200, { took: 3, errors: false, items });
      }
      if (s0 === '_aliases' && m === 'POST') {
        for (const a of (parsed().actions as Source[]) ?? []) this.applyAlias(a);
        return reply(200, { acknowledged: true });
      }
      if (s0 === '_alias' || s1 === '_alias') return reply(200, Object.fromEntries([...this.indices.values()].filter((ix) => ix.aliases.size).map((ix) => [ix.name, { aliases: Object.fromEntries([...ix.aliases.keys()].map((a) => [a, {}])) }])));
      if (s0 === '_index_template' || s0 === '_component_template' || s0 === '_template') {
        const kind = s0 === '_index_template' ? 'index' : s0 === '_component_template' ? 'component' : 'legacy';
        const list = this.templates().filter((t) => t.kind === kind && (!s1 || t.name === s1));
        return reply(200, kind === 'legacy' ? Object.fromEntries(list.map((t) => [t.name, t.body])) : { [kind === 'index' ? 'index_templates' : 'component_templates']: list.map((t) => ({ name: t.name, [kind === 'index' ? 'index_template' : 'component_template']: t.body })) });
      }
      if (s0 === '_data_stream') return reply(200, { data_streams: this.dataStreams().map((d) => ({ name: d.name, timestamp_field: { name: '@timestamp' }, indices: d.indices.map((i) => ({ index_name: i })), generation: d.generation, status: 'GREEN', template: d.template })) });
      if (s0.startsWith('_')) return reply(400, { error: `no handler found for uri [${url.pathname}] and method [${m}]` });

      // index-level
      if (!s1) {
        if (m === 'PUT') {
          this.createIndex(s0, parsed());
          return reply(200, { acknowledged: true, shards_acknowledged: true, index: s0 });
        }
        if (m === 'DELETE') {
          this.deleteIndex(s0);
          return reply(200, { acknowledged: true });
        }
        if (m === 'HEAD') return reply(this.resolve(s0, { allowMissing: true }).length ? 200 : 404, null, '');
        return reply(200, Object.fromEntries(this.resolve(s0, { hidden: true }).map((ix) => {
          const d = this.detail(ix.name);
          return [ix.name, { aliases: d.aliases, mappings: d.mappings, settings: d.settings }];
        })));
      }
      if (s1 === '_mapping') {
        if (m === 'PUT') {
          this.putMapping(s0, parsed());
          return reply(200, { acknowledged: true });
        }
        return reply(200, Object.fromEntries(this.resolve(s0, { hidden: true }).map((ix) => [ix.name, { mappings: ix.mappings }])));
      }
      if (s1 === '_settings') return reply(200, Object.fromEntries(this.resolve(s0, { hidden: true }).map((ix) => [ix.name, { settings: this.detail(ix.name).settings }])));
      if (s1 === '_stats') return reply(200, { _all: {}, indices: Object.fromEntries(this.resolve(s0).map((ix) => [ix.name, this.detail(ix.name).stats])) });
      if (s1 === '_refresh' || s1 === '_flush' || s1 === '_forcemerge') return reply(200, { _shards: { total: 2, successful: 2, failed: 0 } });
      if (s1 === '_open' || s1 === '_close') {
        this.resolve(s0).forEach((ix) => (ix.status = s1 === '_open' ? 'open' : 'close'));
        return reply(200, { acknowledged: true, shards_acknowledged: true });
      }
      if (s1 === '_doc' || s1 === '_create') {
        if (m === 'GET' || m === 'HEAD') {
          const ix = this.resolve(s0)[0];
          const d = ix?.docs.get(s2 ?? '');
          if (!d) return reply(404, { _index: s0, _id: s2, found: false });
          ix.stats.getTotal++;
          return reply(200, { _index: ix.name, _id: d.id, _version: d.version, _seq_no: d.seqNo, _primary_term: d.primaryTerm, found: true, _source: d.source });
        }
        if (m === 'DELETE') {
          const r = this.deleteDoc(s0, s2 ?? '', {});
          return reply(r.result === 'deleted' ? 200 : 404, { _index: r.index, _id: r.id, _version: r.version, result: r.result, _seq_no: r.seqNo, _primary_term: 1 });
        }
        const r = this.putDoc(s0, s2 ?? null, parsed(), {
          create: s1 === '_create' || url.searchParams.get('op_type') === 'create',
          ifSeqNo: url.searchParams.has('if_seq_no') ? Number(url.searchParams.get('if_seq_no')) : null, ifPrimaryTerm: url.searchParams.has('if_primary_term') ? Number(url.searchParams.get('if_primary_term')) : null,
        });
        return reply(r.result === 'created' ? 201 : 200, { _index: r.index, _id: r.id, _version: r.version, result: r.result, _shards: { total: 1, successful: 1, failed: 0 }, _seq_no: r.seqNo, _primary_term: 1 });
      }
      if (s1 === '_update' && s2) {
        const ix = this.writeTarget(s0);
        const cur = ix?.docs.get(s2);
        if (!cur) throw new EsMockError(404, 'document_missing_exception', `[${s2}]: document missing`);
        const r = this.putDoc(s0, s2, { ...cur.source, ...((parsed().doc as Source) ?? {}) }, {});
        return reply(200, { _index: r.index, _id: r.id, _version: r.version, result: r.result, _seq_no: r.seqNo, _primary_term: 1 });
      }
      if (s1 === '_delete_by_query') {
        const hits = ((this.search(s0, { query: parsed().query, size: 10000 }).hits as Source).hits as Source[]);
        for (const h of hits) this.deleteDoc(String(h._index), String(h._id), {});
        return reply(200, { took: 12, timed_out: false, total: hits.length, deleted: hits.length, batches: 1, version_conflicts: 0, noops: 0, failures: [] });
      }
      return reply(400, { error: `no handler found for uri [${url.pathname}] and method [${m}]` });
    } catch (e) {
      if (e instanceof EsMockError) return reply(e.status, e.body());
      throw e;
    }
  }

  applyAlias(a: Source): void {
    const [op, spec] = Object.entries(a)[0] as [string, Source];
    for (const ix of this.resolve(String(spec.index ?? (spec.indices as string[])?.join(',') ?? ''))) {
      if (op === 'add') ix.aliases.set(String(spec.alias), { isWriteIndex: (spec.is_write_index as boolean) ?? null, filter: spec.filter });
      else if (op === 'remove') {
        if (!ix.aliases.delete(String(spec.alias))) throw new EsMockError(404, 'aliases_not_found_exception', `aliases [${String(spec.alias)}] missing`);
      }
    }
  }

  putMapping(expr: string, body: Source): void {
    for (const ix of this.resolve(expr)) {
      const props = isPlainObject(body.properties) ? body.properties : {};
      const cur = (ix.mappings.properties ?? {}) as Source;
      for (const [k, v] of Object.entries(props)) {
        const old = cur[k] as Source | undefined;
        if (old && old.type && isPlainObject(v) && v.type && old.type !== v.type) {
          throw new EsMockError(400, 'illegal_argument_exception', `mapper [${k}] cannot be changed from type [${String(old.type)}] to [${String(v.type)}]`);
        }
        cur[k] = old && isPlainObject(v) ? { ...old, ...v } : v;
      }
      ix.mappings.properties = cur;
    }
  }

  putSettings(expr: string, body: Source): void {
    const s = isPlainObject(body.index) ? body.index : body;
    for (const ix of this.resolve(expr)) {
      if (s.number_of_shards !== undefined) throw new EsMockError(400, 'illegal_argument_exception', `Can't update non dynamic settings [[index.number_of_shards]] for open indices [[${ix.name}]]`);
      if (s.number_of_replicas !== undefined) ix.settings.replicas = Number(s.number_of_replicas);
      if (s.refresh_interval !== undefined) ix.settings.refreshInterval = String(s.refresh_interval);
    }
  }

  docsOf(expr: string, query: unknown): { index: string; id: string; source: Source }[] {
    const hits = ((this.search(expr, { query: query ?? { match_all: {} }, size: 10000 }).hits as Source).hits as Source[]);
    return hits.map((h) => ({ index: String(h._index), id: String(h._id), source: h._source as Source }));
  }
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error' };

function fmt(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n}b`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}kb`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}mb`;
  return `${(n / 1024 ** 3).toFixed(1)}gb`;
}

function unquote(s: string): string {
  return s.trim().replace(/^["`](.*)["`]$/, '$1');
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function sqlType(t: string): string {
  return ({ text: 'text', keyword: 'keyword', long: 'long', integer: 'integer', double: 'double', float: 'float', date: 'datetime', boolean: 'boolean', nested: 'nested', object: 'object' } as Record<string, string>)[t] ?? t;
}


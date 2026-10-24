// Document grid helpers (plan-batch3 WP-ES): columns from the hits' _source (objects flattened to dotted paths up to two
// levels, arrays kept whole), the search body of the grid toolbar, sample query bodies. Pure.
import type { EsField, EsHit } from '../api/types.es';
import { isPlainObject } from './json';

/** Flattens `{ address: { city } }` to `address.city` (depth ≤ maxDepth); arrays and deeper objects stay values. */
export function flattenSource(src: unknown, maxDepth = 2): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (isPlainObject(v) && depth < maxDepth && Object.keys(v).length > 0) {
      for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}` : k, depth + 1);
    } else if (prefix) {
      out[prefix] = v;
    }
  };
  walk(src, '', 0);
  return out;
}

/** Union of the flattened source keys of the hits, first-seen order. */
export function gridColumns(hits: readonly EsHit[], maxColumns = 60): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    for (const k of Object.keys(flattenSource(h.source))) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
        if (out.length >= maxColumns) return out;
      }
    }
  }
  return out;
}

export interface GridQuery {
  /** Lucene query string ('' = everything). */
  q: string;
  sortField: string | null;
  sortDir: 'asc' | 'desc';
  from: number;
  size: number;
}

export const DEFAULT_GRID_QUERY: GridQuery = { q: '', sortField: null, sortDir: 'desc', from: 0, size: 50 };

/** The search body of the document grid. */
export function gridBody(g: GridQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: g.q.trim() ? { query_string: { query: g.q.trim(), default_operator: 'AND', lenient: true } } : { match_all: {} },
  };
  if (g.sortField) body.sort = [{ [g.sortField]: { order: g.sortDir, unmapped_type: 'keyword' } }];
  return body;
}

/** Sortable field for a column: the field itself when aggregatable, else its `.keyword` multi-field. */
export function sortFieldFor(column: string, fields: readonly EsField[]): string | null {
  const f = fields.find((x) => x.path === column);
  if (f?.aggregatable) return column;
  const kw = fields.find((x) => x.parent === column && x.aggregatable);
  return kw?.path ?? null;
}

/** Example bodies for the search view's "Examples" menu (`{field}`, `{keyword}`, `{date}`, `{number}` filled from the mapping). */
export function exampleBodies(all: readonly EsField[]): { label: string; body: unknown }[] {
  // fields inside nested objects need a nested query/aggregation: keep them out of the plain examples
  const nestedPaths = all.filter((f) => f.type === 'nested').map((f) => `${f.path}.`);
  const fields = all.filter((f) => f.type === 'nested' || !nestedPaths.some((n) => f.path.startsWith(n)));
  const text = fields.find((f) => f.type === 'text')?.path ?? 'message';
  const keyword = fields.find((f) => f.type === 'keyword' && !f.parent)?.path ?? fields.find((f) => f.type === 'keyword')?.path ?? 'status';
  const date = fields.find((f) => f.type === 'date')?.path ?? '@timestamp';
  const num = fields.find((f) => /^(long|integer|double|float|scaled_float|short)$/.test(f.type))?.path ?? 'total';
  const nested = fields.find((f) => f.type === 'nested')?.path;
  const out: { label: string; body: unknown }[] = [
    { label: 'Match all', body: { query: { match_all: {} }, size: 20 } },
    { label: `Full text on ${text}`, body: { query: { match: { [text]: { query: '', operator: 'and' } } }, highlight: { fields: { [text]: {} } } } },
    {
      label: 'Bool with filters',
      body: { query: { bool: { must: [{ match_all: {} }], filter: [{ term: { [keyword]: '' } }, { range: { [num]: { gte: 0 } } }], must_not: [] } }, sort: [{ [num]: 'desc' }] },
    },
    { label: `Terms on ${keyword}`, body: { size: 0, aggs: { by_value: { terms: { field: keyword, size: 10 } } } } },
    { label: `Histogram over ${date}`, body: { size: 0, aggs: { per_month: { date_histogram: { field: date, calendar_interval: 'month' }, aggs: { avg_value: { avg: { field: num } } } } } } },
    { label: `Stats of ${num}`, body: { size: 0, aggs: { stats: { stats: { field: num } }, ranges: { range: { field: num, ranges: [{ to: 100 }, { from: 100, to: 500 }, { from: 500 }] } } } } },
  ];
  if (nested) {
    const inner = all.find((f) => f.path.startsWith(`${nested}.`) && f.aggregatable)?.path ?? `${nested}.id`;
    out.push({ label: `Nested ${nested}`, body: { query: { nested: { path: nested, query: { exists: { field: inner } } } }, aggs: { [nested]: { nested: { path: nested }, aggs: { top: { terms: { field: inner } } } } } } });
  }
  return out;
}

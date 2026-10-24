// Aggregation results → a viewer model (plan-batch3 WP-ES): bucket aggregations become tables (key, doc_count, the
// metrics of their sub-aggregations, nested bucket aggs drill down), metric aggregations become tiles. Pure.
import { isPlainObject } from './json';

export interface MetricView { kind: 'metric'; name: string; values: { label: string; value: number | string | null }[] }
export interface BucketRow { key: string; docCount: number; metrics: Record<string, number | string | null>; children: AggView[] }
export interface BucketsView { kind: 'buckets'; name: string; rows: BucketRow[]; metricNames: string[]; otherDocs: number | null; maxCount: number }
export interface SingleBucketView { kind: 'single'; name: string; docCount: number; children: AggView[] }
export interface HitsView { kind: 'hits'; name: string; total: number | null; hits: { id: string; source: unknown }[] }
export interface RawView { kind: 'raw'; name: string; value: unknown }
export type AggView = MetricView | BucketsView | SingleBucketView | HitsView | RawView;

const META = new Set(['doc_count', 'key', 'key_as_string', 'from', 'to', 'from_as_string', 'to_as_string', 'doc_count_error_upper_bound', 'sum_other_doc_count', 'meta', 'bg_count', 'score']);

function num(v: unknown): number | string | null {
  if (typeof v === 'number' || typeof v === 'string') return v;
  return null;
}

/** Single-value view of a metric aggregation (for bucket table cells), or null. */
function metricValue(v: Record<string, unknown>): number | string | null | undefined {
  if ('value_as_string' in v) return num(v.value_as_string);
  if ('value' in v) return num(v.value);
  if ('avg' in v && 'count' in v) return num(v.avg);
  return undefined;
}

function metricView(name: string, v: Record<string, unknown>): MetricView | null {
  if ('value' in v) return { kind: 'metric', name, values: [{ label: 'value', value: num(v.value_as_string ?? v.value) }] };
  if (isPlainObject(v.values)) {
    return { kind: 'metric', name, values: Object.entries(v.values).map(([k, x]) => ({ label: k, value: num(x) })) };
  }
  const keys = ['count', 'min', 'max', 'avg', 'sum', 'sum_of_squares', 'variance', 'std_deviation'];
  if ('count' in v && ('min' in v || 'avg' in v)) {
    return { kind: 'metric', name, values: keys.filter((k) => k in v).map((k) => ({ label: k, value: num(v[k]) })) };
  }
  return null;
}

function bucketKey(b: Record<string, unknown>, fallback: string): string {
  if (typeof b.key_as_string === 'string') return b.key_as_string;
  if (b.key !== undefined) return isPlainObject(b.key) ? JSON.stringify(b.key) : String(b.key);
  if (b.from !== undefined || b.to !== undefined) return `${b.from_as_string ?? b.from ?? '−∞'} – ${b.to_as_string ?? b.to ?? '∞'}`;
  return fallback;
}

function children(b: Record<string, unknown>): { metrics: Record<string, number | string | null>; views: AggView[] } {
  const metrics: Record<string, number | string | null> = {};
  const views: AggView[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (META.has(k) || !isPlainObject(v)) continue;
    const mv = metricValue(v);
    if (mv !== undefined) metrics[k] = mv;
    else views.push(aggView(k, v));
  }
  return { metrics, views };
}

export function aggView(name: string, v: unknown): AggView {
  if (!isPlainObject(v)) return { kind: 'raw', name, value: v };
  if (isPlainObject(v.hits) && Array.isArray(v.hits.hits)) {
    const total = isPlainObject(v.hits.total) ? Number(v.hits.total.value) : typeof v.hits.total === 'number' ? v.hits.total : null;
    return { kind: 'hits', name, total, hits: (v.hits.hits as Record<string, unknown>[]).map((h) => ({ id: String(h._id ?? ''), source: h._source })) };
  }
  if ('buckets' in v) {
    const raw = v.buckets;
    const list: [string, Record<string, unknown>][] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[]).map((b, i) => [bucketKey(b, String(i)), b])
      : isPlainObject(raw)
        ? Object.entries(raw as Record<string, Record<string, unknown>>).map(([k, b]) => [k, b])
        : [];
    const rows: BucketRow[] = list.map(([key, b]) => {
      const c = children(b);
      return { key, docCount: Number(b.doc_count ?? 0), metrics: c.metrics, children: c.views };
    });
    const metricNames = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))];
    return {
      kind: 'buckets', name, rows, metricNames,
      otherDocs: typeof v.sum_other_doc_count === 'number' ? v.sum_other_doc_count : null,
      maxCount: rows.reduce((m, r) => Math.max(m, r.docCount), 0),
    };
  }
  const metric = metricView(name, v);
  if (metric) return metric;
  if (typeof v.doc_count === 'number') {
    const c = children(v);
    const metricChildren: AggView[] = Object.entries(c.metrics).map(([k, x]) => ({ kind: 'metric', name: k, values: [{ label: 'value', value: x }] }));
    return { kind: 'single', name, docCount: v.doc_count, children: [...metricChildren, ...c.views] };
  }
  return { kind: 'raw', name, value: v };
}

/** Views of a response's `aggregations` object. */
export function aggViews(aggregations: unknown): AggView[] {
  if (!isPlainObject(aggregations)) return [];
  return Object.entries(aggregations).map(([k, v]) => aggView(k, v));
}

export function formatMetric(v: number | string | null): string {
  if (v === null) return '—';
  if (typeof v === 'string') return v;
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

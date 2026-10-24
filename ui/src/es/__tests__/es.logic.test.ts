// WP-ES pure logic: console parsing, DSL completion context, lenient JSON, grid helpers, aggregation views, mock engine.
import { describe, expect, it } from 'vitest';
import type { EsField } from '../../api/types.es';
import { aggViews } from '../aggs';
import { bodyForSend, indexOfPath, isNdjsonPath, isSearchPath, parseConsole, requestAt, requestsIn, toCurl } from '../console';
import { flattenSource, gridBody, gridColumns, sortFieldFor } from '../docs';
import { analyzeJson, contextOf, suggest } from '../dsl';
import { formatBytes, formatCount, indexNameError } from '../format';
import { parseLenient, stripJsonExtras } from '../json';
import { EsMock } from '../mock/engine';

const FIELDS: EsField[] = [
  { path: 'name', type: 'text', parent: null, searchable: true, aggregatable: false },
  { path: 'name.keyword', type: 'keyword', parent: 'name', searchable: true, aggregatable: true },
  { path: 'status', type: 'keyword', parent: null, searchable: true, aggregatable: true },
  { path: 'total', type: 'double', parent: null, searchable: true, aggregatable: true },
  { path: 'createdAt', type: 'date', parent: null, searchable: true, aggregatable: true },
  { path: 'items', type: 'nested', parent: null, searchable: false, aggregatable: false },
  { path: 'items.sku', type: 'keyword', parent: null, searchable: true, aggregatable: true },
];

describe('console parsing', () => {
  const text = [
    '# comment',
    'GET /_cat/indices?v',
    '',
    'POST shop-orders/_search',
    '{',
    '  "query": { "match_all": {} } // all',
    '}',
    '# trailing comment',
    '',
    'POST /_bulk',
    '{ "index": { "_index": "x" } }',
    '{ "a": 1, }',
  ].join('\n');

  it('splits requests with their bodies and line ranges', () => {
    const r = parseConsole(text);
    expect(r.map((x) => [x.method, x.path, x.startLine, x.endLine])).toEqual([
      ['GET', '/_cat/indices?v', 2, 2], ['POST', '/shop-orders/_search', 4, 7], ['POST', '/_bulk', 10, 12],
    ]);
    expect(r[1].body).toContain('"match_all"');
    expect(r[1].body).not.toContain('trailing comment');
  });

  it('finds the request at the cursor and in a selection', () => {
    const r = parseConsole(text);
    expect(requestAt(r, 6)?.path).toBe('/shop-orders/_search');
    expect(requestAt(r, 9)?.path).toBe('/shop-orders/_search');
    expect(requestAt(r, 1)).toBeNull();
    expect(requestsIn(r, 2, 5).map((x) => x.path)).toEqual(['/_cat/indices?v', '/shop-orders/_search']);
  });

  it('classifies paths and prepares NDJSON bodies', () => {
    expect(isNdjsonPath('/_bulk')).toBe(true);
    expect(isNdjsonPath('/x/_msearch?typed_keys')).toBe(true);
    expect(isNdjsonPath('/x/_search')).toBe(false);
    expect(isSearchPath('/shop-*/_search?size=5')).toBe(true);
    expect(isSearchPath('/x/_explain/1')).toBe(true);
    expect(isSearchPath('/x/_doc/1')).toBe(false);
    expect(indexOfPath('/shop-orders/_search')).toBe('shop-orders');
    expect(indexOfPath('/_cat/indices')).toBeNull();
    const bulk = parseConsole(text)[2];
    const compact = (l: string) => JSON.stringify(JSON.parse(stripJsonExtras(l)));
    expect(bodyForSend(bulk.path, bulk.body, compact)).toBe('{"index":{"_index":"x"}}\n{"a":1}\n');
  });

  it('copies as cURL', () => {
    expect(toCurl('http://es:9200/', { method: 'GET', path: '_cat/health', body: '' })).toBe('curl -XGET "http://es:9200/_cat/health"');
    expect(toCurl('http://es:9200', { method: 'POST', path: '/x/_search', body: '{"a":"it\'s"}' })).toContain(`-d '{"a":"it'\\''s"}'`);
  });
});

describe('DSL completion', () => {
  it('locates the cursor in nested queries', () => {
    const c = analyzeJson('{"query":{"bool":{"must":[{"ma');
    expect(c.path).toEqual(['query', 'bool', 'must', '[]']);
    expect(c.inKey).toBe(true);
    expect(c.inString).toBe(true);
    expect(c.prefix).toBe('ma');
    expect(contextOf(c.path)).toEqual({ kind: 'query' });
  });

  it('offers root keys, query clauses, bool params, fields and agg types', () => {
    const labels = (t: string) => suggest(t, FIELDS).items.map((i) => i.label);
    expect(labels('{ "')).toContain('aggs');
    expect(labels('{ "query": { "')).toContain('match_phrase');
    expect(labels('{ "query": { "bool": { "')).toEqual(['must', 'filter', 'should', 'must_not', 'minimum_should_match', 'boost']);
    expect(labels('{ "query": { "bool": { "must": [], "')).not.toContain('must');
    expect(labels('{ "query": { "match": { "')).toContain('name');
    expect(labels('{ "query": { "range": { "')).toEqual(['name.keyword', 'status', 'total', 'createdAt', 'items.sku']);
    expect(labels('{ "query": { "match": { "name": { "')).toContain('operator');
    expect(labels('{ "aggs": { "by": { "')).toContain('date_histogram');
    expect(labels('{ "aggs": { "by": { "terms": { "field": "')).toEqual(['name.keyword', 'status', 'total', 'createdAt', 'items.sku']);
    expect(labels('{ "aggs": { "n": { "nested": { "path": "')).toEqual(['items']);
    expect(labels('{ "sort": [ { "')).toContain('_score');
    expect(labels('{ "query": { "match": { "name": { "operator": "')).toEqual(['or', 'and']);
    expect(labels('{ "_source": [ "')).toContain('total');
  });
});

describe('JSON, grid and formatting helpers', () => {
  it('parses editor JSON with comments and trailing commas', () => {
    expect(parseLenient('{ "a": 1, // x\n "b": [1,2,], }')).toEqual({ ok: true, value: { a: 1, b: [1, 2] } });
    expect(parseLenient('  ')).toEqual({ ok: true, value: undefined });
    expect(parseLenient('{ "a": "http://x//y" }')).toEqual({ ok: true, value: { a: 'http://x//y' } });
    expect(parseLenient('{ a: 1 }').ok).toBe(false);
  });

  it('flattens sources into grid columns', () => {
    expect(flattenSource({ a: 1, b: { c: 2, d: { e: 3 } }, f: [1] })).toEqual({ a: 1, 'b.c': 2, 'b.d': { e: 3 }, f: [1] });
    expect(gridColumns([{ source: { a: 1 } }, { source: { b: { c: 1 } } }] as never)).toEqual(['a', 'b.c']);
    expect(gridBody({ q: 'status:paid', sortField: 'total', sortDir: 'desc', from: 0, size: 50 })).toEqual({
      query: { query_string: { query: 'status:paid', default_operator: 'AND', lenient: true } }, sort: [{ total: { order: 'desc', unmapped_type: 'keyword' } }],
    });
    expect(sortFieldFor('name', FIELDS)).toBe('name.keyword');
    expect(sortFieldFor('total', FIELDS)).toBe('total');
  });

  it('formats sizes and validates index names', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatCount(2000)).toBe('2,000');
    expect(formatCount(1_250_000)).toBe('1.3M');
    expect(indexNameError('Shop')).toMatch(/lowercase/);
    expect(indexNameError('_x')).toMatch(/start/);
    expect(indexNameError('a b')).toMatch(/spaces/);
    expect(indexNameError('shop-orders-2026')).toBeNull();
  });
});

describe('aggregation views', () => {
  it('turns buckets with sub-metrics into tables and metrics into tiles', () => {
    const v = aggViews({
      by_status: { sum_other_doc_count: 3, buckets: [{ key: 'paid', doc_count: 10, revenue: { value: 120.5 }, per_month: { buckets: [{ key_as_string: '2025-01', key: 1, doc_count: 4 }] } }] },
      stats: { count: 2, min: 1, max: 3, avg: 2, sum: 4 },
      top: { hits: { total: { value: 9 }, hits: [{ _id: 'a', _source: { x: 1 } }] } },
      only_paid: { doc_count: 7, avg_total: { value: 3.5 } },
    });
    expect(v[0]).toMatchObject({ kind: 'buckets', otherDocs: 3, metricNames: ['revenue'], maxCount: 10 });
    expect((v[0] as { rows: { children: unknown[] }[] }).rows[0].children[0]).toMatchObject({ kind: 'buckets', name: 'per_month' });
    expect(v[1]).toMatchObject({ kind: 'metric', values: [{ label: 'count', value: 2 }, { label: 'min', value: 1 }, { label: 'max', value: 3 }, { label: 'avg', value: 2 }, { label: 'sum', value: 4 }] });
    expect(v[2]).toMatchObject({ kind: 'hits', total: 9 });
    expect(v[3]).toMatchObject({ kind: 'single', docCount: 7 });
  });
});

describe('mock cluster', () => {
  const es = new EsMock();

  it('holds the shop seed with Persian names', () => {
    expect(es.listIndices(false).map((i) => [i.name, i.docsCount])).toEqual([['shop-customers', 200], ['shop-orders', 2000], ['shop-products', 50]]);
    const r = es.searchNormalised('shop-customers', { query: { match: { name: 'رضایی' } } }, {});
    expect(r.hits.map((h) => (h.source as { name: string }).name)).toEqual(['علی رضایی']);
  });

  it('evaluates bool / range / nested queries and aggregations', () => {
    const paid = es.searchNormalised('shop-sales', { query: { bool: { filter: [{ term: { status: 'paid' } }, { range: { total: { gte: 100 } } }] } }, size: 0, aggs: { s: { sum: { field: 'total' } } } }, {});
    expect(paid.total).toBeGreaterThan(0);
    expect((paid.aggregations as { s: { value: number } }).s.value).toBeGreaterThan(100);
    const nested = es.searchNormalised('shop-orders', { query: { nested: { path: 'items', query: { term: { 'items.sku': 'SKU-0001' } } } }, size: 1 }, {});
    expect(JSON.stringify(nested.hits[0].source)).toContain('SKU-0001');
    const terms = es.searchNormalised('shop-orders', { size: 0, aggs: { st: { terms: { field: 'status' } } } }, {});
    const buckets = (terms.aggregations as { st: { buckets: { key: string; doc_count: number }[] } }).st.buckets;
    expect(buckets.reduce((n, b) => n + b.doc_count, 0)).toBe(2000);
  });

  it('enforces optimistic concurrency', () => {
    const r = es.putDoc('shop-products', 'p1', { a: 1 }, {});
    expect(() => es.putDoc('shop-products', 'p1', { a: 2 }, { ifSeqNo: r.seqNo + 7, ifPrimaryTerm: 1 })).toThrow(/version conflict/);
    expect(es.putDoc('shop-products', 'p1', { a: 2 }, { ifSeqNo: r.seqNo, ifPrimaryTerm: 1 }).result).toBe('updated');
  });

  it('answers SQL and the console', () => {
    const sql = es.sql('SELECT status, COUNT(*) AS n FROM "shop-orders" GROUP BY status ORDER BY n DESC');
    expect(sql.columns.map((c) => c.name)).toEqual(['status', 'n']);
    expect(sql.rows.reduce((n, r) => n + (r[1] as number), 0)).toBe(2000);
    const cat = es.console('GET', '/_cat/indices?v&s=index', null, false);
    expect(cat.body.split('\n')[0]).toMatch(/^health\s+status\s+index/);
    expect(es.console('GET', '/nope/_search', null, false).status).toBe(404);
    expect(() => es.console('DELETE', '/shop-orders', null, true)).toThrow(/read-only/);
  });
});

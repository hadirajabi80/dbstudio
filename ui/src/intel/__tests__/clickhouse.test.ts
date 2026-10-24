// plan-batch3 WP-CH: ClickHouse dialect (lexing, completion incl. engines/settings/formats, functions, classification,
// formatter rules).
import { beforeAll, describe, expect, it } from 'vitest';
import { getSpec } from '../dialect';
import { ensureDialect } from '../dialect/registry';
import { chComplete, chSlot, classifyClickHouse, type ClickHouseSpec } from '../dialect/clickhouse';
import { tokenize } from '../lexer/lexer';
import { createIntel } from '../index';
import { formatSql } from '../../format';
import { rulesFor } from '../../format/layout';
import type { Token } from '../types';
import { complete, doc, find, fixtures, labels } from './helpers';

const kinds = (s: string) => tokenize(s, getSpec('clickhouse')).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.text}`);

/** Intel with the shop fixture (the ClickHouse completion source comes from the spec, DialectSpec.complete). */
function chIntel() {
  const i = createIntel('clickhouse');
  i.setCatalog(fixtures.clickhouse);
  return i;
}

const kindOf = (sql: string) => {
  const i = createIntel('clickhouse');
  i.setDocument('ch://k', sql);
  return i.statements('ch://k')[0].kind;
};

beforeAll(async () => {
  await ensureDialect('clickhouse');
});

describe('ClickHouse spec', () => {
  it('is the real spec with backticks, insensitive folding, the system catalog and the completion source', () => {
    const spec = getSpec('clickhouse') as ClickHouseSpec;
    expect(spec.quote).toEqual(['`', '`']);
    expect(spec.caseFolding).toBe('insensitive');
    expect(spec.systemCatalog?.schemas[0].name).toBe('system');
    expect(spec.systemCatalog?.schemas[0].objects.map((o) => o.n)).toEqual(expect.arrayContaining(['parts', 'mutations', 'merges', 'processes', 'query_log', 'tables', 'columns']));
    expect(spec.complete).toBe(chComplete);
    expect(spec.functions.length).toBeGreaterThan(400);
    expect(rulesFor(spec).dialect).toBe('clickhouse');
  });

  it('keeps everyday ClickHouse column names out of the reserved words', () => {
    const spec = getSpec('clickhouse');
    for (const w of ['DATABASE', 'TABLE', 'DEFAULT', 'PARTITION', 'ROWS', 'ENGINE', 'NAME', 'TYPE', 'KEY', 'FORMAT']) expect(spec.keywords.has(w)).toBe(false);
    for (const w of ['PREWHERE', 'FINAL', 'SAMPLE', 'SETTINGS', 'GLOBAL', 'ASOF', 'OPTIMIZE']) expect(spec.keywords.has(w)).toBe(true);
    expect(spec.contextualKeywords.has('ENGINE')).toBe(true);
  });
});

describe('ClickHouse lexer', () => {
  it('backticks, # comments, backslash escapes, {p:Type} and 0x literals', () => {
    expect(kinds("SELECT `order date`, 'it\\'s' # note\nFROM t WHERE id = {id:UInt32} AND h = 0x1F")).toEqual([
      'keyword:SELECT', 'quotedIdent:`order date`', 'punct:,', "string:'it\\'s'", 'comment:# note', 'keyword:FROM', 'ident:t',
      'keyword:WHERE', 'ident:id', 'op:=', 'param:{id:UInt32}', 'keyword:AND', 'ident:h', 'op:=', 'number:0x1F',
    ]);
  });

  it(':name and @name parameters, but the :: cast and == stay operators', () => {
    expect(kinds('SELECT x::UInt8, a == b, :p, @q')).toEqual([
      'keyword:SELECT', 'ident:x', 'op:::', 'ident:UInt8', 'punct:,', 'ident:a', 'op:==', 'ident:b', 'punct:,', 'param::p', 'punct:,', 'param:@q',
    ]);
  });

  it('`default` and `database` are plain names (the default database, system.parts columns)', () => {
    expect(kinds('SELECT database, table FROM default.t')).toEqual([
      'keyword:SELECT', 'ident:database', 'punct:,', 'ident:table', 'keyword:FROM', 'ident:default', 'punct:.', 'ident:t',
    ]);
  });
});

describe('ClickHouse completion', () => {
  it('columns of the shop tables with ClickHouse types', () => {
    const r = complete('clickhouse', 'SELECT | FROM orders o');
    const total = find(r.items, 'total');
    expect(total?.description).toBe('Decimal(12, 2)');
    expect(labels(r.items.filter((x) => x.kind === 'column'))).toEqual(expect.arrayContaining(['id', 'customer_id', 'order_date', 'status', 'tags']));
  });

  it('tables, the view, the materialized view after FROM', () => {
    const r = complete('clickhouse', 'SELECT * FROM |');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['orders', 'customers', 'customer_orders', 'daily_sales']));
  });

  it('system tables and their columns', () => {
    const r = complete('clickhouse', 'SELECT * FROM system.|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['parts', 'mutations', 'merges', 'query_log']));
    const c = complete('clickhouse', 'SELECT | FROM system.parts');
    expect(labels(c.items)).toEqual(expect.arrayContaining(['partition', 'bytes_on_disk', 'active', 'rows']));
  });

  it('ClickHouse clause keywords after a source', () => {
    const r = complete('clickhouse', 'SELECT * FROM orders |');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['PREWHERE', 'FINAL', 'SAMPLE', 'ARRAY JOIN', 'LIMIT BY', 'SETTINGS', 'FORMAT']));
  });

  it('functions with signatures (aggregates mention the combinators)', () => {
    const r = complete('clickhouse', 'SELECT uniq| FROM orders');
    // ClickHouse names are case-sensitive: the completer keeps the catalog's spelling (preserveNameCase)
    const u = r.items.find((x) => x.label.toLowerCase() === 'uniqexact');
    expect(u?.kind).toBe('function');
    expect(u?.label).toBe('uniqExact');
    expect(u?.insertText).toBe('uniqExact($0)');
    expect(getSpec('clickhouse').functionMap.get('UNIQEXACT')?.doc).toMatch(/-If/);
    expect(getSpec('clickhouse').functionMap.get('TOYYYYMM')?.returns).toBe('UInt32');
  });

  it('engines after ENGINE =', () => {
    const i = chIntel();
    const d = doc(i, 'CREATE TABLE t (id UInt64) ENGINE = |');
    const r = i.complete(d.uri, d.offset);
    expect(r.items[0].label).toBe('MergeTree');
    expect(r.items.slice(0, 10).every((x) => x.detail === 'table engine')).toBe(true);
    const rmt = find(r.items, 'ReplacingMergeTree');
    expect(rmt?.isSnippet).toBe(true);
    expect(rmt?.insertText).toBe('ReplacingMergeTree(${1:version})');
    const p = doc(i, 'CREATE TABLE t (id UInt64) ENGINE = Repl|');
    expect(labels(i.complete(p.uri, p.offset).items, 3)).toContain('ReplicatedMergeTree');
  });

  it('settings after SETTINGS and after a comma in the SETTINGS list', () => {
    const i = chIntel();
    const a = doc(i, 'SELECT * FROM orders SETTINGS max_|');
    const r = i.complete(a.uri, a.offset);
    expect(r.items[0].label.startsWith('max_')).toBe(true);
    expect(find(r.items, 'max_threads')?.insertText).toBe('max_threads = ');
    const b = doc(i, 'SELECT * FROM orders SETTINGS max_threads = 4, |');
    expect(labels(i.complete(b.uri, b.offset).items)).toContain('final');
    const t = doc(i, 'CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id SETTINGS index_|');
    expect(labels(i.complete(t.uri, t.offset).items, 3)).toContain('index_granularity');
  });

  it('formats after FORMAT, codecs in CODEC(, layouts and sources in a dictionary', () => {
    const i = chIntel();
    const f = doc(i, 'SELECT 1 FORMAT JSONE|');
    expect(i.complete(f.uri, f.offset).items[0].label).toBe('JSONEachRow');
    const c = doc(i, 'CREATE TABLE t (ts DateTime CODEC(Delta, |');
    expect(labels(i.complete(c.uri, c.offset).items)).toContain('ZSTD');
    const l = doc(i, 'CREATE DICTIONARY d (id UInt64) PRIMARY KEY id LAYOUT(|');
    expect(labels(i.complete(l.uri, l.offset).items)).toContain('HASHED');
    const s = doc(i, 'CREATE DICTIONARY d (id UInt64) PRIMARY KEY id SOURCE(|');
    expect(labels(i.complete(s.uri, s.offset).items)).toContain('CLICKHOUSE');
  });

  it('chSlot ignores SETTINGS inside parentheses and ordinary clauses', () => {
    const i = chIntel();
    const d = doc(i, 'SELECT * FROM orders WHERE |');
    const r = i.complete(d.uri, d.offset);
    expect(find(r.items, 'max_threads')).toBeUndefined();
    void chSlot;
  });
});

describe('ClickHouse statement classification', () => {
  it('mutations and partition drops are destructive', () => {
    expect(kindOf('ALTER TABLE orders DELETE WHERE id = 1')).toBe('delete:destructive');
    expect(kindOf('ALTER TABLE orders UPDATE status = \'paid\' WHERE id = 1')).toBe('update:destructive');
    expect(kindOf('ALTER TABLE orders DROP PARTITION 202601')).toBe('drop:destructive');
    expect(kindOf('ALTER TABLE orders ADD COLUMN x UInt8, DROP COLUMN y')).toBe('drop:destructive');
    expect(kindOf('ALTER TABLE orders ADD COLUMN x UInt8')).toBe('alter');
    expect(kindOf('ALTER TABLE orders MODIFY TTL order_date + INTERVAL 1 YEAR')).toBe('alter');
  });

  it('DETACH, KILL, CREATE OR REPLACE and SYSTEM SHUTDOWN are destructive; reads and maintenance are not', () => {
    expect(kindOf('DETACH TABLE orders')).toBe('drop:destructive');
    expect(kindOf("KILL QUERY WHERE query_id = 'x'")).toBe('other:destructive');
    expect(kindOf('CREATE OR REPLACE TABLE t (id UInt8) ENGINE = Memory')).toBe('create:destructive');
    expect(kindOf('SYSTEM SHUTDOWN')).toBe('other:destructive');
    expect(kindOf('SYSTEM FLUSH LOGS')).toBe('other');
    expect(kindOf('OPTIMIZE TABLE orders FINAL')).toBe('other');
    expect(kindOf('SHOW CREATE TABLE orders')).toBe('select');
    expect(kindOf('DESCRIBE TABLE orders')).toBe('select');
    expect(kindOf('TRUNCATE TABLE orders')).toBe('truncate:destructive');
    expect(kindOf('DELETE FROM orders WHERE id = 1')).toBe('delete');
    expect(kindOf('SELECT 1 FROM orders FINAL')).toBe('select');
  });

  it('the hook answers undefined for shared heads', () => {
    const t = (u: string) => ({ kind: 'keyword', text: u, upper: u, start: 0, end: 0, line: 1, col: 1 }) as Token;
    expect(classifyClickHouse([t('SELECT')], 0)).toBeUndefined();
  });
});

describe('ClickHouse formatter', () => {
  it('formats a ClickHouse query with the standard clauses on their own lines and backticks kept', () => {
    const r = formatSql("select `order date`, count() from shop.orders final prewhere status = 'paid' where total > 10 group by 1 order by 2 desc limit 10", 'clickhouse');
    expect(r.text).toMatch(/^SELECT/);
    expect(r.text).toContain('`order date`');
    expect(r.text).toMatch(/\nFROM shop\.orders FINAL/);
    expect(r.text).toMatch(/\nWHERE total > 10/);
    expect(r.text).toMatch(/\nGROUP BY 1/);
    expect(r.text).toMatch(/\nLIMIT 10/);
  });

  it('PREWHERE, ARRAY JOIN, GLOBAL ANY JOIN, SETTINGS and FORMAT start their own lines', () => {
    const r = formatSql("select a, tag from t final left array join tags as tag global any left join u on u.id = t.id prewhere x = 1 and y = 2 where z = 3 limit 5 by a settings max_threads = 4, join_use_nulls = 1 format JSONEachRow", 'clickhouse');
    expect(r.warnings).toEqual([]);
    expect(r.text).toBe([
      'SELECT', '    a,', '    tag', 'FROM t FINAL', 'LEFT ARRAY JOIN tags AS tag', 'GLOBAL ANY LEFT JOIN u ON u.id = t.id', 'PREWHERE x = 1', '    AND y = 2',
      'WHERE z = 3', 'LIMIT 5 BY a', 'SETTINGS max_threads = 4, join_use_nulls = 1', 'FORMAT JSONEachRow',
    ].join('\n'));
    // format / settings as function or column names are untouched
    expect(formatSql("select format('{}', a), settings from t", 'clickhouse').text).toContain("format('{}', a)");
  });

  it('keeps function-like keywords tight and splits statements at ClickHouse statement words', () => {
    const r = formatSql("select if(a, 1, 2), any(x) from t;\noptimize table t final;\nsystem flush logs", 'clickhouse');
    expect(r.text).toContain('IF(a, 1, 2)');
    expect(r.text).toContain('ANY(x)');
    // non-reserved words of maintenance statements keep the case they were typed in (no layout hook for them yet)
    expect(r.text).toMatch(/\nOPTIMIZE table t FINAL;\n/);
    expect(r.text).toMatch(/\nSYSTEM flush logs$/);
  });

  it('case-sensitive ClickHouse names survive the default function/type case (preserveNameCase)', () => {
    const d = formatSql('select arrayJoin(tags), toYYYYMM(d), CAST(x AS UInt32), cast(y as Nullable(DateTime)) from t', 'clickhouse');
    expect(d.text).toContain('arrayJoin(tags)');
    expect(d.text).toContain('toYYYYMM(d)');
    expect(d.text).toContain('UInt32');
    expect(d.text).toContain('Nullable(DateTime)');
    expect(d.text).not.toContain('ARRAYJOIN');
    const r = formatSql('select arrayJoin(tags), toYYYYMM(d), CAST(x AS UInt32) from t', 'clickhouse', { functionCase: 'asIs', datatypeCase: 'asIs' });
    expect(r.text).toContain('arrayJoin(tags)');
    expect(r.text).toContain('toYYYYMM(d)');
    expect(r.text).toContain('UInt32');
  });
});

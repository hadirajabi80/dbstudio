// CQL formatter (plan-batch3 WP-CS): golden strings on the shop keyspace. The layout is the shared SQLite path plus the
// CQL rules (format/rules/cql.ts); BEGIN BATCH bodies, `<…>` type arguments, `{…}` / `[…]` literals and the CQL
// clauses (IF, USING TTL, ALLOW FILTERING, PER PARTITION LIMIT, table options) need the layout change requested as R3-1
// in docs/wp-notes/WP-CS-intel.md: those goldens skip themselves until it is in.
import { describe, expect, it } from 'vitest';
import { canonicalTokens, formatSql } from '../index';
import { ensureDialect, getSpec } from '../../intel/dialect';
import { tokenize } from '../../intel/lexer/lexer';
import { rulesFor } from '../layout';

await ensureDialect('cql');
const fmt = (sql: string, o = {}) => formatSql(sql, 'cql', o).text;
const R3_LAYOUT = fmt('BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH;').startsWith('BEGIN BATCH\n    INSERT');

const norm = (s: string) => canonicalTokens(tokenize(s, getSpec('cql'))).map((t) => `${t.kind}:${t.kind === 'string' || t.kind === 'number' || t.kind === 'comment' ? t.text : t.upper}`);

function check(input: string, expected: string): void {
  const r = formatSql(input, 'cql');
  expect(r.warnings).toEqual([]);
  expect(r.text).toBe(expected);
  expect(fmt(r.text)).toBe(r.text);
  expect(norm(r.text)).toEqual(norm(input));
}

const SAMPLES = [
  `select id, name, email from shop.customers where id = 1 and name = 'x' order by name desc limit 10 allow filtering;`,
  `insert into shop.customers (id, name, tags, preferences, address) values (1, 'Alice', {'vip', 'news'}, {'language': 'de', 'channel': 'email'}, {street: 'x', city: 'y'}) if not exists using ttl 86400;`,
  `update shop.customers using ttl 3600 and timestamp 123 set name = 'B', tags = tags + {'x'}, phones = ['1', '2'] where id = 1 if name = 'A';`,
  `delete name, email from shop.customers using timestamp 1 where id = 1 if exists;`,
  `create table if not exists shop.events_by_day (customer_id int, day date, event_time timeuuid, kind text, tags set<text>, m map<text, frozen<list<int>>>, primary key ((customer_id, day), event_time)) with clustering order by (event_time desc) and comment = 'x' and default_time_to_live = 7776000;`,
  `create keyspace shop with replication = {'class': 'SimpleStrategy', 'replication_factor': 1} and durable_writes = true;`,
  `begin batch insert into t (a) values (1); update t set b = 2 where a = 1; apply batch;`,
  `select * from items order by embedding ann of [0.1, 0.2, 0.3] limit 5;`,
  `create function shop.line_total(qty int, unit_price decimal) returns null on null input returns decimal language java as $$ return unit_price; $$;`,
  `create materialized view shop.orders_by_status as select id, status from shop.orders where status is not null and id is not null primary key ((status), id) with comment = 'x';`,
  `select * from shop.orders where id in (1, 2) group by id per partition limit 2 limit 10;`,
  `-- comment\nconsistency quorum; // cqlsh comment\ntracing on;\nuse shop;`,
];

describe('CQL formatter: safety on every sample (with or without R3-1)', () => {
  it('rules resolve to the CQL tables', () => {
    const r = rulesFor(getSpec('cql'));
    expect(r.dialect).toBe('cql');
    expect(r.statementStarts.has('BEGIN')).toBe(true);
    expect(r.functionKeywords.has('TOKEN')).toBe(true);
  });
  it.each(SAMPLES)('%s', (s) => {
    const r = formatSql(s, 'cql');
    expect(r.warnings).toEqual([]);
    expect(fmt(r.text)).toBe(r.text);
    expect(norm(r.text)).toEqual(norm(s));
  });
});

describe('CQL formatter: goldens', () => {
  it('SELECT … WHERE … ORDER BY … LIMIT', () => {
    check(
      "select order_date, order_id, total from shop.orders_by_customer where customer_id = 4 and order_date >= '2026-03-01' order by order_date desc limit 10;",
      "SELECT\n    order_date,\n    order_id,\n    total\nFROM shop.orders_by_customer\nWHERE customer_id = 4\n    AND order_date >= '2026-03-01'\nORDER BY order_date DESC\nLIMIT 10;",
    );
  });
  it('token(), writetime(), ttl() are function calls', () => {
    check(
      'select token(id), writetime(name), ttl(name) from shop.customers where token(id) > token(3);',
      'SELECT\n    TOKEN(id),\n    WRITETIME(name),\n    TTL(name)\nFROM shop.customers\nWHERE TOKEN(id) > TOKEN(3);',
    );
  });
  it('INSERT with bind markers, uuid and timeuuid functions', () => {
    check(
      'insert into shop.orders (id, customer_id, order_date, status) values (?, :cid, toTimestamp(now()), 6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11);',
      'INSERT INTO shop.orders (id, customer_id, order_date, status)\nVALUES (?, :cid, TOTIMESTAMP(NOW()), 6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11);',
    );
  });
  it('counter UPDATE', () => {
    check('update shop.product_views set views = views + 1 where product_id = 3;', 'UPDATE shop.product_views\nSET views = views + 1\nWHERE product_id = 3;');
  });
  it('DELETE of columns, USING TIMESTAMP', () => {
    check('delete name, email from shop.customers using timestamp 1 where id = 1;', 'DELETE name, email\nFROM shop.customers USING TIMESTAMP 1\nWHERE id = 1;');
  });
  it('shell commands and statements one per line, comments kept', () => {
    check(
      'use shop; consistency local_quorum; -- read your writes\ntracing on; paging off; describe table shop.orders; truncate table shop.orders; list roles;',
      'USE shop;\nCONSISTENCY LOCAL_QUORUM; -- read your writes\nTRACING ON;\nPAGING OFF;\nDESCRIBE TABLE shop.orders;\nTRUNCATE TABLE shop.orders;\nLIST ROLES;',
    );
  });
  it('keyword case lower', () => {
    expect(fmt('SELECT * FROM shop.customers WHERE id = 1 ALLOW FILTERING;', { keywordCase: 'lower' })).toContain('allow filtering;');
  });
  it('$$ UDF body is kept verbatim', () => {
    expect(fmt('create function f(x int) returns null on null input returns int language java as $$ return  x ; $$;')).toContain('$$ return  x ; $$;');
  });
});

describe('CQL formatter: goldens with the CQL layout (R3-1)', () => {
  it.skipIf(!R3_LAYOUT)('BEGIN BATCH body one level in, APPLY BATCH under BEGIN', () => {
    check(
      "begin batch insert into shop.orders (id, status) values (7, 'new'); update shop.product_views set views = views + 1 where product_id = 2; apply batch;",
      "BEGIN BATCH\n    INSERT INTO shop.orders (id, status)\n    VALUES (7, 'new');\n    UPDATE shop.product_views\n    SET views = views + 1\n    WHERE product_id = 2;\nAPPLY BATCH;",
    );
    check('begin unlogged batch using timestamp 42 delete from t where a = 1; apply batch;', 'BEGIN UNLOGGED BATCH USING TIMESTAMP 42\n    DELETE FROM t\n    WHERE a = 1;\nAPPLY BATCH;');
  });
  it.skipIf(!R3_LAYOUT)('INSERT with collection / UDT literals, IF NOT EXISTS, USING TTL', () => {
    check(
      "insert into shop.customers (id, tags, preferences, address) values (1, {'vip', 'news'}, {'language': 'de'}, {street: 'x', city: 'y'}) if not exists using ttl 86400;",
      "INSERT INTO shop.customers (id, tags, preferences, address)\nVALUES (1, {'vip', 'news'}, {'language': 'de'}, {street: 'x', city: 'y'})\nIF NOT EXISTS\nUSING TTL 86400;",
    );
  });
  it.skipIf(!R3_LAYOUT)('UPDATE … USING … SET collections … WHERE … IF', () => {
    check(
      "update shop.customers using ttl 3600 set tags = tags + {'x'}, phones = ['1', '2'], preferences['k'] = 'v' where id = 1 if name = 'A' and email = null;",
      "UPDATE shop.customers USING TTL 3600\nSET\n    tags = tags + {'x'},\n    phones = ['1', '2'],\n    preferences['k'] = 'v'\nWHERE id = 1\nIF name = 'A'\n    AND email = NULL;",
    );
  });
  it.skipIf(!R3_LAYOUT)('ALLOW FILTERING, PER PARTITION LIMIT, ANN OF', () => {
    check(
      'select * from shop.orders where id in (1, 2) group by id per partition limit 2 limit 10 allow filtering;',
      'SELECT *\nFROM shop.orders\nWHERE id IN (1, 2)\nGROUP BY id\nPER PARTITION LIMIT 2\nLIMIT 10\nALLOW FILTERING;',
    );
    check('select * from items order by embedding ann of [0.1, 0.2, 0.3] limit 5;', 'SELECT *\nFROM items\nORDER BY embedding ANN OF [0.1, 0.2, 0.3]\nLIMIT 5;');
  });
  it.skipIf(!R3_LAYOUT)('CREATE TABLE: type arguments, PRIMARY KEY ((a, b), c), WITH … AND … options', () => {
    check(
      "create table if not exists shop.events_by_day (customer_id int, day date, event_time timeuuid, tags set<text>, m map<text, frozen<list<int>>>, v vector<float, 3>, primary key ((customer_id, day), event_time)) with clustering order by (event_time desc) and comment = 'x' and compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_size': 1};",
      "CREATE TABLE IF NOT EXISTS shop.events_by_day (\n    customer_id INT,\n    day DATE,\n    event_time TIMEUUID,\n    tags SET<TEXT>,\n    m MAP<TEXT, FROZEN<LIST<INT>>>,\n    v VECTOR<FLOAT, 3>,\n    PRIMARY KEY ((customer_id, day), event_time)\n) WITH CLUSTERING ORDER BY (event_time DESC)\n    AND comment = 'x'\n    AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_size': 1};",
    );
  });
  it.skipIf(!R3_LAYOUT)('CREATE KEYSPACE … WITH replication = {…} AND durable_writes', () => {
    check(
      "create keyspace if not exists shop with replication = {'class': 'NetworkTopologyStrategy', 'dc1': 3} and durable_writes = true;",
      "CREATE KEYSPACE IF NOT EXISTS shop WITH replication = {'class': 'NetworkTopologyStrategy', 'dc1': 3}\n    AND durable_writes = TRUE;",
    );
  });
  it.skipIf(!R3_LAYOUT)('CREATE FUNCTION header lines, CREATE MATERIALIZED VIEW', () => {
    check(
      'create function shop.line_total(qty int, unit_price decimal) returns null on null input returns decimal language java as $$ return unit_price; $$;',
      'CREATE FUNCTION shop.line_total (qty INT, unit_price DECIMAL)\n    RETURNS NULL ON NULL INPUT\n    RETURNS DECIMAL\n    LANGUAGE java\n    AS $$ return unit_price; $$;',
    );
    check(
      "create materialized view shop.orders_by_status as select id, status from shop.orders where status is not null and id is not null primary key ((status), id) with comment = 'x' and gc_grace_seconds = 0;",
      "CREATE MATERIALIZED VIEW shop.orders_by_status AS\nSELECT\n    id,\n    status\nFROM shop.orders\nWHERE status IS NOT NULL\n    AND id IS NOT NULL\nPRIMARY KEY ((status), id)\nWITH comment = 'x'\n    AND gc_grace_seconds = 0;",
    );
  });
  it.skipIf(!R3_LAYOUT)('the seed script formats without warnings and idempotently', async () => {
    const seed = (await import('../../../../engine/tests/docker/seed-cassandra.cql?raw')).default as string;
    const r = formatSql(seed, 'cql');
    expect(r.warnings).toEqual([]);
    expect(fmt(r.text)).toBe(r.text);
    expect(norm(r.text)).toEqual(norm(seed));
    expect(r.text).toContain("    {street: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE'}");
  });
});

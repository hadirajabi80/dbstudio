// CQL (Cassandra 5 / ScyllaDB) dialect (plan-batch3 WP-CS): spec, lexer hook, splitter, classification, completion,
// hover/signatures against the Cassandra `shop` keyspace fixture (mirrors engine/tests/docker/seed-cassandra.cql).
// Tests named "(R3-n)" need the shared changes requested in docs/wp-notes/WP-CS-intel.md: they skip themselves until
// the change is in (a probe below detects it) and then pin the behaviour.
import { describe, expect, it } from 'vitest';
import { getSpec } from '../dialect';
import { ensureDialect, isDialectReady } from '../dialect/registry';
import { tokenize } from '../lexer/lexer';
import { createIntel } from '../index';
import { complete, doc, find, fixtures, intelFor, labels } from './helpers';
import type { IntelOptions } from '../types';

await ensureDialect('cql');
const cql = getSpec('cql');
const kinds = (s: string) => tokenize(s, cql).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.text}`);
const cols = (items: { kind: string; label: string }[]) => items.filter((x) => x.kind === 'column').map((x) => x.label);

let n = 0;
function split(text: string, opts?: Partial<IntelOptions>) {
  const i = createIntel('cql', opts);
  const uri = `cql-split://${++n}`;
  i.setDocument(uri, text);
  return i.statements(uri);
}
const texts = (text: string, opts?: Partial<IntelOptions>) => split(text, opts).map((s) => s.text);

// probes for the shared changes (R3) this WP asked for
const R3_FOLLOWERS = labels(complete('cql', 'CONSISTENCY |').items).includes('QUORUM');
const R3_PARSER = cols(complete('cql', 'UPDATE shop.orders USING TTL 10 SET |').items).includes('status');

describe('CQL spec', () => {
  it('loads lazily and is the real spec', () => {
    expect(isDialectReady('cql')).toBe(true);
    expect(cql.id).toBe('cql');
    expect(cql.caseFolding).toBe('lower');
    expect(cql.quote).toEqual(['"', '"']);
    expect(cql.fold('Customers', false)).toBe('customers');
    expect(cql.fold('Customers', true)).toBe('Customers');
    expect(cql.split).toBeTypeOf('function');
    expect(cql.formatRules).toBeTypeOf('function');
    expect(cql.classify).toBeTypeOf('function');
  });

  it('reserved and statement words are keywords; common column names are not', () => {
    for (const w of ['SELECT', 'BATCH', 'APPLY', 'ALLOW', 'FILTERING', 'KEYSPACE', 'TOKEN', 'TTL', 'WRITETIME', 'CONTAINS', 'QUORUM', 'LOCAL_QUORUM']) expect(cql.keywords.has(w), w).toBe(true);
    for (const w of ['TYPE', 'USER', 'ROLE', 'REPLICATION', 'NAME', 'STATUS']) expect(cql.keywords.has(w), w).toBe(false);
    expect(cql.contextualKeywords.has('REPLICATION')).toBe(true);
    for (const w of ['BEGIN', 'TRUNCATE', 'USE', 'DESCRIBE', 'CONSISTENCY', 'TRACING', 'PAGING', 'SERIAL', 'SHOW', 'LIST', 'GRANT']) expect(cql.statementStarts.has(w), w).toBe(true);
  });

  it('data types (collections and Cassandra 5 vectors included)', () => {
    for (const t of ['ascii', 'bigint', 'blob', 'boolean', 'counter', 'date', 'decimal', 'double', 'duration', 'float', 'inet', 'int', 'smallint', 'text', 'time', 'timestamp', 'timeuuid', 'tinyint', 'uuid', 'varchar', 'varint', 'list', 'map', 'tuple', 'frozen', 'vector']) {
      expect(cql.dataTypeSet.has(t.toUpperCase()), t).toBe(true);
    }
  });

  it('built-in functions with signatures (Cassandra 5 names, pre-5 aliases deprecated)', () => {
    const f = (name: string) => cql.functionMap.get(name.toUpperCase());
    for (const name of ['now', 'uuid', 'current_timestamp', 'to_date', 'to_timestamp', 'to_unix_timestamp', 'min_timeuuid', 'max_timeuuid', 'token', 'ttl', 'writetime', 'maxwritetime', 'text_as_blob', 'blob_as_text', 'to_json', 'from_json', 'cast', 'count', 'min', 'max', 'sum', 'avg', 'abs', 'exp', 'log', 'log10', 'round', 'map_keys', 'map_values', 'collection_count', 'collection_min', 'collection_max', 'collection_sum', 'collection_avg', 'mask_null', 'mask_default', 'mask_replace', 'mask_inner', 'mask_outer', 'mask_hash', 'similarity_cosine', 'similarity_euclidean', 'similarity_dot_product']) {
      expect(f(name), name).toBeTruthy();
      expect(f(name)!.doc.length, name).toBeGreaterThan(10);
    }
    expect(f('toTimestamp')!.deprecated).toBe(true);
    expect(f('dateOf')!.deprecated).toBe(true);
    expect(f('intAsBlob')!.deprecated).toBe(true);
    expect(f('to_timestamp')!.signatures.map((s) => s.params)).toEqual([['value timeuuid'], ['value date']]);
    expect(f('count')!.kind).toBe('aggregate');
    expect(f('mask_inner')!.signatures).toHaveLength(2);
    expect(cql.operators.map((o) => o.op)).toEqual(expect.arrayContaining(['CONTAINS', 'CONTAINS KEY', 'ANN OF']));
  });

  it('system keyspaces with their main tables and CQL column types', () => {
    const sys = cql.systemCatalog!.schemas;
    expect(sys.map((s) => s.name)).toEqual(['system_schema', 'system', 'system_traces', 'system_auth', 'system_views']);
    const table = (ks: string, t: string) => sys.find((s) => s.name === ks)!.objects.find((o) => o.n === t)!;
    expect(sys.find((s) => s.name === 'system_schema')!.objects.map((o) => o.n)).toEqual(expect.arrayContaining(['keyspaces', 'tables', 'columns', 'views', 'types', 'functions', 'aggregates', 'indexes', 'triggers', 'dropped_columns']));
    expect(table('system_schema', 'columns').pk).toEqual(['keyspace_name', 'table_name', 'column_name']);
    expect(table('system_schema', 'keyspaces').c!.find((c) => c[0] === 'replication')![1]).toBe('frozen<map<text, text>>');
    expect(table('system', 'local').c!.find((c) => c[0] === 'tokens')![1]).toBe('set<text>');
    expect(table('system_traces', 'events').c!.slice(0, 2)).toEqual([['session_id', 'uuid', 0, 1, 0, 'partition key'], ['event_id', 'timeuuid', 0, 1, 0, 'clustering key ASC']]);
    for (const t of ['peers_v2', 'size_estimates']) expect(table('system', t)).toBeTruthy();
    for (const t of ['roles', 'role_permissions']) expect(table('system_auth', t)).toBeTruthy();
    for (const t of ['clients', 'settings']) expect(table('system_views', t)).toBeTruthy();
  });
});

describe('CQL fixture (shop keyspace)', () => {
  const shop = fixtures.cql;
  const obj = (name: string) => shop.schemas[0].objects.find((o) => o.n === name)!;
  it('mirrors the seed: keyspace shop, tables, view, UDT, UDF', () => {
    expect(shop.dialect).toBe('cql');
    expect(shop.defaultSchema).toBe('shop');
    expect(shop.schemas.map((s) => s.name)).toEqual(['shop']);
    expect(shop.schemas[0].objects.map((o) => `${o.t}:${o.n}`)).toEqual([
      'table:countries', 'table:customers', 'table:products', 'table:orders', 'table:orders_by_customer', 'table:order_lines',
      'table:product_views', 'table:events_by_day', 'mview:orders_by_status', 'type:address', 'func:line_total',
    ]);
  });
  it('keys: partition then clustering columns, flagged and commented; CQL type text', () => {
    expect(obj('events_by_day').pk).toEqual(['customer_id', 'day', 'event_time']);
    expect(obj('events_by_day').c!.slice(0, 3)).toEqual([
      ['customer_id', 'int', 0, 1, 0, 'partition key (1 of 2)'],
      ['day', 'date', 0, 1, 0, 'partition key (2 of 2)'],
      ['event_time', 'timeuuid', 0, 1, 0, 'clustering key DESC'],
    ]);
    expect(obj('orders_by_customer').c!.slice(0, 3).map((c) => c[5])).toEqual(['partition key', 'clustering key DESC', 'clustering key ASC']);
    const customers = obj('customers').c!;
    expect(customers.find((c) => c[0] === 'address')).toEqual(['address', 'frozen<address>', 1, 0, 0, null]);
    expect(customers.find((c) => c[0] === 'preferences')![1]).toBe('map<text, text>');
    expect(obj('product_views').c!.find((c) => c[0] === 'views')![1]).toBe('counter');
  });
});

describe('CQL lexer', () => {
  it('comments: --, // and /* */', () => {
    expect(kinds('SELECT 1 -- a\n// b\n/* c */ FROM t')).toEqual(['keyword:SELECT', 'number:1', 'comment:-- a', 'comment:// b', 'comment:/* c */', 'keyword:FROM', 'ident:t']);
  });
  it('$$ UDF bodies are one string (their ; included)', () => {
    expect(kinds("AS $$ return a; $$;")).toEqual(['keyword:AS', 'string:$$ return a; $$', 'punct:;']);
  });
  it('bind markers ? and :name', () => {
    expect(kinds('WHERE id = ? AND name = :name')).toEqual(['keyword:WHERE', 'ident:id', 'op:=', 'param:?', 'keyword:AND', 'ident:name', 'op:=', 'param::name']);
  });
  it('uuid, blob and duration literals are single number tokens', () => {
    expect(kinds('6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11 0xCAFE 1h30m 12mo 500ms')).toEqual([
      'number:6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11', 'number:0xCAFE', 'number:1h30m', 'number:12mo', 'number:500ms',
    ]);
    expect(kinds('a1b2c300-2c6c-11f1-8000-000000000004')).toEqual(['number:a1b2c300-2c6c-11f1-8000-000000000004']);
    // not a uuid: an identifier stays one, a subtraction stays three tokens
    expect(kinds('deadbeef - x')).toEqual(['ident:deadbeef', 'op:-', 'ident:x']);
    expect(kinds('a - 1')).toEqual(['ident:a', 'op:-', 'number:1']);
  });
  it('collection literals and generics: single-character brackets, no >> operator', () => {
    expect(kinds('map<text, frozen<list<int>>>')).toEqual(['ident:map', 'op:<', 'ident:text', 'punct:,', 'ident:frozen', 'op:<', 'ident:list', 'op:<', 'ident:int', 'op:>', 'op:>', 'op:>']);
    expect(kinds("{'a': 1}")).toEqual(['op:{', "string:'a'", 'op::', 'number:1', 'op:}']);
    expect(kinds('a != b')).toEqual(['ident:a', 'op:!=', 'ident:b']);
  });
});

describe('CQL splitter', () => {
  it('semicolons; CASE-free', () => expect(texts('SELECT 1;\nSELECT 2;SELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']));
  it('BEGIN BATCH … APPLY BATCH is one statement despite its semicolons', () => {
    const sql = "BEGIN BATCH\n  INSERT INTO t (a) VALUES (1);\n  UPDATE t SET b = 2 WHERE a = 1;\nAPPLY BATCH;\nSELECT * FROM t;";
    expect(texts(sql)).toEqual(["BEGIN BATCH\n  INSERT INTO t (a) VALUES (1);\n  UPDATE t SET b = 2 WHERE a = 1;\nAPPLY BATCH", 'SELECT * FROM t']);
  });
  it('UNLOGGED / COUNTER batches, USING TIMESTAMP, lower case', () => {
    expect(texts('begin unlogged batch using timestamp 1 insert into t (a) values (1); apply batch; select 1')).toEqual(['begin unlogged batch using timestamp 1 insert into t (a) values (1); apply batch', 'select 1']);
    expect(texts('BEGIN COUNTER BATCH UPDATE c SET v = v + 1 WHERE k = 1; UPDATE c SET v = v + 2 WHERE k = 2; APPLY BATCH;')).toHaveLength(1);
  });
  it('a statement without ; before BEGIN BATCH ends there', () => {
    expect(texts('SELECT 1\nBEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH')).toEqual(['SELECT 1', 'BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH']);
  });
  it('a batch without APPLY BATCH runs to the end', () => {
    expect(texts('SELECT 1;\nBEGIN BATCH INSERT INTO t (a) VALUES (1); INSERT INTO t (a) VALUES (2);')).toEqual(['SELECT 1', 'BEGIN BATCH INSERT INTO t (a) VALUES (1); INSERT INTO t (a) VALUES (2);']);
  });
  it('a blank line inside a batch never splits it', () => {
    expect(texts('BEGIN BATCH\nINSERT INTO t (a) VALUES (1);\n\nINSERT INTO t (a) VALUES (2);\nAPPLY BATCH;', { blankLineSplitsStatements: true })).toHaveLength(1);
  });
  it('$$ bodies never split', () => {
    expect(texts('CREATE FUNCTION f(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS $$ int y = x; return y; $$;\nSELECT 1;')).toEqual([
      'CREATE FUNCTION f(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS $$ int y = x; return y; $$', 'SELECT 1',
    ]);
  });
  it('the seed script splits into its statements (one batch)', async () => {
    const seed = (await import('../../../../engine/tests/docker/seed-cassandra.cql?raw')).default as string;
    const sts = split(seed);
    const batch = sts.filter((s) => /^BEGIN BATCH/.test(s.text));
    expect(batch).toHaveLength(1);
    expect(batch[0].text.endsWith('APPLY BATCH')).toBe(true);
    expect(sts.some((s) => s.text.startsWith('CREATE FUNCTION') && s.text.endsWith('$$'))).toBe(true);
    expect(sts.every((s) => !s.text.includes(';') || s.text.startsWith('BEGIN BATCH') || s.text.includes('$$'))).toBe(true);
  });
});

describe('CQL statement kinds (destructive-run guard)', () => {
  const kind = (s: string) => intelFor('cql').classify(s);
  it('DROP and TRUNCATE are destructive', () => {
    expect(kind('DROP KEYSPACE shop')).toBe('drop:destructive');
    expect(kind('DROP TABLE IF EXISTS shop.orders')).toBe('drop:destructive');
    expect(kind('TRUNCATE shop.orders')).toBe('truncate:destructive');
    expect(kind('TRUNCATE TABLE shop.orders')).toBe('truncate:destructive');
  });
  it('batches are DML (the kind of their first statement), never destructive', () => {
    expect(kind('BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH')).toBe('insert');
    expect(kind('BEGIN COUNTER BATCH UPDATE c SET v = v + 1 WHERE k = 1; APPLY BATCH')).toBe('update');
    expect(kind('BEGIN UNLOGGED BATCH DELETE FROM t WHERE a = 1; APPLY BATCH')).toBe('delete');
  });
  it('UPDATE / DELETE (always keyed in CQL), queries, session commands', () => {
    expect(kind('UPDATE t SET a = 1 WHERE id = 1')).toBe('update');
    expect(kind('DELETE FROM t WHERE id = 1')).toBe('delete');
    expect(kind('SELECT * FROM t')).toBe('select');
    expect(kind('INSERT INTO t (a) VALUES (1)')).toBe('insert');
    expect(kind('DESCRIBE TABLE shop.orders')).toBe('other');
    expect(kind('DESC KEYSPACES')).toBe('other');
    expect(kind('LIST ROLES')).toBe('other');
    expect(kind('SHOW VERSION')).toBe('other');
    expect(kind('USE shop')).toBe('use');
    for (const s of ['CONSISTENCY QUORUM', 'SERIAL CONSISTENCY LOCAL_SERIAL', 'TRACING ON', 'PAGING 100', 'PAGING OFF']) expect(kind(s), s).toBe('set');
    expect(kind('GRANT SELECT ON KEYSPACE shop TO analyst')).toBe('grant');
    expect(kind('CREATE TABLE t (a int PRIMARY KEY)')).toBe('create');
    expect(kind('ALTER TABLE t ADD b text')).toBe('alter');
  });
});

describe('CQL completion', () => {
  it('statement start: CQL statements, batches, shell commands', () => {
    const r = complete('cql', '|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['SELECT', 'INSERT INTO', 'BEGIN BATCH', 'BEGIN UNLOGGED BATCH', 'APPLY BATCH', 'TRUNCATE', 'USE', 'DESCRIBE TABLE', 'CREATE KEYSPACE', 'CREATE TABLE IF NOT EXISTS', 'CONSISTENCY', 'CONSISTENCY LOCAL_QUORUM', 'SERIAL CONSISTENCY', 'TRACING ON', 'PAGING OFF', 'SHOW VERSION', 'LIST ROLES']));
    expect(labels(r.items)).toEqual(expect.arrayContaining(['batch', 'ks', 'tbl', 'cons', 'ann']));
    expect(find(r.items, 'cons')!.insertText).toContain('${1|ONE,TWO,THREE,QUORUM,ALL,LOCAL_ONE,LOCAL_QUORUM,EACH_QUORUM,ANY,SERIAL,LOCAL_SERIAL|}');
    expect(labels(complete('cql', 'BEGIN B|').items)).not.toContain('BEGIN TRANSACTION');
  });
  it('FROM |: the keyspace, then its tables and the view', () => {
    const r = complete('cql', 'SELECT * FROM |');
    expect(r.items[0].label).toBe('shop');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['customers', 'orders', 'orders_by_customer', 'events_by_day', 'orders_by_status']));
    expect(cols(r.items)).toEqual([]);
  });
  it('keyspace.| → its tables; system keyspaces too', () => {
    expect(labels(complete('cql', 'SELECT * FROM shop.|').items).sort()).toEqual(['countries', 'customers', 'events_by_day', 'order_lines', 'orders', 'orders_by_customer', 'orders_by_status', 'product_views', 'products']);
    expect(labels(complete('cql', 'SELECT * FROM system_schema.|').items)).toEqual(expect.arrayContaining(['keyspaces', 'tables', 'columns']));
    expect(cols(complete('cql', 'SELECT | FROM system_schema.columns').items)).toEqual(expect.arrayContaining(['keyspace_name', 'table_name', 'column_name', 'kind', 'position', 'type']));
  });
  it('SELECT / WHERE columns of the table, keys first', () => {
    const r = complete('cql', 'SELECT | FROM shop.events_by_day');
    expect(cols(r.items).slice(0, 3)).toEqual(['customer_id', 'day', 'event_time']);
    const w = complete('cql', 'SELECT * FROM shop.orders_by_customer WHERE |');
    expect(cols(w.items)).toEqual(['customer_id', 'order_date', 'order_id', 'status', 'total']);
  });
  it('column documentation shows the CQL type and the key role', () => {
    const r = complete('cql', 'SELECT | FROM shop.events_by_day');
    const day = find(r.items, 'day', (x) => x.kind === 'column')!;
    expect(day.description).toBe('date');
  });
  it('after a WHERE condition: CQL clauses (ALLOW FILTERING, PER PARTITION LIMIT, IF, CONTAINS KEY)', () => {
    const r = complete('cql', 'SELECT * FROM shop.customers WHERE id = 1 |');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['AND', 'IN', 'CONTAINS', 'CONTAINS KEY', 'ORDER BY', 'PER PARTITION LIMIT', 'LIMIT', 'ALLOW FILTERING']));
    expect(labels(complete('cql', 'SELECT * FROM shop.customers |').items)).toEqual(expect.arrayContaining(['WHERE', 'PER PARTITION LIMIT', 'ALLOW FILTERING']));
  });
  it('INSERT column list and UPDATE SET: the target columns', () => {
    const r = complete('cql', 'INSERT INTO shop.orders (|');
    expect(r.items[0].insertText).toBe('id, customer_id, customer_name, note, order_date, shipping_address, status, total');
    expect(cols(complete('cql', 'UPDATE shop.product_views SET |').items)).toEqual(['product_id', 'views']);
    expect(cols(complete('cql', 'DELETE FROM shop.orders WHERE |').items)).toContain('id');
  });
  it('functions with CQL signatures; the shop UDF', () => {
    const r = complete('cql', 'SELECT to_t| FROM shop.events_by_day');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['TO_TIMESTAMP', 'TO_DATE']));
    expect(labels(complete('cql', 'SELECT line| FROM shop.order_lines').items)).toContain('line_total');
  });
  it('data types in CREATE TABLE', () => {
    expect(labels(complete('cql', 'CREATE TABLE shop.x (id |').items)).toEqual(expect.arrayContaining(['UUID', 'TIMEUUID', 'TEXT', 'INT', 'MAP', 'LIST', 'FROZEN', 'VECTOR', 'COUNTER', 'DURATION']));
  });
  it('signature help and hover of a built-in function', () => {
    const i = intelFor('cql');
    const d = doc(i, 'SELECT to_timestamp(|) FROM shop.events_by_day');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures.map((s) => s.label)).toEqual(expect.arrayContaining([expect.stringContaining('value timeuuid'), expect.stringContaining('value date')]));
    const h = doc(i, 'SELECT writ|etime(name) FROM shop.customers');
    expect(i.hover(h.uri, h.offset)!.markdown).toContain('Write timestamp');
  });
  it('no false diagnostics on the usual CQL shapes', () => {
    const i = intelFor('cql');
    const ok = [
      'SELECT id, name FROM shop.customers WHERE id = 1 LIMIT 10 ALLOW FILTERING',
      "SELECT * FROM shop.orders_by_customer WHERE customer_id = 1 AND order_date > '2026-01-01' ORDER BY order_date DESC PER PARTITION LIMIT 2",
      'SELECT token(id), writetime(name), ttl(name) FROM shop.customers WHERE token(id) > token(3)',
      'SELECT * FROM system_schema.tables WHERE keyspace_name = ?',
      "UPDATE shop.product_views SET views = views + 1 WHERE product_id = :id",
    ];
    for (const s of ok) {
      i.setDocument('cql-diag://1', s);
      expect(i.softDiagnostics('cql-diag://1').map((x) => x.message), s).toEqual([]);
    }
  });
});

describe('CQL completion with the shared parser / completer changes', () => {
  it.skipIf(!R3_FOLLOWERS)('(R3-3) CONSISTENCY | → the levels; TRACING | → ON/OFF; DESCRIBE | → object kinds', () => {
    expect(labels(complete('cql', 'CONSISTENCY |').items)).toEqual(['ONE', 'TWO', 'THREE', 'QUORUM', 'ALL', 'LOCAL_ONE', 'LOCAL_QUORUM', 'EACH_QUORUM', 'ANY', 'SERIAL', 'LOCAL_SERIAL']);
    expect(labels(complete('cql', 'SERIAL CONSISTENCY |').items)).toEqual(['SERIAL', 'LOCAL_SERIAL']);
    expect(labels(complete('cql', 'TRACING |').items)).toEqual(['ON', 'OFF']);
    expect(labels(complete('cql', 'DESCRIBE |').items)).toEqual(expect.arrayContaining(['KEYSPACES', 'TABLE', 'MATERIALIZED VIEW', 'SCHEMA']));
    expect(labels(complete('cql', 'SELECT * FROM shop.customers ALLOW |').items)).toEqual(['FILTERING']);
    // ORDER BY x DESC | is not DESCRIBE
    expect(labels(complete('cql', 'SELECT * FROM shop.orders_by_customer WHERE customer_id = 1 ORDER BY order_date DESC |').items)).not.toContain('KEYSPACES');
  });
  it.skipIf(!R3_FOLLOWERS)('(R3-3) USE | / DESCRIBE TABLE | → keyspaces / tables', () => {
    expect(labels(complete('cql', 'USE |').items)).toEqual(['shop']);
    expect(labels(complete('cql', 'DESCRIBE TABLE |').items)).toEqual(expect.arrayContaining(['shop', 'customers', 'orders']));
  });
  it.skipIf(!R3_PARSER)('(R3-2) UPDATE … USING TTL n SET |, DELETE | FROM t, batch bodies', () => {
    expect(cols(complete('cql', 'UPDATE shop.orders USING TTL 10 SET |').items)).toContain('status');
    expect(cols(complete('cql', 'DELETE | FROM shop.orders WHERE id = 1').items)).toContain('note');
    expect(complete('cql', 'BEGIN BATCH INSERT INTO shop.orders (|').items[0].insertText).toBe('id, customer_id, customer_name, note, order_date, shipping_address, status, total');
    expect(cols(complete('cql', 'BEGIN BATCH UPDATE shop.orders SET status = ? WHERE |').items)).toContain('id');
  });
  it.skipIf(!R3_PARSER)('(R3-2) collection literals are one value; UPDATE … USING has its WHERE; UDT fields', () => {
    const i = intelFor('cql');
    const ok = [
      "INSERT INTO shop.customers (id, name, tags, preferences, address) VALUES (1, 'A', {'vip', 'news'}, {'language': 'de', 'x': 'y'}, {street: 'x', city: 'y'}) IF NOT EXISTS USING TTL 86400",
      "UPDATE shop.customers USING TTL 3600 SET tags = tags + {'x'}, phones = ['1', '2'] WHERE id = 1 IF EXISTS",
      'DELETE name, email FROM shop.customers USING TIMESTAMP 1 WHERE id = 1',
      'SELECT id, address.city FROM shop.customers WHERE id = 1',
    ];
    for (const s of ok) {
      i.setDocument('cql-diag://2', s);
      expect(i.softDiagnostics('cql-diag://2').map((x) => x.message), s).toEqual([]);
    }
    // a qualifier that is no column of the table is still reported
    i.setDocument('cql-diag://3', 'SELECT nope.city FROM shop.customers WHERE id = 1');
    expect(i.softDiagnostics('cql-diag://3').map((x) => x.message)).toEqual(["Unknown alias or table 'nope'"]);
  });
});

// PostgreSQL acceptance cases (docs/PLAN-PG.md 3.8, P1–P43), in the style of plan-4.14.test.ts.
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from '../../api/types';
import { createIntel, getSpec, tokenize } from '../index';
import { CatalogIndex } from '../catalog/index';
import { needsQuoting } from '../complete/format';
import { foldName, type FunctionDef } from '../dialect/spec';
import { statementParams } from '../../editor/param-hint';
import { complete, doc, find, fixtures, indexOf, intelFor, labels, stripMd } from './helpers';

const cols = (items: { kind: string; label: string }[]) => items.filter((x) => x.kind === 'column').map((x) => x.label);
const pg = getSpec('pgsql');
const kinds = (sql: string) => tokenize(sql, pg).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.text}`);

function withSnapshot(patch: (s: CatalogSnapshot) => CatalogSnapshot) {
  const intel = createIntel('pgsql');
  intel.setCatalog(patch(JSON.parse(JSON.stringify(fixtures.pgsql)) as CatalogSnapshot));
  return intel;
}

describe('PG completion: sources and columns', () => {
  it('P1 SELECT | FROM customers c → columns first, then alias, *, functions; no tables', () => {
    const r = complete('pgsql', 'SELECT | FROM customers c');
    expect(labels(r.items, 4)).toEqual(['id', 'name', 'email', 'country_id']);
    expect(r.items[0].detail).toBe('c · customers');
    const ic = indexOf(r.items, 'c', (x) => x.kind === 'alias');
    const star = indexOf(r.items, '*');
    const fn = r.items.findIndex((x) => x.kind === 'function');
    expect(ic).toBe(4);
    expect(star).toBeGreaterThan(ic);
    expect(fn).toBeGreaterThan(star);
    expect(r.items.some((x) => x.kind === 'table')).toBe(false);
  });

  it('P2 SELECT * FROM | → public objects first, then the sales schema; pg_catalog below; no columns', () => {
    const r = complete('pgsql', 'SELECT * FROM |');
    const top = labels(r.items, 11);
    expect(top).toEqual(expect.arrayContaining(['customers', 'orders', 'products', 'countries', 'order_lines', 'customer_orders', 'customer_totals', 'orders_of']));
    expect(find(r.items, 'customer_totals')!.detail).toBe('materialized view · public');
    const sales = indexOf(r.items, 'sales', (x) => x.kind === 'schema');
    expect(sales).toBeGreaterThan(indexOf(r.items, 'customer_totals'));
    const sys = indexOf(r.items, 'pg_stat_activity');
    expect(sys).toBeGreaterThan(indexOf(r.items, 'customers'));
    expect(sys).toBeGreaterThan(indexOf(r.items, 'customer_orders'));
    expect(r.items.some((x) => x.kind === 'column')).toBe(false);
  });

  it('P3 SELECT * FROM sales.| → invoices only', () => {
    expect(labels(complete('pgsql', 'SELECT * FROM sales.|').items)).toEqual(['invoices']);
  });

  it('P4 invoices (sales not on search_path) → offered qualified', () => {
    const r = complete('pgsql', 'SELECT * FROM invoices|');
    const it = find(r.items, 'sales.invoices')!;
    expect(it).toBeTruthy();
    expect(it.insertText).toBe('sales.invoices');
  });

  it('P5 JOIN | → FK related tables and join snippets; sales.invoices not hoisted', () => {
    const r = complete('pgsql', 'SELECT * FROM customers c JOIN |');
    const top = labels(r.items, 4);
    expect(top).toEqual(expect.arrayContaining(['orders', 'orders o ON o.customer_id = c.id', 'countries co ON co.id = c.country_id']));
    expect(find(r.items, 'orders o ON o.customer_id = c.id')!.detail).toBe('orders_customer_id_fkey');
    expect(r.items.slice(0, 6).some((x) => x.label.startsWith('invoices') || x.label.startsWith('sales.invoices'))).toBe(false);
  });

  it('P6 cross-schema FK condition on top', () => {
    const r = complete('pgsql', 'SELECT * FROM orders o JOIN sales.invoices i ON |');
    expect(r.items[0].label).toBe('i.order_id = o.id');
  });

  it('P7 INSERT INTO customers (| → insertable columns; identity id only with a prefix', () => {
    const r = complete('pgsql', 'INSERT INTO customers (|');
    expect(r.items[0].insertText).toBe('name, email, country_id');
    expect(cols(r.items)).toEqual(['name', 'email', 'country_id']);
    expect(find(complete('pgsql', 'INSERT INTO customers (i|').items, 'id', (x) => x.kind === 'column')).toBeTruthy();
    const o = complete('pgsql', 'INSERT INTO orders (|');
    expect(cols(o.items)).toEqual(['id', 'customer_id', 'order_date', 'total', 'status']);
  });

  it('P8 RETURNING | → *, columns of the target', () => {
    const r = complete('pgsql', "INSERT INTO customers (name) VALUES ('x') RETURNING |");
    expect(find(r.items, '*')).toBeTruthy();
    expect(cols(r.items)).toEqual(['id', 'name', 'email', 'country_id']);
  });

  it('P9 ON CONFLICT (| → columns of the target; ON CONFLICT | → conflict keywords', () => {
    const r = complete('pgsql', "INSERT INTO customers (name) VALUES ('x') ON CONFLICT (|");
    expect(cols(r.items)).toEqual(['id', 'name', 'email', 'country_id']);
    const k = complete('pgsql', "INSERT INTO customers (name) VALUES ('x') ON CONFLICT |");
    expect(labels(k.items)).toEqual(expect.arrayContaining(['ON CONSTRAINT', 'DO NOTHING', 'DO UPDATE SET']));
    const a = complete('pgsql', "INSERT INTO customers (name) VALUES ('x') ON CONFLICT (id) |");
    expect(labels(a.items, 3)).toEqual(expect.arrayContaining(['DO NOTHING', 'DO UPDATE SET']));
  });

  it('P10 DO UPDATE SET | → columns of the target only', () => {
    const r = complete('pgsql', "INSERT INTO customers AS c (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET |");
    expect(r.items.every((x) => x.kind === 'column')).toBe(true);
    expect(cols(r.items)).toEqual(expect.arrayContaining(['name', 'email', 'country_id']));
  });

  it('P11 DO UPDATE SET name = | → EXCLUDED.name first, EXCLUDED.* items, c.name, functions', () => {
    const r = complete('pgsql', "INSERT INTO customers AS c (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = |");
    expect(r.items[0].label).toBe('EXCLUDED.name');
    expect(r.items[0].insertText).toBe('EXCLUDED.name');
    expect(r.items.filter((x) => x.label.startsWith('EXCLUDED.')).map((x) => x.label)).toEqual(expect.arrayContaining(['EXCLUDED.id', 'EXCLUDED.email', 'EXCLUDED.country_id']));
    expect(find(r.items, 'name', (x) => x.kind === 'column' && x.detail === 'c · customers')).toBeTruthy();
    expect(r.items.some((x) => x.kind === 'function')).toBe(true);
  });

  it('P12 EXCLUDED.| → exactly the target columns', () => {
    const r = complete('pgsql', "INSERT INTO customers AS c (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.|");
    expect(labels(r.items)).toEqual(['id', 'name', 'email', 'country_id']);
  });

  it('P13 UPDATE orders o SET | → columns of orders', () => {
    const r = complete('pgsql', 'UPDATE orders o SET |');
    expect(cols(r.items)).toEqual(['id', 'customer_id', 'order_date', 'total', 'status']);
  });

  it('P14 UPDATE … FROM customers c WHERE c.| → columns of customers', () => {
    expect(cols(complete('pgsql', 'UPDATE orders o SET total = 0 FROM customers c WHERE c.|').items)).toEqual(['id', 'name', 'email', 'country_id']);
  });

  it('P15 DELETE … USING customers c WHERE c.| → columns of customers; o is visible too', () => {
    expect(cols(complete('pgsql', 'DELETE FROM orders o USING customers c WHERE c.| ').items)).toEqual(['id', 'name', 'email', 'country_id']);
    const r = complete('pgsql', 'DELETE FROM orders o USING customers c WHERE |');
    expect(find(r.items, 'customer_id')).toBeTruthy();
    expect(find(r.items, 'email')).toBeTruthy();
  });

  it('P16 data-modifying CTE: columns from RETURNING *', () => {
    const r = complete('pgsql', 'WITH moved AS (DELETE FROM orders WHERE id = 1 RETURNING *) INSERT INTO sales.invoices SELECT | FROM moved');
    expect(labels(r.items, 5)).toEqual(['id', 'customer_id', 'order_date', 'total', 'status']);
    const r2 = complete('pgsql', 'WITH ins AS (INSERT INTO customers (name) VALUES (1) RETURNING id, name AS customer_name) SELECT i.| FROM ins i');
    expect(cols(r2.items)).toEqual(['id', 'customer_name']);
  });

  it('P17–P19 set-returning functions in FROM', () => {
    expect(cols(complete('pgsql', 'SELECT g.| FROM generate_series(1, 10) AS g(n)').items)).toEqual(['n']);
    expect(cols(complete('pgsql', 'SELECT u.| FROM unnest(ARRAY[1,2]) WITH ORDINALITY AS u(val, ord)').items)).toEqual(['val', 'ord']);
    expect(cols(complete('pgsql', "SELECT * FROM jsonb_to_recordset('[]') AS x(a int, b numeric(10, 2)) WHERE x.|").items)).toEqual(['a', 'b']);
    expect(cols(complete('pgsql', "SELECT e.| FROM jsonb_each('{}') e").items)).toEqual(['key', 'value']);
    expect(cols(complete('pgsql', 'SELECT g.| FROM generate_series(1, 3) g').items)).toEqual(['g']);
    expect(cols(complete('pgsql', 'SELECT u.| FROM unnest(ARRAY[1]) WITH ORDINALITY u').items)).toEqual(['u', 'ordinality']);
  });

  it('P20 LATERAL subquery columns', () => {
    const r = complete('pgsql', 'SELECT c.name, o.| FROM customers c, LATERAL (SELECT * FROM orders WHERE customer_id = c.id) o');
    expect(cols(r.items)).toEqual(['id', 'customer_id', 'order_date', 'total', 'status']);
  });

  it('P21 JOIN LATERAL table function columns', () => {
    const r = complete('pgsql', 'SELECT * FROM customers c CROSS JOIN LATERAL orders_of(c.id) AS oo WHERE oo.|');
    expect(cols(r.items)).toEqual(['id', 'order_date', 'total']);
  });

  it('P22 DISTINCT ON (|) → columns of the FROM source; the * projection stays intact', () => {
    const r = complete('pgsql', 'SELECT DISTINCT ON (|) * FROM orders');
    expect(cols(r.items)).toEqual(expect.arrayContaining(['id', 'customer_id', 'order_date', 'total', 'status']));
    const r2 = complete('pgsql', 'WITH x AS (SELECT DISTINCT ON (customer_id) * FROM orders) SELECT x.| FROM x');
    expect(cols(r2.items)).toEqual(['id', 'customer_id', 'order_date', 'total', 'status']);
  });

  it('P23 FILTER (WHERE |) → columns; after the clause the SELECT list continues', () => {
    const r = complete('pgsql', 'SELECT count(*) FILTER (WHERE |) FROM orders');
    expect(cols(r.items)).toEqual(expect.arrayContaining(['id', 'total', 'status']));
    expect(find(r.items, 'NOT')).toBeTruthy();
    const r2 = complete('pgsql', 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY |) FROM orders');
    expect(cols(r2.items)).toEqual(expect.arrayContaining(['total']));
  });
});

describe('PG completion: types, operators, functions, routines', () => {
  it('P24 expr::| → data types and catalog types', () => {
    const r = complete('pgsql', 'SELECT total::|');
    const ls = labels(r.items).map((x) => x.toLowerCase());
    expect(ls).toEqual(expect.arrayContaining(['numeric', 'integer', 'text', 'jsonb', 'uuid', 'order_status', 'email_address']));
    expect(r.items.every((x) => x.kind === 'type')).toBe(true);
    expect(find(r.items, 'order_status')!.detail).toBe('enum: new, paid, shipped, cancelled');
    expect(find(r.items, 'email_address')!.detail).toBe('domain over text');
    expect(r.items[0].commitCharacters).toEqual([' ', ')', ',']);
    const lower = complete('pgsql', 'SELECT total::|', { keywordCase: 'lower' });
    expect(find(lower.items, 'numeric')).toBeTruthy();
  });

  it('P25 CAST(x AS | and a schema qualifier after ::', () => {
    const r = complete('pgsql', "SELECT 'paid'::order_status, CAST(x AS |");
    expect(labels(r.items)).toEqual(expect.arrayContaining(['order_status', 'email_address']));
    expect(labels(r.items).map((x) => x.toLowerCase())).toContain('integer');
    const q = complete('pgsql', 'SELECT x::public.|');
    expect(labels(q.items).sort()).toEqual(['email_address', 'order_status']);
  });

  it('P26 inside a string after ->> → no suggestions', () => {
    expect(complete('pgsql', "SELECT meta->>'| FROM extra_types").items).toEqual([]);
    expect(complete('pgsql', 'SELECT $$ x | $$').items).toEqual([]);
  });

  it('P27 after a jsonb column → JSON operators with docs, keywords after expr', () => {
    const r = complete('pgsql', 'SELECT meta | FROM extra_types');
    const ops = r.items.filter((x) => x.kind === 'operator').map((x) => x.label);
    expect(ops).toEqual(expect.arrayContaining(['->', '->>', '@>', '?']));
    expect(find(r.items, '->>')!.documentation).toContain('text');
    expect(find(r.items, 'FROM')).toBeTruthy();
    expect(complete('pgsql', 'SELECT name | FROM customers').items.some((x) => x.label === '->>')).toBe(false);
  });

  it('P28 jsonb_| → jsonb functions with signatures; jsonb_each( → signature help', () => {
    const r = complete('pgsql', 'SELECT jsonb_|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['JSONB_BUILD_OBJECT', 'JSONB_AGG', 'JSONB_EACH', 'JSONB_SET']));
    expect(find(r.items, 'JSONB_SET')!.detail).toContain('target jsonb');
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT * FROM jsonb_each(|');
    expect(i.signatureHelp(d.uri, d.offset)!.signatures[0].label).toBe('jsonb_each(obj jsonb) → setof record(key text, value jsonb)');
  });

  it('P29 fn_tax( → two overloads', () => {
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT fn_tax(|');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures.map((s) => s.label)).toEqual(['fn_tax(amount numeric) → numeric', 'fn_tax(amount numeric, rate numeric) → numeric']);
    const d2 = doc(i, 'SELECT fn_tax(1, |');
    expect(i.signatureHelp(d2.uri, d2.offset)!.activeSignature).toBe(1);
    expect(complete('pgsql', 'SELECT fn_|').items.filter((x) => x.label === 'fn_tax')).toHaveLength(1);
  });

  it('P30 CALL | → procedures; CALL add_order_line( → signature with INOUT; named arguments', () => {
    const r = complete('pgsql', 'CALL |');
    expect(labels(r.items, 2).sort()).toEqual(['add_order_line', 'get_customer_report']);
    const i = intelFor('pgsql');
    const d = doc(i, 'CALL add_order_line(|');
    const sh = i.signatureHelp(d.uri, d.offset)!;
    expect(sh.signatures[0].label).toBe('add_order_line(p_order integer, p_product integer, p_qty integer, INOUT inserted integer)');
    const c2 = i.complete(d.uri, d.offset);
    expect(find(c2.items, 'p_order =>')).toBeTruthy();
    expect(c2.items.some((x) => x.label.endsWith(' = '))).toBe(false);
  });

  it('P31 "Customers" does not resolve; CUSTOMERS folds to lower case', () => {
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT * FROM "Customers"');
    expect(i.softDiagnostics(d.uri).find((x) => x.code === 'unknown-table')?.message).toBe("Unknown table 'Customers'");
    const d2 = doc(i, 'SELECT * FROM CUSTOMERS');
    expect(i.softDiagnostics(d2.uri).some((x) => x.code === 'unknown-table')).toBe(false);
    expect(cols(complete('pgsql', 'SELECT * FROM CUSTOMERS C WHERE C.|').items)).toEqual(['id', 'name', 'email', 'country_id']);
    expect(cols(complete('pgsql', 'SELECT * FROM "MixedCase" m WHERE m.|').items)).toEqual(['Value', 'id']);
    expect(find(complete('pgsql', 'SELECT * FROM Mix|').items, 'MixedCase')!.insertText).toBe('"MixedCase"');
    expect(find(complete('pgsql', 'SELECT m.| FROM "MixedCase" m').items, 'Value')!.insertText).toBe('"Value"');
  });

  it('P32 pg_catalog views and their columns', () => {
    const r = complete('pgsql', 'SELECT * FROM pg_catalog.|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['pg_class', 'pg_stat_activity', 'pg_tables']));
    const r2 = complete('pgsql', 'SELECT * FROM pg_stat_|');
    expect(labels(r2.items)).toEqual(expect.arrayContaining(['pg_stat_activity', 'pg_stat_user_tables']));
    const r3 = complete('pgsql', 'SELECT s.| FROM pg_stat_activity s');
    expect(cols(r3.items)).toEqual(expect.arrayContaining(['pid', 'datname', 'state', 'query']));
  });

  it('P33 information_schema.tables columns', () => {
    const r = complete('pgsql', 'SELECT * FROM information_schema.tables t WHERE t.|');
    expect(cols(r.items).slice(0, 4)).toEqual(['table_catalog', 'table_schema', 'table_name', 'table_type']);
  });

  it('P34 statementParams: $n, :name, @name; ? is an operator', () => {
    const i = intelFor('pgsql');
    const d = doc(i, "SELECT $1, :id, @p FROM orders WHERE id = $2 AND meta ? 'k' AND x = $1 AND y::text = :id");
    const toks = i.tokens(d.uri);
    expect(statementParams(toks, 0, toks.length, 'pgsql')).toEqual(['$1', ':id', '@p', '$2']);
    const f = doc(i, "CREATE FUNCTION f(int) RETURNS int LANGUAGE sql AS 'SELECT $1'");
    const ft = i.tokens(f.uri);
    expect(statementParams(ft, 0, ft.length, 'pgsql')).toEqual([]);
  });
});

describe('PG lexer, splitter, classify', () => {
  it('P35 splitting: function and DO bodies are opaque; psql meta-commands are skipped', () => {
    const i = intelFor('pgsql');
    const d = doc(i, "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1; RETURN 1;\nEND\n$$;\nDO $x$ BEGIN RAISE NOTICE 'a;b'; END $x$;\nSELECT 1;\n\\dt\nSELECT 2;");
    const sts = i.statements(d.uri);
    expect(sts.map((s) => s.kind)).toEqual(['create', 'block', 'select', 'psql', 'select']);
    expect(sts[0].text.endsWith('$$')).toBe(true);
    expect(sts[3].text).toBe('\\dt');
    expect(sts[3].skipOnRun).toBe(true);
    expect(i.batchesFor(d.uri).map((b) => b.sql)).toEqual([sts[0].text, sts[1].text, 'SELECT 1', 'SELECT 2']);
    const w = i.softDiagnostics(d.uri).find((x) => x.code === 'psql')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('skipped on run');
  });

  it('splitting: blank lines do not split, single-quoted bodies, BEGIN ATOMIC, CASE … END', () => {
    const i = intelFor('pgsql');
    const d = doc(i, "SELECT 1\n\nFROM t;\nCREATE FUNCTION g() RETURNS int AS 'select 1; select 2' LANGUAGE sql;\nCREATE FUNCTION h() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN 2 END; END;\nSELECT 3");
    expect(i.statements(d.uri).map((s) => s.text.split(' ')[0] + ':' + s.text.length)).toHaveLength(4);
    expect(i.statements(d.uri)[2].text.endsWith('END')).toBe(true);
  });

  it('P36 lexer: PostgreSQL literals, comments and operators', () => {
    expect(kinds("E'it''s\\n'")).toEqual(["string:E'it''s\\n'"]);
    expect(kinds("E'a\\'b' x")).toEqual(["string:E'a\\'b'", 'ident:x']);
    expect(kinds("U&'d\\0061t'")).toEqual(["string:U&'d\\0061t'"]);
    expect(kinds("B'101' X'1F' N'n'")).toEqual(["string:B'101'", "string:X'1F'", "string:N'n'"]);
    expect(kinds('$tag$ ... $$ ... $tag$ x')).toEqual(['string:$tag$ ... $$ ... $tag$', 'ident:x']);
    expect(kinds('$$a;b$$;')).toEqual(['string:$$a;b$$', 'punct:;']);
    expect(kinds('/* a /* b */ c */ x')).toEqual(['comment:/* a /* b */ c */', 'ident:x']);
    expect(kinds('arr[1:3]')).toEqual(['ident:arr', 'op:[', 'number:1', 'op::', 'number:3', 'op:]']);
    expect(kinds('a::text')).toEqual(['ident:a', 'op:::', 'ident:text']);
    expect(kinds("x @> '{}'")).toEqual(['ident:x', 'op:@>', "string:'{}'"]);
    expect(kinds('1_000 0x1F 0o17 0b101 1.5e3')).toEqual(['number:1_000', 'number:0x1F', 'number:0o17', 'number:0b101', 'number:1.5e3']);
    expect(kinds('$1 :name @p ?')).toEqual(['param:$1', 'param::name', 'param:@p', 'op:?']);
    expect(kinds("d->>'a' #>> '{a}' j ?| k !~* 'x' |/ 4 @@ q")).toEqual(['ident:d', 'op:->>', "string:'a'", 'op:#>>', "string:'{a}'", 'ident:j', 'op:?|', 'ident:k', 'op:!~*', "string:'x'", 'op:|/', 'number:4', 'op:@@', 'ident:q']);
    expect(kinds("'a' ||/* c */ 'b'")).toEqual(["string:'a'", 'op:||', 'comment:/* c */', "string:'b'"]);
    expect(kinds('U&"d\\0061t" [x]')).toEqual(['quotedIdent:U&"d\\0061t"', 'op:[', 'ident:x', 'op:]']);
    expect(kinds('\\c shop\nSELECT 1')).toEqual(['meta:\\c shop', 'keyword:SELECT', 'number:1']);
    expect(kinds('SELECT 1 \\g')).toEqual(['keyword:SELECT', 'number:1', 'op:\\', 'ident:g']);
  });

  it('lexer line mode resumes inside $$ bodies, $tag$ bodies, E-strings and nested comments', async () => {
    const { lexLine } = await import('../lexer/lexer');
    let r = lexLine('AS $$', pg, '');
    expect(r.endState).toBe('d');
    r = lexLine("  SELECT 'x;';", pg, r.endState);
    expect(r.endState).toBe('d');
    expect(r.tokens).toHaveLength(1);
    r = lexLine('$$ LANGUAGE sql;', pg, r.endState);
    expect(r.endState).toBe('');
    expect(r.tokens.map((t) => t.kind)).toEqual(['string', 'ident', 'ident', 'punct']);
    r = lexLine('DO $body$', pg, '');
    expect(r.endState).toBe('dbody');
    r = lexLine('$$ inner $$', pg, r.endState);
    expect(r.endState).toBe('dbody');
    r = lexLine("$body$;", pg, r.endState);
    expect(r.endState).toBe('');
    r = lexLine("SELECT E'a\\'", pg, '');
    expect(r.endState).toBe('e');
    r = lexLine("b'", pg, r.endState);
    expect(r.endState).toBe('');
    r = lexLine('/* a /* b */', pg, '');
    expect(r.endState).toBe('c1');
    r = lexLine('c */ x', pg, r.endState);
    expect(r.endState).toBe('');
  });

  it('relex around a $$ edit matches a full re-lex', async () => {
    const { relex } = await import('../lexer/lexer');
    const before = 'SELECT 1;\nDO $$\nBEGIN\n  NULL;\nEND\n$$;\nSELECT 2;';
    const prev = tokenize(before, pg);
    const at = before.indexOf('NULL');
    const change = { rangeOffset: at, rangeLength: 4, text: "RAISE NOTICE '$x$';" };
    const after = before.slice(0, at) + change.text + before.slice(at + 4);
    const inc = relex(prev, after, change, pg);
    expect(inc.map((t) => [t.kind, t.text, t.start, t.line])).toEqual(tokenize(after, pg).map((t) => [t.kind, t.text, t.start, t.line]));
    // deleting the closing $$ turns the rest into the body
    const cut = after.lastIndexOf('$$;');
    const ch2 = { rangeOffset: cut, rangeLength: 2, text: '' };
    const after2 = after.slice(0, cut) + after.slice(cut + 2);
    expect(relex(inc, after2, ch2, pg).map((t) => [t.kind, t.text])).toEqual(tokenize(after2, pg).map((t) => [t.kind, t.text]));
  });

  it('P41 classify', () => {
    const i = intelFor('pgsql');
    expect(i.classify('TRUNCATE orders')).toBe('truncate:destructive');
    expect(i.classify('BEGIN')).toBe('tx');
    expect(i.classify('START TRANSACTION')).toBe('tx');
    expect(i.classify('END')).toBe('tx');
    expect(i.classify('DO $$ BEGIN END $$')).toBe('block');
    expect(i.classify('TABLE orders')).toBe('select');
    expect(i.classify('CALL add_order_line(1, 2, 3, null)')).toBe('exec');
    expect(i.classify('COPY orders TO STDOUT')).toBe('other');
    expect(i.classify('\\dt')).toBe('psql');
    expect(i.classify('WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d')).toBe('select');
  });
});

describe('PG diagnostics, hover, definition', () => {
  it('P37 unknown column through a resolved alias', () => {
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT c.nmae FROM customers c');
    const w = i.softDiagnostics(d.uri).find((x) => x.code === 'unknown-column')!;
    expect(w.message).toBe("Column 'nmae' not found in public.customers");
    const q = doc(i, 'SELECT c."Name", c.ctid, c.xmin FROM customers c');
    expect(i.softDiagnostics(q.uri).filter((x) => x.code === 'unknown-column').map((x) => x.message)).toEqual(["Column 'Name' not found in public.customers"]);
    const ex = doc(i, 'INSERT INTO customers (id, name) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.nam');
    expect(i.softDiagnostics(ex.uri).find((x) => x.code === 'unknown-column')?.message).toBe("Column 'nam' not found in EXCLUDED");
  });

  it('P38 unknown table honours search_path and lazy schema loading', () => {
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT * FROM nope');
    expect(i.softDiagnostics(d.uri).find((x) => x.code === 'unknown-table')?.message).toBe("Unknown table 'nope'");
    const asked: string[] = [];
    const j = withSnapshot((s) => ({ ...s, searchPath: ['app', 'public'] }));
    j.setSchemaRequester((n) => asked.push(n));
    j.setDocument('u', 'SELECT * FROM nope');
    expect(j.softDiagnostics('u').some((x) => x.code === 'unknown-table')).toBe(false);
    expect(asked).toContain('app');
  });

  it('cast to an unknown type is an info; known and catalog types are not', () => {
    const i = intelFor('pgsql');
    const d = doc(i, "SELECT 1::int, 'a'::text, '{}'::jsonb, 'x'::order_status, 'n'::name, x::regclass, 1::bogus_type FROM orders");
    const infos = i.softDiagnostics(d.uri).filter((x) => x.code === 'unknown-type');
    expect(infos.map((x) => x.message)).toEqual(["'::' cast to unknown type 'bogus_type'"]);
    expect(infos[0].severity).toBe('info');
  });

  it('P39 hover: enum and domain types, search_path schema', () => {
    const i = intelFor('pgsql');
    const d = doc(i, "SELECT 'paid'::order_st|atus");
    expect(i.hover(d.uri, d.offset)!.markdown).toContain('type `public.order_status` (enum): new, paid, shipped, cancelled');
    const d2 = doc(i, "SELECT 'a@b'::email_addr|ess");
    expect(i.hover(d2.uri, d2.offset)!.markdown).toContain('type `public.email_address` (domain over text)');
    const d3 = doc(i, 'SELECT * FROM pub|lic.customers');
    expect(i.hover(d3.uri, d3.offset)!.markdown).toContain('on search_path (#1)');
    const d4 = doc(i, 'SELECT * FROM orders_o|f(1)');
    expect(i.hover(d4.uri, d4.offset)!.markdown).toContain('| order_date | date |');
  });

  it('P40 F12 on a materialized view', () => {
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT * FROM customer_tot|als');
    expect(i.definition(d.uri, d.offset)).toEqual({ kind: 'object', ref: { database: 'shop', schema: 'public', name: 'customer_totals', type: 'mview' } });
    const sys = doc(i, 'SELECT * FROM pg_cl|ass');
    expect(i.definition(sys.uri, sys.offset)).toBeNull();
  });
});

describe('PG case folding, quoting, catalog data', () => {
  it("caseFolding 'lower': keyOf / keyOfCatalog / needsQuoting", () => {
    const idx = new CatalogIndex(pg);
    expect(idx.keyOf('Customers', false)).toBe('customers');
    expect(idx.keyOf('Customers', true)).toBe('Customers');
    expect(idx.keyOfCatalog('MixedCase')).toBe('MixedCase');
    expect(foldName('ABC', false, 'lower')).toBe('abc');
    expect(foldName('ABC', false, 'upper')).toBe('ABC');
    expect(foldName('abc', true, 'insensitive')).toBe('ABC');
    expect(needsQuoting('customers', pg)).toBe(false);
    expect(needsQuoting('MixedCase', pg)).toBe(true);
    expect(needsQuoting('order', pg)).toBe(true);
    expect(needsQuoting('my table', pg)).toBe(true);
    expect(needsQuoting('größe', pg)).toBe(false);
    expect(needsQuoting('a$b', pg)).toBe(false);
  });

  it('function catalog: ≥ 300 entries, signatures and docs, SRFs are table functions, no duplicates', () => {
    const fns: FunctionDef[] = pg.functions;
    expect(fns.length).toBeGreaterThanOrEqual(300);
    const cats = new Set(['string', 'math', 'aggregate', 'window', 'datetime', 'json', 'array', 'conversion', 'system', 'range', 'network', 'textsearch', 'xml', 'misc']);
    const names = new Set<string>();
    for (const f of fns) {
      expect(names.has(f.name), f.name).toBe(false);
      names.add(f.name);
      expect(cats.has(f.category), f.name).toBe(true);
      expect(f.signatures.length, f.name).toBeGreaterThanOrEqual(1);
      expect(f.doc.length, f.name).toBeGreaterThan(5);
      expect(['scalar', 'aggregate', 'window', 'table', 'niladic']).toContain(f.kind);
    }
    for (const n of ['generate_series', 'unnest', 'jsonb_each', 'jsonb_array_elements', 'regexp_split_to_table', 'json_to_recordset']) expect(pg.functionMap.get(n.toUpperCase())!.kind).toBe('table');
    for (const op of ['->', '->>', '#>', '#>>', '@>', '<@', '?', '?|', '?&', '||', '#-', '::', '~*', '@@', '&&']) expect(pg.operators.some((o) => o.op === op), op).toBe(true);
  });

  it('operator hover', () => {
    const i = intelFor('pgsql');
    const d = doc(i, "SELECT meta -|>> 'a' FROM extra_types");
    expect(i.hover(d.uri, d.offset)!.markdown).toContain('->>');
  });

  it('P42 perf: 5,000 tables × 20 columns, completion p95 < 5 ms', () => {
    const objects = [];
    for (let t = 0; t < 5000; t++) {
      const c = [];
      for (let k = 0; k < 20; k++) c.push([k === 0 ? 'id' : `col${k}_${t % 50}`, 'integer', 1, k === 0 ? 1 : 0, 0, null]);
      objects.push({ t: 'table', n: `table${t}`, c, pk: ['id'], fk: t > 0 ? [{ n: `fk_${t}`, cols: ['col1_' + (t % 50)], rs: 'public', rt: `table${t - 1}`, rcols: ['id'] }] : [] });
    }
    objects.push({ t: 'table', n: 'customers', c: fixtures.pgsql.schemas[0].objects[1].c, pk: ['id'] });
    const snap = { connectionId: 'perf', dialect: 'pgsql', database: 'big', defaultSchema: 'public', searchPath: ['public'], version: 1, databases: [], schemas: [{ name: 'public', version: 1, objects }] } as unknown as CatalogSnapshot;
    const intel = createIntel('pgsql');
    intel.setCatalog(fixtures.pgsql);
    const t0 = performance.now();
    intel.setCatalog(snap);
    const build = performance.now() - t0;
    const lines: string[] = [];
    for (let k = 0; k < 290; k++) lines.push(k % 10 === 0 ? `SELECT t.id, t.col1_${k % 50} FROM table${k} t WHERE t.id = ${k}::int;` : `  -- filler line ${k} with some text`);
    lines.push('SELECT c.name', 'FROM customers c', 'JOIN table1 t1 ON t1.id = c.id', 'WHERE c.');
    for (let k = 0; k < 6; k++) lines.push(`-- tail ${k}`);
    const text = lines.join('\n');
    const offset = text.indexOf('WHERE c.') + 'WHERE c.'.length;
    intel.setDocument('perf://1', text);
    for (let k = 0; k < 20; k++) intel.complete('perf://1', offset);
    const times: number[] = [];
    for (let k = 0; k < 200; k++) {
      intel.applyEdit('perf://1', { rangeOffset: offset, rangeLength: 0, text: 'n' });
      const a = performance.now();
      const r = intel.complete('perf://1', offset + 1);
      times.push(performance.now() - a);
      expect(r.items[0].label).toBe('name');
      intel.applyEdit('perf://1', { rangeOffset: offset, rangeLength: 1, text: '' });
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(build).toBeLessThan(150);
    expect(p95).toBeLessThan(5);
  });
});

describe('PG all-dialect cases (#45–#48)', () => {
  it('#45–#48 for pgsql', () => {
    const i = intelFor('pgsql');
    const d = doc(i, 'SELECT c.Nmae FROM Customers c');
    const w = i.softDiagnostics(d.uri).find((x) => x.code === 'unknown-column')!;
    expect(w.message).toBe("Column 'Nmae' not found in public.customers");
    expect(w.col).toBe(10);
    const del = doc(i, 'DELETE FROM Orders');
    expect(i.softDiagnostics(del.uri).some((x) => x.code === 'no-where')).toBe(true);
    const h = doc(i, 'SELECT * FROM Customers c|');
    expect(stripMd(i.hover(h.uri, h.offset - 1)!.markdown)).toContain('alias c → public.customers (table), 4 columns');
    const f = doc(i, 'SELECT c.Name FROM Customers c');
    expect(i.definition(f.uri, f.text.indexOf('Customers') + 2)).toEqual({ kind: 'object', ref: { database: 'shop', schema: 'public', name: 'customers', type: 'table' } });
  });
});

// plan-batch3 WP-SF: the Snowflake dialect (lazy chunk): VARIANT paths vs binds, $$ bodies, scripting blocks, statement
// kinds, upper-case folding, functions and system schemas, formatter rules.
import { beforeAll, describe, expect, it } from 'vitest';
import { getSpec } from '../dialect';
import { ensureDialect } from '../dialect/registry';
import { tokenize } from '../lexer/lexer';
import { createIntel } from '../index';
import { rulesFor } from '../../format/layout';
import { formatSql } from '../../format';

const kinds = (s: string) => tokenize(s, getSpec('snowflake')).filter((t) => t.kind !== 'eof' && t.kind !== 'ws').map((t) => `${t.kind}:${t.text}`);

beforeAll(async () => {
  await ensureDialect('snowflake');
});

describe('Snowflake lexer', () => {
  it('a colon after a value is the VARIANT path operator, not a bind', () => {
    expect(kinds('SELECT v:customer.name, t.v:items[0]::STRING FROM t WHERE id = :id AND x = ?')).toEqual([
      'keyword:SELECT', 'ident:v', 'op::', 'ident:customer', 'punct:.', 'ident:name', 'punct:,', 'ident:t', 'punct:.', 'ident:v', 'op::',
      'ident:items', 'op:[', 'number:0', 'op:]', 'op:::', 'ident:STRING', 'keyword:FROM', 'ident:t', 'keyword:WHERE', 'ident:id', 'op:=',
      'param::id', 'keyword:AND', 'ident:x', 'op:=', 'param:?',
    ]);
  });

  it('staged-file columns with a path are identifiers; $$ bodies and backslash escapes are strings', () => {
    expect(kinds('SELECT $1:sku FROM @stage')).toEqual(['keyword:SELECT', 'ident:$1', 'op::', 'ident:sku', 'keyword:FROM', 'op:@', 'ident:stage']);
    expect(kinds("SELECT 'it\\'s', $$a;b$$")).toEqual(['keyword:SELECT', "string:'it\\'s'", 'punct:,', 'string:$$a;b$$']);
  });

  it('folds unquoted names to upper case', () => {
    const spec = getSpec('snowflake');
    expect(spec.caseFolding).toBe('upper');
    expect(spec.fold('orders', false)).toBe('ORDERS');
    expect(spec.fold('Orders', true)).toBe('Orders');
  });

  it('knows its functions and system schemas', () => {
    const spec = getSpec('snowflake');
    expect(spec.functionMap.get('FLATTEN')?.kind).toBe('table');
    expect(spec.functionMap.get('IFF')?.signatures[0].params).toHaveLength(3);
    expect(spec.functionMap.get('ROUND')?.signatures.length).toBeGreaterThanOrEqual(2); // optional params expand
    expect(spec.systemCatalog?.schemas.map((s) => s.name)).toEqual(['INFORMATION_SCHEMA', 'ACCOUNT_USAGE']);
    expect(spec.dataTypeSet.has('VARIANT')).toBe(true);
    expect(spec.keywords.has('QUALIFY')).toBe(true);
  });
});

describe('Snowflake splitter and kinds', () => {
  it('keeps scripting blocks whole and ends plain statements at semicolons', () => {
    const i = createIntel('snowflake');
    i.setDocument('sf://1', [
      'BEGIN TRANSACTION;',
      'DECLARE',
      '  c1 CURSOR FOR SELECT ID FROM ORDERS;',
      '  n NUMBER DEFAULT 0;',
      'BEGIN',
      '  FOR r IN c1 DO',
      '    IF (r.ID > 2) THEN n := n + 1; END IF;',
      '  END FOR;',
      '  CREATE TABLE IF NOT EXISTS T (ID INT);',
      '  RETURN n;',
      'END;',
      'SELECT CASE WHEN a THEN 1 END FROM t;',
      'CREATE OR REPLACE PROCEDURE p() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$;',
      'COMMIT',
    ].join('\n'));
    const st = i.statements('sf://1');
    expect(st.map((s) => s.text.split('\n')[0])).toEqual([
      'BEGIN TRANSACTION', 'DECLARE', 'SELECT CASE WHEN a THEN 1 END FROM t', 'CREATE OR REPLACE PROCEDURE p() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$', 'COMMIT',
    ]);
    expect(st[1].text.endsWith('END')).toBe(true);
  });

  it('classifies Snowflake statement heads', () => {
    const i = createIntel('snowflake');
    expect(i.classify('SHOW WAREHOUSES')).toBe('select');
    expect(i.classify('LIST @stage')).toBe('select');
    expect(i.classify('PUT file:///tmp/a.csv @~')).toBe('insert');
    expect(i.classify('REMOVE @stage/old')).toBe('delete:destructive');
    expect(i.classify('BEGIN')).toBe('tx');
    expect(i.classify('BEGIN SELECT 1; END')).toBe('block');
    expect(i.classify('ALTER SESSION SET QUERY_TAG = 1')).toBe('set');
    expect(i.classify('EXECUTE IMMEDIATE $$ SELECT 1 $$')).toBe('block');
    expect(i.classify('DROP TABLE t')).toBe('drop:destructive');
  });

  it('runs a script as one batch per statement', () => {
    const i = createIntel('snowflake');
    i.setDocument('sf://2', 'USE WAREHOUSE COMPUTE_WH;\nBEGIN\n  SELECT 1;\nEND;\nSELECT 2');
    expect(i.batchesFor('sf://2').map((b) => [b.sql.split('\n')[0], b.line])).toEqual([['USE WAREHOUSE COMPUTE_WH', 1], ['BEGIN', 2], ['SELECT 2', 5]]);
  });
});

describe('Snowflake formatter', () => {
  it('has its own rules', () => {
    const r = rulesFor(getSpec('snowflake'));
    expect(r.dialect).toBe('snowflake');
    expect(r.functionKeywords.has('FLATTEN')).toBe(true);
    expect(r.conditionClauses.has('QUALIFY')).toBe(true);
    expect(r.statementStarts.has('UNDROP')).toBe(true);
  });

  it('formats a VARIANT / FLATTEN query keeping every token (paths, casts, binds)', () => {
    const input = 'select c.name, f.value:sku::string as sku from customers c, lateral flatten(input => c.profile:orders) f where c.id = :id';
    const out = formatSql(input, 'snowflake').text;
    const norm = (s: string) => kinds(s).map((k) => k.toUpperCase());
    expect(norm(out)).toEqual(norm(input));
    expect(out).toMatch(/FLATTEN\(input => c\.profile: ?orders\)/i);
    // TODO(WPSF-shared): R3-4 (format/layout.ts) writes the path colon without a space: f.value:sku.
  });
});

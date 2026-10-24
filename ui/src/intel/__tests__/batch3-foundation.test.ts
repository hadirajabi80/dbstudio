// plan-batch3 WP0: lazy dialect registry (D7) and the data-driven lexer traits (D8). The Batch 3 dialect files are WP-owned
// stubs; these tests pin the shared mechanics only (each WP adds its own <dialect>*.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { getSpec } from '../dialect';
import { ensureDialect, isDialectReady, isLazyDialect } from '../dialect/registry';
import { tokenize } from '../lexer/lexer';
import { createIntel } from '../index';
import { rulesFor } from '../../format/layout';
import type { Dialect } from '../types';

const LAZY: Dialect[] = ['mysql', 'clickhouse', 'snowflake', 'cql'];
const kinds = (d: Dialect, s: string) => tokenize(s, getSpec(d)).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.text}`);

describe('dialect registry (D7)', () => {
  it('serves a generic spec under the real id until the chunk is loaded', async () => {
    expect(isLazyDialect('mysql')).toBe(true);
    expect(isLazyDialect('tsql')).toBe(false);
    expect(isDialectReady('tsql')).toBe(true);
    expect(isDialectReady('mysql')).toBe(false);
    const before = getSpec('mysql');
    expect(before.id).toBe('mysql');
    expect(before.lex).toBeUndefined();
    const spec = await ensureDialect('mysql');
    expect(spec?.id).toBe('mysql');
    expect(isDialectReady('mysql')).toBe(true);
    expect(getSpec('mysql')).toBe(spec);
    expect(getSpec('mysql').lex?.backtickIdent).toBe(true);
    expect(await ensureDialect('tsql')).toBeNull();
  });

  it('loads every Batch 3 dialect once (concurrent calls share the load)', async () => {
    const [a, b] = await Promise.all([ensureDialect('cql'), ensureDialect('cql')]);
    expect(a).toBe(b);
    for (const d of LAZY) expect((await ensureDialect(d))?.id).toBe(d);
  });
});

describe('lexer traits (D8)', () => {
  beforeAll(async () => {
    for (const d of LAZY) await ensureDialect(d);
  });

  it('MySQL: # comments, backticks, backslash escapes, @vars and ? placeholders', () => {
    expect(kinds('mysql', "SELECT `a b`, 'it\\'s' # note\nFROM t WHERE x = @v AND y = ?")).toEqual([
      'keyword:SELECT', 'quotedIdent:`a b`', 'punct:,', "string:'it\\'s'", 'comment:# note', 'keyword:FROM', 'ident:t',
      'keyword:WHERE', 'ident:x', 'op:=', 'param:@v', 'keyword:AND', 'ident:y', 'op:=', 'param:?',
    ]);
    expect(kinds('mysql', 'a <=> b')).toEqual(['ident:a', 'op:<=>', 'ident:b']);
  });

  it('original dialects keep their rules (T-SQL #temp, PostgreSQL standard strings)', () => {
    expect(kinds('tsql', 'SELECT * FROM #t')).toEqual(['keyword:SELECT', 'op:*', 'keyword:FROM', 'ident:#t']);
    expect(kinds('pgsql', "SELECT 'a\\'")).toEqual(['keyword:SELECT', "string:'a\\'"]);
  });

  it('Snowflake: $$ bodies, $1 as a staged column (not a bind), :name but not the :: cast', () => {
    expect(kinds('snowflake', 'SELECT $1, x::int, :p, $$a;b$$')).toEqual([
      'keyword:SELECT', 'ident:$1', 'punct:,', 'ident:x', 'op:::', 'ident:int', 'punct:,', 'param::p', 'punct:,', 'string:$$a;b$$',
    ]);
  });

  it('ClickHouse: {name:Type} parameters', () => {
    expect(kinds('clickhouse', 'SELECT * FROM t WHERE id = {id:UInt32}')).toContain('param:{id:UInt32}');
  });
});

describe('splitter and formatter defaults', () => {
  beforeAll(async () => {
    for (const d of LAZY) await ensureDialect(d);
  });

  it.each(LAZY)('%s: statements end at semicolons', (d) => {
    const i = createIntel(d);
    i.setDocument('b3://1', 'SELECT 1;\n\nSELECT (CASE WHEN a THEN 1 END);SELECT 3');
    expect(i.statements('b3://1').map((s) => s.text)).toEqual(['SELECT 1', 'SELECT (CASE WHEN a THEN 1 END)', 'SELECT 3']);
  });

  it.each(LAZY)('%s: formatter rules resolve', (d) => {
    expect(rulesFor(getSpec(d)).dialect).toBe(d);
  });
});

// PostgreSQL rules of the shared SQL helpers: identifier quoting (lower-case folding + reserved words), copy-as-INSERT
// literals, and the destructive-statement guard over dollar quotes, E'' strings and nested comments.
import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../api/types';
import { findDestructive } from './classify';
import { serializeRows, sqlLiteral } from './serialize';
import { needsQuoting, qualifiedName, quoteIdent, selectTopSql } from './sql';

const col = (name: string, kind: ColumnKind): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'orders', schema: 'public', isKey: false,
});
const b = (sql: string) => [{ sql, line: 1, col: 1 }];

describe('pgsql identifiers', () => {
  it('lower-case names stay bare; anything else is quoted', () => {
    expect(needsQuoting('order_lines', 'pgsql')).toBe(false);
    expect(needsQuoting('a$b', 'pgsql')).toBe(false);
    expect(quoteIdent('OrderLines', 'pgsql')).toBe('"OrderLines"');
    expect(quoteIdent('ORDERS', 'pgsql')).toBe('"ORDERS"');
    expect(quoteIdent('1st', 'pgsql')).toBe('"1st"');
    expect(quoteIdent('my col', 'pgsql')).toBe('"my col"');
    expect(quoteIdent('a"b', 'pgsql')).toBe('"a""b"');
  });

  it('reserved words are quoted, non-reserved key words are not', () => {
    for (const w of ['user', 'order', 'table', 'select', 'limit', 'offset', 'returning', 'analyze']) expect(quoteIdent(w, 'pgsql'), w).toBe(`"${w}"`);
    for (const w of ['name', 'status', 'type', 'key', 'level', 'date', 'text', 'value']) expect(quoteIdent(w, 'pgsql'), w).toBe(w);
  });

  it('qualified names and SELECT … LIMIT', () => {
    expect(qualifiedName({ schema: 'public', name: 'orders' }, 'pgsql', { defaultSchema: 'public' })).toBe('orders');
    expect(qualifiedName({ schema: 'Sales', name: 'orders' }, 'pgsql', { defaultSchema: 'public' })).toBe('"Sales".orders');
    expect(selectTopSql({ database: null, schema: 'sales', name: 'invoices', type: 'table' }, 'pgsql', 100, 'public')).toBe('SELECT *\nFROM sales.invoices\nLIMIT 100;');
  });
});

describe('pgsql literals (copy as INSERT)', () => {
  it('booleans as TRUE / FALSE, bytea as hex, strings plain', () => {
    expect(sqlLiteral(true, col('paid', 'bool'), 'pgsql')).toBe('TRUE');
    expect(sqlLiteral(false, col('paid', 'bool'), 'pgsql')).toBe('FALSE');
    expect(sqlLiteral({ $bin: 'AQID', len: 3 }, col('pdf', 'binary'), 'pgsql')).toBe("'\\x010203'::bytea");
    expect(sqlLiteral('Grüße', col('name', 'string'), 'pgsql')).toBe("'Grüße'");
    expect(sqlLiteral('2025-01-02T03:04:05', col('at', 'datetime'), 'pgsql')).toBe("'2025-01-02T03:04:05'");
    expect(sqlLiteral('12.50', col('total', 'decimal'), 'pgsql')).toBe('12.50');
  });

  it('INSERT statements quote mixed-case columns', () => {
    const rows: CellValue[][] = [[1, true]];
    expect(serializeRows('sql-insert', [col('Id', 'int'), col('paid', 'bool')], rows, { dialect: 'pgsql', tableName: 'public.orders' }))
      .toBe('INSERT INTO public.orders ("Id", paid) VALUES (1, TRUE);');
  });
});

describe('pgsql destructive guard', () => {
  it('flags DELETE / UPDATE without WHERE, DROP, TRUNCATE', () => {
    expect(findDestructive(b('DELETE FROM orders'), 'pgsql')[0]).toMatchObject({ kind: 'DELETE', description: 'DELETE without WHERE on orders' });
    expect(findDestructive(b('UPDATE public.orders SET total = 0'), 'pgsql')[0].description).toBe('UPDATE without WHERE on public.orders');
    expect(findDestructive(b('TRUNCATE orders RESTART IDENTITY'), 'pgsql')[0].kind).toBe('TRUNCATE');
    expect(findDestructive(b('DROP TABLE IF EXISTS orders'), 'pgsql')[0].kind).toBe('DROP');
  });

  it('dollar-quoted bodies and E strings never trigger', () => {
    const safe = [
      "SELECT $$DELETE FROM orders$$",
      "SELECT $body$ DROP TABLE x; $body$",
      "SELECT E'it\\'s DELETE FROM orders'",
      'CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM orders $$',
      '/* outer /* DELETE FROM orders */ still comment */ SELECT 1',
      'SELECT arr[1] FROM t WHERE x = 1',
    ];
    for (const s of safe) expect(findDestructive(b(s), 'pgsql'), s).toEqual([]);
  });

  it('a DO block body is a string', () => {
    expect(findDestructive(b('DO $$ BEGIN DELETE FROM orders; END $$;'), 'pgsql')).toEqual([]);
  });

  it('statements after a dollar-quoted string are still checked, with the right line', () => {
    const f = findDestructive(b("SELECT $$a\nb$$;\nDELETE FROM orders"), 'pgsql');
    expect(f).toMatchObject([{ kind: 'DELETE', line: 3 }]);
  });
});

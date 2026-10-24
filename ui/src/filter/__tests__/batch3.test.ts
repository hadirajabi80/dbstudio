// Batch 3 dialects in the server-side filter: MySQL (CONCAT, '\\' escape, BINARY), ClickHouse and Snowflake (ILIKE, no
// COLLATE NOCASE), plus identifier quoting by dialect.
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind, Dialect } from '../../api/types';
import { quoteIdent } from '../../lib/sql';
import { newCondition, newGroup, type FilterOp, type FilterValue } from '../model';
import { buildPredicate } from '../sql';

const col = (name: string, kind: ColumnKind, dbType: string): ColumnInfo => ({
  name, ordinal: 0, dbType, kind, nullable: true, size: null, precision: null, scale: null, table: 'orders', schema: 'shop', isKey: false,
});
const COLS = [col('id', 'int', 'int'), col('name', 'string', 'varchar(255)'), col('paid', 'bool', 'tinyint(1)'), col('order', 'string', 'varchar(20)')];

const one = (d: Dialect, column: string, op: FilterOp, values: FilterValue[] = [], cs = false) => {
  const c = { ...newCondition(column, op, values), ...(cs ? { caseSensitive: true } : {}) };
  return buildPredicate(newGroup('and', [c]), COLS, d, { alias: 'q' });
};

describe('mysql server predicate', () => {
  it('contains / starts / ends use CONCAT (never ||) and a valid ESCAPE literal', () => {
    const r = one('mysql', 'name', 'contains', ['50%_x']);
    expect(r.where).toBe("q.name LIKE CONCAT('%', @fp1, '%') ESCAPE '\\\\'");
    expect(r.params).toEqual([{ name: 'fp1', kind: 'string', value: '50\\%\\_x' }]);
    expect(one('mysql', 'name', 'startsWith', ['ab']).where).toBe("q.name LIKE CONCAT(@fp1, '%') ESCAPE '\\\\'");
    expect(one('mysql', 'name', 'endsWith', ['ab']).where).toBe("q.name LIKE CONCAT('%', @fp1) ESCAPE '\\\\'");
    expect(one('mysql', 'name', 'notContains', ['ab']).where).toBe("NOT (q.name LIKE CONCAT('%', @fp1, '%') ESCAPE '\\\\')");
  });

  it('case-sensitive text uses BINARY', () => {
    expect(one('mysql', 'name', 'contains', ['A'], true).where).toBe("q.name LIKE BINARY CONCAT('%', @fp1, '%') ESCAPE '\\\\'");
    expect(one('mysql', 'name', 'eq', ['Ada'], true).where).toBe('q.name = BINARY @fp1');
  });

  it('case-insensitive equality uses lower() on both sides, never COLLATE NOCASE', () => {
    expect(one('mysql', 'name', 'eq', ['Ada']).where).toBe('lower(q.name) = lower(@fp1)');
    expect(one('mysql', 'name', 'in', ['a', 'b']).where).toBe('lower(q.name) IN (lower(@fp1), lower(@fp2))');
  });

  it('booleans compare with 1 / 0', () => {
    expect(one('mysql', 'paid', 'isTrue').where).toBe('q.paid = 1');
    expect(one('mysql', 'paid', 'isFalse').where).toBe('q.paid = 0');
  });

  it('quick search concatenates with CONCAT too', () => {
    const r = buildPredicate(null, COLS, 'mysql', { alias: 'q', quick: 'ada' });
    expect(r.where).toContain("LIKE CONCAT('%', @fp1, '%') ESCAPE '\\\\'");
    expect(r.where).not.toContain('||');
  });
});

describe('clickhouse / snowflake server predicate', () => {
  it('ClickHouse: ILIKE without an ESCAPE clause', () => {
    expect(one('clickhouse', 'name', 'contains', ['a']).where).toBe("q.name ILIKE '%' || @fp1 || '%'");
    expect(one('clickhouse', 'name', 'contains', ['a'], true).where).toBe("q.name LIKE '%' || @fp1 || '%'");
    expect(one('clickhouse', 'name', 'eq', ['a']).where).toBe('lower(q.name) = lower(@fp1)');
  });

  it('Snowflake: ILIKE with the doubled backslash escape, TRUE / FALSE', () => {
    expect(one('snowflake', 'name', 'startsWith', ['a']).where).toBe("q.name ILIKE @fp1 || '%' ESCAPE '\\\\'");
    expect(one('snowflake', 'paid', 'isTrue').where).toBe('q.paid = TRUE');
  });
});

describe('identifier quoting by dialect', () => {
  it('MySQL / ClickHouse use backticks for reserved or unusual names', () => {
    expect(quoteIdent('order', 'mysql')).toBe('`order`');
    expect(quoteIdent('rank', 'mysql')).toBe('`rank`');
    expect(quoteIdent('my col', 'mysql')).toBe('`my col`');
    expect(quoteIdent('a`b', 'mysql', true)).toBe('`a``b`');
    expect(quoteIdent('group', 'clickhouse')).toBe('`group`');
    expect(quoteIdent('orders', 'mysql')).toBe('orders');
  });

  it('other dialects keep their quotes', () => {
    expect(quoteIdent('order', 'sqlite')).toBe('"order"');
    expect(quoteIdent('order', 'pgsql')).toBe('"order"');
    expect(quoteIdent('order', 'tsql')).toBe('[order]');
    expect(quoteIdent('x y', 'snowflake')).toBe('"x y"');
  });
});

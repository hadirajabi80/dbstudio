// PostgreSQL push-down filters (docs/PLAN-PG.md 4.3): ILIKE / lower() case handling, = TRUE / = FALSE, ::text for
// json/xml/uuid/enum/array columns, ::time, native date/time binds, LIMIT detection and SELECT … INTO rejection.
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind } from '../../api/types';
import { newCondition, newGroup, type FilterOp, type FilterValue } from '../model';
import { analyzeSelect, rewriteWithPredicate } from '../rewrite';
import { buildPredicate, inlineParams, literal, ParamBuilder } from '../sql';

const col = (name: string, kind: ColumnKind, dbType: string): ColumnInfo => ({
  name, ordinal: 0, dbType, kind, nullable: true, size: null, precision: null, scale: null, table: 'orders', schema: 'public', isKey: false,
});
const COLS = [
  col('id', 'int', 'bigint'), col('name', 'string', 'text'), col('code', 'string', 'character varying'), col('total', 'decimal', 'numeric'),
  col('order_date', 'datetime', 'timestamp without time zone'), col('paid', 'bool', 'boolean'), col('at', 'time', 'time with time zone'),
  col('doc', 'json', 'jsonb'), col('spec', 'xml', 'xml'), col('sku', 'guid', 'uuid'), col('status', 'string', 'order_status'),
  col('tags', 'string', 'text[]'), col('CamelCase', 'string', 'text'),
];

const one = (column: string, op: FilterOp, values: FilterValue[] = [], cs = false) => {
  const c = { ...newCondition(column, op, values), ...(cs ? { caseSensitive: true } : {}) };
  return buildPredicate(newGroup('and', [c]), COLS, 'pgsql', { alias: 'q' });
};

describe('pgsql server predicate', () => {
  it('contains uses ILIKE with escaped metacharacters and || concatenation', () => {
    const r = one('name', 'contains', ['50%_x']);
    expect(r.where).toBe("q.name ILIKE '%' || @fp1 || '%' ESCAPE '\\'");
    expect(r.params).toEqual([{ name: 'fp1', kind: 'string', value: '50\\%\\_x' }]);
  });

  it('case-sensitive contains uses LIKE', () => {
    expect(one('name', 'contains', ['A'], true).where).toBe("q.name LIKE '%' || @fp1 || '%' ESCAPE '\\'");
  });

  it('startsWith / endsWith / notContains', () => {
    expect(one('name', 'startsWith', ['ab']).where).toBe("q.name ILIKE @fp1 || '%' ESCAPE '\\'");
    expect(one('name', 'endsWith', ['ab']).where).toBe("q.name ILIKE '%' || @fp1 ESCAPE '\\'");
    expect(one('name', 'notContains', ['ab']).where).toBe("NOT (q.name ILIKE '%' || @fp1 || '%' ESCAPE '\\')");
  });

  it('equality: lower() on both sides unless case-sensitive', () => {
    expect(one('name', 'eq', ['Ada']).where).toBe('lower(q.name) = lower(@fp1)');
    expect(one('name', 'eq', ['Ada'], true).where).toBe('q.name = @fp1');
    expect(one('name', 'neq', ['Ada']).where).toBe('lower(q.name) <> lower(@fp1)');
  });

  it('IN lists lower-case every operand', () => {
    expect(one('code', 'in', ['A', 'B']).where).toBe('lower(q.code) IN (lower(@fp1), lower(@fp2))');
    expect(one('code', 'notIn', ['A'], true).where).toBe('q.code NOT IN (@fp1)');
  });

  it('booleans compare with TRUE / FALSE', () => {
    expect(one('paid', 'isTrue').where).toBe('q.paid = TRUE');
    expect(one('paid', 'isFalse').where).toBe('q.paid = FALSE');
  });

  it('json and xml columns are compared as text', () => {
    expect(one('doc', 'contains', ['vip']).where).toBe("q.doc::text ILIKE '%' || @fp1 || '%' ESCAPE '\\'");
    expect(one('spec', 'eq', ['<a/>'], true).where).toBe('q.spec::text = @fp1');
  });

  it('uuid, enum and array columns are cast to text for LIKE and lower()', () => {
    expect(one('sku', 'startsWith', ['12ab']).where).toBe("q.sku::text ILIKE @fp1 || '%' ESCAPE '\\'");
    expect(one('status', 'eq', ['PAID']).where).toBe('lower(q.status::text) = lower(@fp1)');
    expect(one('tags', 'contains', ['vip']).where).toBe("q.tags::text ILIKE '%' || @fp1 || '%' ESCAPE '\\'");
  });

  it('case-sensitive equality on an enum binds untyped text (the server casts it)', () => {
    const r = one('status', 'eq', ['paid'], true);
    expect(r.where).toBe('q.status = @fp1');
    expect(r.params[0]).toEqual({ name: 'fp1', kind: 'string', value: 'paid' });
  });

  it('time columns cast to ::time and bind time parameters', () => {
    const r = one('at', 'after', ['10:30']);
    expect(r.where).toBe('q.at::time > @fp1');
    expect(r.params[0].kind).toBe('time');
  });

  it('dates use sargable half-open ranges with native datetime binds', () => {
    const r = one('order_date', 'onDate', ['2025-03-01']);
    expect(r.where).toBe('q.order_date >= @fp1 AND q.order_date < @fp2');
    expect(r.params.map((p) => p.kind)).toEqual(['datetime', 'datetime']);
  });

  it('numbers bind int / decimal', () => {
    const r = one('total', 'between', ['10', '20.5']);
    expect(r.where).toBe('q.total BETWEEN @fp1 AND @fp2');
    expect(r.params.map((p) => p.kind)).toEqual(['int', 'decimal']);
  });

  it('is empty compares text', () => {
    expect(one('name', 'isEmpty').where).toBe("q.name = ''");
    expect(one('sku', 'isEmpty').where).toBe("q.sku::text = ''");
  });

  it('mixed-case and reserved column names are quoted', () => {
    expect(one('CamelCase', 'eq', ['x'], true).where).toBe('q."CamelCase" = @fp1');
  });

  it('quick search ORs ILIKE over the text columns (non-text cast, uuid skipped)', () => {
    const r = buildPredicate(null, [COLS[1], COLS[7], COLS[9], COLS[10]], 'pgsql', { alias: 'q', quick: 'ada' });
    expect(r.where).toBe("(q.name ILIKE '%' || @fp1 || '%' ESCAPE '\\' OR q.doc::text ILIKE '%' || @fp1 || '%' ESCAPE '\\' OR q.status::text ILIKE '%' || @fp1 || '%' ESCAPE '\\')");
  });
});

describe('pgsql parameters and literals', () => {
  it('positional builder renders $n with numeric names', () => {
    const pb = new ParamBuilder('pgsql', 'p', 1, { positional: true });
    expect(pb.add('int', 7)).toBe('$1');
    expect(pb.add('string', 'x')).toBe('$2');
    expect(pb.params).toEqual([{ name: '1', kind: 'int', value: 7 }, { name: '2', kind: 'string', value: 'x' }]);
  });

  it('positional is PostgreSQL-only', () => {
    expect(new ParamBuilder('tsql', 'p', 1, { positional: true }).add('int', 1)).toBe('@p1');
  });

  it('inlineParams substitutes $n and @name; booleans as TRUE/FALSE', () => {
    const sql = 'UPDATE t SET a = $1, b = $2 WHERE c = @fp1 AND d = $10';
    const out = inlineParams(sql, [{ name: '1', kind: 'bool', value: true }, { name: '2', kind: 'string', value: "it's" }, { name: 'fp1', kind: 'int', value: 3 }], 'pgsql');
    expect(out).toBe("UPDATE t SET a = TRUE, b = 'it''s' WHERE c = 3 AND d = $10");
  });

  it('inlineParams leaves $$ bodies and unknown names alone', () => {
    expect(inlineParams('SELECT $$a$$, @zz', [{ name: 'fp1', kind: 'int', value: 1 }], 'pgsql')).toBe('SELECT $$a$$, @zz');
  });

  it('literal: plain quoted strings and timestamps, bytea as hex', () => {
    expect(literal('x', 'string', 'pgsql')).toBe("'x'");
    expect(literal('2025-01-02T03:04:05', 'datetime', 'pgsql')).toBe("'2025-01-02T03:04:05'");
    expect(literal(false, 'bool', 'pgsql')).toBe('FALSE');
    expect(literal('AQI=', 'binary', 'pgsql')).toBe("'\\x0102'::bytea");
  });
});

describe('pgsql server rewrite', () => {
  it('wraps with AS q', () => {
    expect(rewriteWithPredicate('SELECT * FROM orders', 'pgsql', 'q.total > @fp1').sql).toBe('SELECT * FROM (\n  SELECT * FROM orders\n) AS q\nWHERE q.total > @fp1');
  });

  it('LIMIT / OFFSET / FETCH FIRST mark the result as limited', () => {
    const a = analyzeSelect('SELECT * FROM orders ORDER BY id LIMIT 10', 'pgsql');
    expect(a.ok && a.limited).toBe(true);
    const b = analyzeSelect('SELECT * FROM orders OFFSET 5', 'pgsql');
    expect(b.ok && b.limited).toBe(true);
    const c = analyzeSelect('SELECT * FROM orders FETCH FIRST 3 ROWS ONLY', 'pgsql');
    expect(c.ok && c.limited).toBe(true);
  });

  it('SELECT … INTO and FOR UPDATE / FOR SHARE are not wrappable', () => {
    expect(analyzeSelect('SELECT * INTO new_orders FROM orders', 'pgsql').ok).toBe(false);
    expect(analyzeSelect('SELECT * FROM orders FOR UPDATE', 'pgsql').ok).toBe(false);
    expect(analyzeSelect('SELECT * FROM orders FOR SHARE', 'pgsql').ok).toBe(false);
    expect(analyzeSelect('SELECT * FROM orders FOR NO KEY UPDATE', 'pgsql').ok).toBe(false);
  });
});

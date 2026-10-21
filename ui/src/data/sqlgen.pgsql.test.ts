// PostgreSQL grid editing SQL (docs/PLAN-PG.md 4.3): native $n binds, boolean/uuid/time kinds, RETURNING, LIMIT/OFFSET.
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind } from '../api/types';
import {
  bindValue, countSql, describeSql, distinctSql, generateChange, generateChanges, keylessOrder, noKeyOrder, paramKindFor, previewScript, refetchSql,
  releaseSavepointSql, rollbackToSavepointSql, savepointSql, selectPageSql, tableSql, type RowChange, type TableTarget,
} from './sqlgen';

const col = (name: string, kind: ColumnKind, dbType: string = kind, nullable = true): ColumnInfo => ({
  name, ordinal: 0, dbType, kind, nullable, size: null, precision: null, scale: null, table: 'customers', schema: 'public', isKey: name === 'id',
});
const id = col('id', 'int', 'bigint', false);
const name = col('name', 'string', 'text');
const active = col('is_active', 'bool', 'boolean');
const sku = col('sku', 'guid', 'uuid');
const opens = col('opens', 'time', 'time');
const total = col('total', 'decimal', 'numeric');
const born = col('born', 'date', 'date');
const profile = col('profile', 'json', 'jsonb');
const tags = col('tags', 'string', 'text[]');
const status = col('status', 'string', 'order_status');
const camel = col('CamelCase', 'string', 'text');
const T: TableTarget = { schema: 'public', name: 'customers', keyColumns: ['id'], identityColumns: ['id'], defaultSchema: 'public' };

describe('pgsql UPDATE / DELETE', () => {
  it('uses $1, $2, … bound by numeric names', () => {
    const s = generateChange({ kind: 'update', ref: '1', key: [{ column: id, value: 7 }], set: [{ column: name, value: 'Ada', old: 'A' }] }, T, 'pgsql');
    expect(s.sql).toBe('UPDATE customers SET name = $1 WHERE id = $2');
    expect(s.params).toEqual([{ name: '1', kind: 'string', value: 'Ada' }, { name: '2', kind: 'int', value: 7 }]);
    expect(s.expectOne).toBe(true);
  });

  it('qualifies a non-default schema', () => {
    const s = generateChange({ kind: 'delete', ref: '1', key: [{ column: id, value: 1 }] }, { ...T, schema: 'sales' }, 'pgsql');
    expect(s.sql).toBe('DELETE FROM sales.customers WHERE id = $1');
  });

  it('booleans bind as booleans (not 1/0)', () => {
    const s = generateChange({ kind: 'update', ref: '1', key: [{ column: id, value: 1 }], set: [{ column: active, value: true, old: false }] }, T, 'pgsql');
    expect(s.params[0]).toEqual({ name: '1', kind: 'bool', value: true });
  });

  it('typed boolean text becomes a boolean', () => {
    expect(bindValue('bool', 't', 'pgsql')).toBe(true);
    expect(bindValue('bool', 'off', 'pgsql')).toBe(false);
    expect(paramKindFor('bool', 'yes', 'pgsql')).toBe('bool');
  });

  it('uuid, time, decimal and date keep their native kinds', () => {
    expect(paramKindFor('guid', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'pgsql')).toBe('guid');
    expect(paramKindFor(opens.kind, '10:30:00', 'pgsql')).toBe('time');
    expect(paramKindFor('decimal', '1.50', 'pgsql')).toBe('decimal');
    expect(paramKindFor('date', '2025-01-02', 'pgsql')).toBe('date');
    expect(paramKindFor('datetimeoffset', '2025-01-02T03:04:05+02:00', 'pgsql')).toBe('datetimeoffset');
  });

  it('jsonb, enum and array columns bind as untyped text', () => {
    const s = generateChange({
      kind: 'update', ref: '1', key: [{ column: id, value: 1 }],
      set: [{ column: profile, value: '{"tier":"gold"}', old: null }, { column: status, value: 'paid', old: 'new' }, { column: tags, value: '{vip,b2b}', old: null }],
    }, T, 'pgsql');
    expect(s.params.slice(0, 3).map((p) => p.kind)).toEqual(['string', 'string', 'string']);
  });

  it('verify unchanged adds old-value checks with further $n', () => {
    const s = generateChange({ kind: 'update', ref: '1', key: [{ column: id, value: 1 }], set: [{ column: name, value: 'B', old: 'A' }, { column: total, value: '2', old: null }] }, T, 'pgsql', { verifyUnchanged: true });
    expect(s.sql).toBe('UPDATE customers SET name = $1, total = $2 WHERE id = $3 AND name = $4 AND total IS NULL');
  });

  it('quotes mixed-case and reserved names', () => {
    const s = generateChange({ kind: 'update', ref: '1', key: [{ column: id, value: 1 }], set: [{ column: camel, value: 'x', old: 'y' }] }, { ...T, name: 'user' }, 'pgsql');
    expect(s.sql).toBe('UPDATE "user" SET "CamelCase" = $1 WHERE id = $2');
  });
});

describe('pgsql INSERT', () => {
  it('omits the identity key and returns it with RETURNING', () => {
    const s = generateChange({ kind: 'insert', ref: 'n1', values: [{ column: id, value: null }, { column: name, value: 'Grace' }, { column: born, value: '1906-12-09' }] }, T, 'pgsql');
    expect(s.sql).toBe('INSERT INTO customers (name, born) VALUES ($1, $2) RETURNING id');
    expect(s.returning).toEqual(['id']);
    expect(s.followUp).toBeUndefined();
  });

  it('no version gate (RETURNING exists since 8.2)', () => {
    const s = generateChange({ kind: 'insert', ref: 'n1', values: [{ column: name, value: 'x' }] }, T, 'pgsql', { sqliteVersion: '3.20.0' });
    expect(s.sql).toContain('RETURNING id');
  });

  it('DEFAULT VALUES when nothing was typed', () => {
    const s = generateChange({ kind: 'insert', ref: 'n1', values: [{ column: id, value: null }] }, T, 'pgsql');
    expect(s.sql).toBe('INSERT INTO customers DEFAULT VALUES RETURNING id');
  });

  it('a typed key is inserted and not returned', () => {
    const s = generateChange({ kind: 'insert', ref: 'n1', values: [{ column: id, value: 42 }, { column: sku, value: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }] }, T, 'pgsql');
    expect(s.sql).toBe('INSERT INTO customers (id, sku) VALUES ($1, $2)');
    expect(s.params[1].kind).toBe('guid');
  });

  it('several changes each number their own binds from $1', () => {
    const changes: RowChange[] = [
      { kind: 'insert', ref: 'n1', values: [{ column: name, value: 'a' }] },
      { kind: 'delete', ref: '2', key: [{ column: id, value: 2 }] },
    ];
    const st = generateChanges(changes, T, 'pgsql');
    expect(st.map((s) => s.sql)).toEqual(['DELETE FROM customers WHERE id = $1', 'INSERT INTO customers (name) VALUES ($1) RETURNING id']);
  });

  it('preview inlines $n values', () => {
    const st = generateChanges([{ kind: 'update', ref: '1', key: [{ column: id, value: 1 }], set: [{ column: active, value: false, old: true }] }], T, 'pgsql');
    expect(previewScript(st, 'pgsql')).toBe('UPDATE customers SET is_active = FALSE WHERE id = 1;');
  });
});

describe('pgsql reading', () => {
  it('pages with LIMIT / OFFSET', () => {
    const p = selectPageSql(T, 'pgsql', { offset: 200, limit: 100, sort: [{ column: 'name', dir: 'desc' }], serverVersion: '17.2' });
    expect(p.sql).toBe('SELECT *\nFROM customers\nORDER BY name DESC, id\nLIMIT 100 OFFSET 200');
    expect(p.pageable).toBe(true);
  });

  it('a filter predicate goes into WHERE', () => {
    expect(selectPageSql(T, 'pgsql', { offset: 0, limit: 10, where: 'is_active = TRUE' }).sql).toBe('SELECT *\nFROM customers\nWHERE is_active = TRUE\nORDER BY id\nLIMIT 10 OFFSET 0');
  });

  it('count and distinct use LIMIT', () => {
    expect(countSql(T, 'pgsql')).toBe('SELECT COUNT(*) AS row_count\nFROM customers');
    expect(distinctSql(T, 'pgsql', 'status', null, 50)).toBe('SELECT status, COUNT(*) AS cnt\nFROM customers\nGROUP BY status\nORDER BY COUNT(*) DESC\nLIMIT 50');
  });

  it('describe probe and table name', () => {
    expect(describeSql({ ...T, schema: 'sales' }, 'pgsql')).toBe('SELECT *\nFROM sales.customers\nWHERE 1 = 0');
    expect(tableSql({ ...T, schema: 'Sales' }, 'pgsql')).toBe('"Sales".customers');
  });

  it('refetch by key uses $n', () => {
    const r = refetchSql(T, 'pgsql', [[{ column: id, value: 1 }], [{ column: id, value: 2 }]]);
    expect(r.sql).toBe('SELECT *\nFROM customers\nWHERE id = $1 OR id = $2');
    expect(r.params.map((p) => p.name)).toEqual(['1', '2']);
  });

  it('keyless tables order by orderable columns (json / point excluded)', () => {
    const cols = [profile, col('pos', 'other', 'point'), name, col('doc', 'json', 'json')];
    expect(noKeyOrder('pgsql', cols, false)).toEqual(['profile', 'name']);
    expect(keylessOrder('pgsql', cols, false, null)).toBeNull();
  });

  it('savepoints: SAVEPOINT / ROLLBACK TO / RELEASE', () => {
    expect(savepointSql('pgsql')).toBe('SAVEPOINT dbs_edit');
    expect(rollbackToSavepointSql('pgsql')).toBe('ROLLBACK TO SAVEPOINT dbs_edit');
    expect(releaseSavepointSql('pgsql')).toBe('RELEASE SAVEPOINT dbs_edit');
  });
});

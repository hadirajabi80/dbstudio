import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogSnapshot, ColumnInfo, ColumnKind, ConnectionProfile } from '../../api/types';
import { computeView } from '../../filter/evaluate';
import { newGroup } from '../../filter/model';
import { pendingCount, useEdits } from '../../store/edits';
import { distinctCondition, distinctValues } from '../FilterBar/DistinctValues';
import { describeModel } from '../FilterBar/describe';
import { detectParams } from '../ParamsDialog/detect';
import { convertValue } from '../ParamsDialog/ParamsDialog';
import { foreignKeys, referencingTables, resultEditability, tableEditability } from './editability';
import { parseEdit } from './editValue';
import { overlayRows } from './overlay';
import { cellEqualsCondition, quickFilterOptions } from './quickFilter';

const col = (name: string, kind: ColumnKind, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey: false, ...extra,
});

const SNAP: CatalogSnapshot = {
  connectionId: 'c', dialect: 'sqlite', database: 'main', defaultSchema: 'main', version: 1, databases: ['main'],
  schemas: [{
    name: 'main', version: 1, objects: [
      { t: 'table', n: 'customers', c: [['id', 'INTEGER', 0, 1, 1, null], ['name', 'TEXT', 1, 0, 0, null], ['country_id', 'INTEGER', 1, 0, 0, null], ['full', 'TEXT', 1, 0, 2, null]], pk: ['id'], fk: [{ n: 'fk_c_country', cols: ['country_id'], rs: 'main', rt: 'countries', rcols: ['id'] }] },
      { t: 'table', n: 'countries', c: [['id', 'INTEGER', 0, 1, 0, null], ['name', 'TEXT', 0, 0, 0, null]], pk: ['id'] },
      { t: 'table', n: 'orders', c: [['id', 'INTEGER', 0, 1, 1, null], ['customer_id', 'INTEGER', 0, 0, 0, null]], pk: ['id'], fk: [{ n: 'fk_o_c', cols: ['customer_id'], rs: 'main', rt: 'customers', rcols: ['id'] }] },
    ],
  }],
};
const CONN = { id: 'c', readOnly: false } as ConnectionProfile;
const COLS = [col('id', 'int', { isKey: true }), col('name', 'string'), col('country_id', 'int'), col('full', 'string')];

describe('editability', () => {
  it('single-table SELECT with the key is editable; computed columns stay read-only; identity known', () => {
    const e = resultEditability(COLS, { singleSelect: true, snapshot: SNAP, conn: CONN });
    expect(e.editable).toBe(true);
    expect(e.target).toMatchObject({ schema: 'main', name: 'customers', keyColumns: ['id'], identityColumns: ['id'] });
    expect([...e.editableColumns]).toEqual([0, 1, 2]);
  });
  it('JOIN results are not editable', () => {
    const e = resultEditability([...COLS, col('total', 'decimal', { table: 'orders' })], { singleSelect: true, snapshot: SNAP, conn: CONN });
    expect(e).toMatchObject({ editable: false, reason: 'Results of a JOIN are not editable' });
  });
  it('read-only connections and scripts are not editable', () => {
    expect(resultEditability(COLS, { singleSelect: true, snapshot: SNAP, conn: { ...CONN, readOnly: true } }).reason).toBe('Read-only connection');
    expect(resultEditability(COLS, { singleSelect: false, snapshot: SNAP, conn: CONN }).editable).toBe(false);
  });
  it('needs every key column in the result', () => {
    expect(resultEditability(COLS.slice(1), { singleSelect: true, snapshot: SNAP, conn: CONN }).reason).toBe('Add the key column id to edit');
  });
  it('falls back to ColumnInfo.isKey without a catalog, and aliases are read-only', () => {
    const e = resultEditability([col('id', 'int', { isKey: true }), col('n', 'string')], { singleSelect: true, snapshot: null, conn: CONN });
    expect(e.editable).toBe(true);
    expect(e.target?.keyColumns).toEqual(['id']);
    const withCat = resultEditability([col('id', 'int', { isKey: true }), col('alias', 'string')], { singleSelect: true, snapshot: SNAP, conn: CONN });
    expect(withCat.editableColumns.has(1)).toBe(false);
  });
  it('tables without a key are read-only in a data tab', () => {
    expect(tableEditability([col('a', 'int')], 'main', 'nokey', null, CONN).reason).toMatch(/No primary key/);
    expect(tableEditability(COLS, 'main', 'customers', SNAP, CONN).editable).toBe(true);
  });
  it('finds foreign keys and referencing tables', () => {
    expect(foreignKeys(COLS, 'main', 'customers', SNAP)).toEqual([{ name: 'fk_c_country', ordinals: [2], refSchema: 'main', refTable: 'countries', refColumns: ['id'] }]);
    expect(referencingTables('main', 'customers', SNAP)).toEqual([{ schema: 'main', table: 'orders', constraint: 'fk_o_c', columns: ['customer_id'], refColumns: ['id'] }]);
  });
});

describe('edit buffer', () => {
  const K = 'test-grid';
  beforeEach(() => useEdits.getState().reset(K));

  it('records cell edits and removes them when set back to the original', () => {
    const s = useEdits.getState();
    s.setCell(K, 2, 1, 'Ada', 'Ad');
    expect(s.get(K).pending.updates).toEqual({ 2: { 1: 'Ada' } });
    s.setCell(K, 2, 1, 'Ad', 'Ad');
    expect(useEdits.getState().get(K).pending.updates).toEqual({});
  });
  it('undo / redo step through every change', () => {
    const s = useEdits.getState();
    s.setCell(K, 0, 1, 'a', 'x');
    s.setCell(K, 0, 2, 5, 1);
    s.toggleDelete(K, [3]);
    expect(pendingCount(s.get(K).pending)).toBe(2);
    s.undo(K);
    expect(useEdits.getState().get(K).pending.deletes).toEqual({});
    s.undo(K);
    expect(useEdits.getState().get(K).pending.updates).toEqual({ 0: { 1: 'a' } });
    s.redo(K);
    expect(useEdits.getState().get(K).pending.updates).toEqual({ 0: { 1: 'a', 2: 5 } });
  });
  it('inserts, insert cells and removal', () => {
    const s = useEdits.getState();
    const id = s.addInsert(K, 3);
    s.setInsertCell(K, id, 1, 'Grace');
    const ins = useEdits.getState().get(K).pending.inserts[0];
    expect(ins.values).toEqual([null, 'Grace', null]);
    expect(ins.touched).toEqual({ 1: true });
    s.removeInsert(K, id);
    expect(useEdits.getState().get(K).pending.inserts).toHaveLength(0);
  });
  it('toggles deletes and reverts rows', () => {
    const s = useEdits.getState();
    s.toggleDelete(K, [1, 2]);
    s.toggleDelete(K, [1, 2]);
    expect(useEdits.getState().get(K).pending.deletes).toEqual({});
    s.setCell(K, 4, 0, 1, 0);
    s.toggleDelete(K, [4]);
    s.revertRow(K, 4);
    expect(pendingCount(useEdits.getState().get(K).pending)).toBe(0);
  });
  it('commit folds refetched rows into the overlay and hides deleted rows', () => {
    const s = useEdits.getState();
    s.setCell(K, 0, 1, 'new', 'old');
    s.commit(K, { patched: { 0: [1, 'new (trigger)'] }, hidden: [1], appended: [[3, 'c']] });
    const b = useEdits.getState().get(K);
    expect(pendingCount(b.pending)).toBe(0);
    const base = [[1, 'old'], [2, 'b']];
    const o = overlayRows({ length: 2, get: (i) => base[i] }, b.committed);
    expect(o.length).toBe(3);
    expect(o.get(0)).toEqual([1, 'new (trigger)']);
    expect(o.get(2)).toEqual([3, 'c']);
    const idx = computeView(o, [col('id', 'int'), col('name', 'string')], { quickFilter: '', filter: null, sort: [] }, { hidden: (i) => !!b.committed.hidden[i] });
    expect(Array.from(idx!)).toEqual([0, 2]);
  });
});

describe('typed cell editing', () => {
  it('parses per kind and rejects invalid input', () => {
    expect(parseEdit('42', col('a', 'int'), 'tsql')).toEqual({ ok: true, value: 42 });
    expect(parseEdit('4.2', col('a', 'int'), 'tsql').ok).toBe(false);
    expect(parseEdit('0012.50', col('a', 'decimal'), 'tsql')).toEqual({ ok: true, value: '12.5' });
    expect(parseEdit('1.234', col('a', 'decimal', { scale: 2 }), 'tsql').ok).toBe(false);
    expect(parseEdit('yes', col('a', 'bool'), 'tsql')).toEqual({ ok: true, value: true });
    expect(parseEdit('2026-01-03 10:00', col('a', 'datetime'), 'plsql')).toEqual({ ok: true, value: '2026-01-03T10:00:00' });
    expect(parseEdit('2026-01-03 10:00', col('a', 'datetime'), 'sqlite')).toEqual({ ok: true, value: '2026-01-03 10:00' });
    expect(parseEdit('31/12/2026', col('a', 'date'), 'tsql').ok).toBe(false);
    expect(parseEdit('', col('a', 'int'), 'tsql')).toEqual({ ok: true, value: null });
    expect(parseEdit('', col('a', 'int', { nullable: false }), 'tsql').ok).toBe(false);
    expect(parseEdit('', col('a', 'string'), 'tsql')).toEqual({ ok: true, value: '' });
    expect(parseEdit('{6F9619FF-8B86-D011-B42D-00C04FC964FF}', col('a', 'guid'), 'tsql')).toEqual({ ok: true, value: '6F9619FF-8B86-D011-B42D-00C04FC964FF' });
  });
});

describe('quick filter from a cell', () => {
  it('offers =, ≠, >, < for numbers and contains for text', () => {
    expect(quickFilterOptions(col('total', 'decimal'), 2, '12.5').map((o) => o.label)).toEqual(['total = 12.5', 'total ≠ 12.5', 'total > 12.5', 'total < 12.5', 'total is not NULL']);
    expect(quickFilterOptions(col('name', 'string'), 1, 'Acme').map((o) => o.id)).toEqual(['eq', 'neq', 'contains', 'isNotNull']);
  });
  it('offers NULL tests on a NULL cell, date ops on dates, booleans', () => {
    expect(quickFilterOptions(col('name', 'string'), 1, null).map((o) => o.id)).toEqual(['isNull', 'isNotNull']);
    expect(quickFilterOptions(col('at', 'datetime'), 0, '2026-01-03T10:00:00').map((o) => o.id)).toEqual(['onDate', 'after', 'before', 'isNotNull']);
    expect(quickFilterOptions(col('ok', 'bool'), 0, true)[0].id).toBe('isTrue');
  });
  it('Alt+click builds the equality (or IS NULL) condition', () => {
    expect(cellEqualsCondition(col('name', 'string'), 1, 'Acme')).toMatchObject({ column: 'name', ordinal: 1, op: 'eq', values: ['Acme'] });
    expect(cellEqualsCondition(col('name', 'string'), 1, null)).toMatchObject({ op: 'isNull' });
  });
});

describe('distinct values', () => {
  it('counts values, most frequent first, capped', () => {
    const rows = [['a'], ['b'], ['a'], [null], ['a'], ['b']];
    const d = distinctValues({ length: rows.length, get: (i) => rows[i] }, 0);
    expect(d.items).toEqual([{ value: 'a', count: 3 }, { value: 'b', count: 2 }, { value: null, count: 1 }]);
    expect(distinctValues({ length: rows.length, get: (i) => rows[i] }, 0, 2).more).toBe(true);
  });
  it('checked values become IN (+ IS NULL)', () => {
    expect(distinctCondition(col('n', 'string'), 0, ['a', 'b'])).toMatchObject({ op: 'in', values: ['a', 'b'] });
    expect(distinctCondition(col('n', 'string'), 0, ['a'])).toMatchObject({ op: 'eq', values: ['a'] });
    const g = distinctCondition(col('n', 'string'), 0, ['a', null]);
    expect(g).toMatchObject({ kind: 'group', logic: 'or' });
    expect(describeModel({ root: newGroup('and', [g!]) })).toBe("(n = 'a' OR n is NULL)");
  });
});

describe('parameter detection', () => {
  const b = (sql: string) => [{ sql, line: 1, col: 1 }];
  it('T-SQL: undeclared @x prompts, DECLAREd and @@globals do not', () => {
    expect(detectParams(b('SELECT * FROM t WHERE id = @id AND name = @Name'), 'tsql').map((p) => p.name)).toEqual(['id', 'Name']);
    expect(detectParams(b('DECLARE @id int = 5, @x nvarchar(10)\nSELECT * FROM t WHERE id = @id AND x = @x AND y = @y'), 'tsql').map((p) => p.name)).toEqual(['y']);
    expect(detectParams(b('SELECT @@VERSION'), 'tsql')).toEqual([]);
    expect(detectParams(b("SELECT '@notaparam' -- @neither\nFROM t"), 'tsql')).toEqual([]);
    expect(detectParams(b('EXEC dbo.GetCustomer @Id = @cust'), 'tsql').map((p) => p.name)).toEqual(['cust']);
    expect(detectParams(b('CREATE PROCEDURE p @Id int AS SELECT @Id'), 'tsql')).toEqual([]);
    expect(detectParams(b('SELECT * FROM t WHERE a = @a OR b = @A'), 'tsql')).toHaveLength(1);
  });
  it('Oracle :x binds (not &substitution, not trigger :new)', () => {
    expect(detectParams(b('SELECT * FROM t WHERE id = :id AND d > :since'), 'plsql').map((p) => p.display)).toEqual([':id', ':since']);
    expect(detectParams(b("SELECT * FROM t WHERE x = '&v' AND y = &v"), 'plsql')).toEqual([]);
    expect(detectParams(b('CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :new.id := 1; END;'), 'plsql')).toEqual([]);
  });
  it('SQLite ?, ?N, :x, @x, $x', () => {
    expect(detectParams(b('SELECT * FROM t WHERE a = ? AND b = ?'), 'sqlite')).toEqual([
      { name: '1', display: '?', positional: true }, { name: '2', display: '?', positional: true },
    ]);
    expect(detectParams(b('SELECT * FROM t WHERE a = :a AND b = @b AND c = $c AND d = ?3'), 'sqlite').map((p) => p.name)).toEqual(['a', 'b', 'c', '3']);
  });
  it('converts typed values', () => {
    expect(convertValue('int', '12')).toEqual({ ok: true, value: 12 });
    expect(convertValue('int', 'x').ok).toBe(false);
    expect(convertValue('datetime', '2026-01-03 10:00')).toEqual({ ok: true, value: '2026-01-03T10:00:00' });
    expect(convertValue('binary', '0x0102')).toEqual({ ok: true, value: 'AQI=' });
    expect(convertValue('bool', 'no')).toEqual({ ok: true, value: false });
    expect(convertValue('refcursor', '')).toEqual({ ok: true, value: null });
  });
});

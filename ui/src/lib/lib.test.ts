import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo } from '../api/types';
import { ChunkedList } from './chunked';
import { findDestructive } from './classify';
import { computeView, newCondition, newGroup } from './filter';
import { formatCell, prettyPrint } from './format';
import { fuzzyMatch } from './fuzzy';
import { serializeRows } from './serialize';
import { qualifiedName, selectTopSql } from './sql';

const b = (sql: string, line = 1) => [{ sql, line, col: 1 }];

describe('destructive classifier', () => {
  it('flags DELETE/UPDATE without WHERE, DROP and TRUNCATE', () => {
    expect(findDestructive(b('DELETE FROM Orders'), 'tsql')).toMatchObject([{ kind: 'DELETE', description: 'DELETE without WHERE on Orders' }]);
    expect(findDestructive(b('update dbo.Orders set Total = 0'), 'tsql')[0]).toMatchObject({ kind: 'UPDATE', description: 'UPDATE without WHERE on dbo.Orders' });
    expect(findDestructive(b('DROP TABLE IF EXISTS t'), 'sqlite')[0]).toMatchObject({ kind: 'DROP', description: 'DROP TABLE t' });
    expect(findDestructive(b('TRUNCATE TABLE logs'), 'tsql')[0].kind).toBe('TRUNCATE');
    expect(findDestructive(b('ALTER TABLE t DROP COLUMN x'), 'tsql')[0].kind).toBe('ALTER_DROP');
  });

  it('does not flag safe statements', () => {
    const safe = [
      'DELETE FROM Orders WHERE Id = 1',
      'UPDATE o SET o.Total = 1 FROM Orders o JOIN Customers c ON c.Id = o.CustomerId WHERE c.Id = 3',
      "SELECT 'DELETE FROM x' AS s",
      '-- DROP TABLE x\nSELECT 1',
      '/* TRUNCATE TABLE x */ SELECT 1',
      'SELECT * FROM t FOR UPDATE',
      'CREATE TABLE t (id int REFERENCES p(id) ON DELETE CASCADE ON UPDATE NO ACTION)',
      'CREATE PROCEDURE p AS BEGIN DELETE FROM x END',
      'CREATE TRIGGER trg AFTER DELETE ON t BEGIN DELETE FROM u; END',
      'UPDATE STATISTICS dbo.Orders',
      'WITH c AS (SELECT 1 AS x) DELETE FROM t WHERE x IN (SELECT x FROM c)',
      'INSERT INTO t(a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = 2',
      'UPDATE t SET a = (SELECT max(b) FROM u) WHERE id = 1',
    ];
    for (const s of safe) expect(findDestructive(b(s), 'tsql'), s).toEqual([]);
  });

  it('reports the document line of each finding across batches', () => {
    const f = findDestructive([{ sql: 'SELECT 1', line: 1, col: 1 }, { sql: 'SELECT 2;\n\nDELETE FROM a', line: 3, col: 1 }], 'tsql');
    expect(f).toEqual([{ kind: 'DELETE', description: 'DELETE without WHERE on a', line: 5 }]);
  });
});

describe('fuzzy', () => {
  it('matches subsequences, prefers prefixes and word starts', () => {
    expect(fuzzyMatch('ord', 'orders')!.score).toBeGreaterThan(fuzzyMatch('ord', 'v_customer_orders')!.score);
    expect(fuzzyMatch('ol', 'order_lines')!.positions).toEqual([0, 6]);
    expect(fuzzyMatch('xyz', 'orders')).toBeNull();
  });
});

const cols = (...kinds: ColumnInfo['kind'][]): ColumnInfo[] =>
  kinds.map((k, i) => ({ name: `c${i}`, ordinal: i, dbType: k, kind: k, nullable: true, size: null, precision: null, scale: null, table: 'T', schema: 'dbo', isKey: false }));

describe('grid filter model', () => {
  const columns = cols('int', 'string', 'decimal');
  const rows: CellValue[][] = [
    [1, 'alpha', '10.50'],
    [2, 'Beta', null],
    [3, 'gamma', '2.00'],
    [10, null, '100'],
  ];
  const list = ChunkedList.from(rows);
  const ids = (idx: Uint32Array | null) => (idx ? Array.from(idx, (i) => rows[i][0]) : rows.map((r) => r[0]));

  it('returns null (identity) when there is no view', () => {
    expect(computeView(list, columns, { quickFilter: '', filter: null, sort: [] })).toBeNull();
  });
  it('quick filter searches all columns case-insensitively', () => {
    expect(ids(computeView(list, columns, { quickFilter: 'BET', filter: null, sort: [] }))).toEqual([2]);
  });
  it('evaluates AND/OR groups with typed comparisons', () => {
    const f = newGroup('or', [newCondition(2, 'gt', '5'), newGroup('and', [newCondition(1, 'startsWith', 'g'), newCondition(0, 'lte', '3')])]);
    expect(ids(computeView(list, columns, { quickFilter: '', filter: f, sort: [] }))).toEqual([1, 3, 10]);
    expect(ids(computeView(list, columns, { quickFilter: '', filter: newGroup('and', [newCondition(2, 'isNull')]), sort: [] }))).toEqual([2]);
    expect(ids(computeView(list, columns, { quickFilter: '', filter: newGroup('and', [newCondition(0, 'in', '1, 10')]), sort: [] }))).toEqual([1, 10]);
  });
  it('sorts numerically with NULLs last in both directions', () => {
    expect(ids(computeView(list, columns, { quickFilter: '', filter: null, sort: [{ column: 2, dir: 'desc' }] }))).toEqual([10, 1, 3, 2]);
    expect(ids(computeView(list, columns, { quickFilter: '', filter: null, sort: [{ column: 2, dir: 'asc' }] }))).toEqual([3, 1, 10, 2]);
    expect(ids(computeView(list, columns, { quickFilter: '', filter: null, sort: [{ column: 1, dir: 'asc' }] }))).toEqual([2, 1, 3, 10]);
  });
});

describe('serialization', () => {
  const columns = cols('int', 'string', 'binary');
  const rows: CellValue[][] = [[1, 'a,"b"', { $bin: 'AQI=', len: 2 }], [2, null, null]];
  it('CSV escapes and TSV flattens', () => {
    expect(serializeRows('csv', columns, rows)).toBe('c0,c1,c2\r\n1,"a,""b""",0x0102\r\n2,,');
    expect(serializeRows('tsv', columns, [[1, 'x\ty\nz', null]])).toBe('c0\tc1\tc2\n1\tx y z\t');
  });
  it('SQL INSERT uses dialect literals', () => {
    expect(serializeRows('sql-insert', columns, rows, { dialect: 'tsql' })).toBe(
      'INSERT INTO dbo.T (c0, c1, c2) VALUES (1, \'a,"b"\', 0x0102);\nINSERT INTO dbo.T (c0, c1, c2) VALUES (2, NULL, NULL);',
    );
    // Oracle: lower-case names must be quoted to keep their case
    expect(serializeRows('sql-insert', cols('string'), [["it's"]], { dialect: 'plsql', tableName: 'X' })).toBe('INSERT INTO X ("c0") VALUES (\'it\'\'s\');');
  });
  it('JSON and Markdown', () => {
    expect(JSON.parse(serializeRows('json', columns, rows))).toEqual([{ c0: 1, c1: 'a,"b"', c2: '0x0102' }, { c0: 2, c1: null, c2: null }]);
    expect(serializeRows('markdown', cols('int', 'string'), [[1, 'a|b']])).toBe('| c0 | c1 |\n| ---: | --- |\n| 1 | a\\|b |');
  });
});

describe('formatting and sql helpers', () => {
  it('formats cells by kind', () => {
    const o = { nullText: 'NULL', dateFormat: 'iso' as const };
    expect(formatCell(null, undefined, o)).toBe('NULL');
    expect(formatCell('2026-10-14T10:00:00.1230000', cols('datetime')[0], o)).toBe('2026-10-14 10:00:00.123');
    expect(formatCell('2026-10-14T10:00:00.0000000', cols('datetime')[0], o)).toBe('2026-10-14 10:00:00');
    expect(formatCell({ $bin: 'AQI=', len: 2 }, cols('binary')[0], o)).toBe('0x0102  (2 B)');
    expect(formatCell('a\nb', cols('string')[0], o)).toBe('a ↵ b');
  });
  it('pretty prints JSON and XML', () => {
    expect(prettyPrint('{"a":1}', 'string')).toEqual({ text: '{\n  "a": 1\n}', language: 'json' });
    expect(prettyPrint('<a><b>1</b></a>', 'xml').text).toBe('<a>\n  <b>1</b>\n</a>');
  });
  it('quotes identifiers and builds select-top per dialect', () => {
    expect(qualifiedName({ schema: 'dbo', name: 'Order Lines' }, 'tsql', { always: true })).toBe('dbo.[Order Lines]');
    expect(qualifiedName({ schema: 'main', name: 'orders' }, 'sqlite')).toBe('orders');
    expect(qualifiedName({ schema: 'SHOP', name: 'MixedCase' }, 'plsql', { defaultSchema: 'SHOP' })).toBe('"MixedCase"');
    expect(selectTopSql({ database: null, schema: 'dbo', name: 'Orders', type: 'table' }, 'tsql', 1000)).toBe('SELECT TOP 1000 *\nFROM dbo.Orders;');
    expect(selectTopSql({ database: null, schema: 'SHOP', name: 'ORDERS', type: 'table' }, 'plsql', 10)).toBe('SELECT *\nFROM SHOP.ORDERS\nFETCH FIRST 10 ROWS ONLY;');
  });
});

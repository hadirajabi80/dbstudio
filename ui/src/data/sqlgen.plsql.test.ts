// Oracle data editing (ROWID identity of keyless tables, LOB / '' / reserved-word handling) — the statements are the
// ones the engine's Oracle integration tests (OracleDataEditTests) run against a real server.
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot, ColumnInfo, ColumnKind } from '../api/types';
import { findTable, resultEditability, tableEditability } from '../components/Grid/editability';
import { quoteIdent } from '../lib/sql';
import { generateChange, isComparableColumn, isRowidColumn, previewScript, refetchSql, selectPageSql, type RowChange, type TableTarget } from './sqlgen';

const col = (name: string, kind: ColumnKind, dbType = kind.toUpperCase(), table = 'NOPK'): ColumnInfo => ({
  name, ordinal: 0, dbType, kind, nullable: true, size: null, precision: null, scale: null, table, schema: null, isKey: false,
});
const A = col('A', 'decimal', 'NUMBER');
const B = col('B', 'string', 'VARCHAR2');
const C = col('C', 'string', 'CHAR');
const CL = col('CL', 'string', 'CLOB');
const ROWID = col('ROWID', 'string', 'VARCHAR2');
const KEYLESS: TableTarget = { schema: 'SHOP', name: 'NOPK', keyColumns: ['ROWID'], rowid: true, identityColumns: [], defaultSchema: 'SHOP' };
const RID = 'AAAR6DAAYAAAAAeAAA';

describe('Oracle ROWID row identity (table without a primary key)', () => {
  it('pages read ROWID as the last column; the ORDER BY fallback is the pseudo-column', () => {
    const page = selectPageSql({ ...KEYLESS, keyColumns: [], orderFallback: ['ROWID'] }, 'plsql', { offset: 0, limit: 100, where: 'A = :p1', serverVersion: '23.26.3.0.0' });
    expect(page.sql).toBe('SELECT NOPK.*, ROWID\nFROM NOPK\nWHERE A = :p1\nORDER BY ROWID\nOFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY');
    // Another schema is qualified in the select list too; pre-12c servers wrap the same select in ROWNUM.
    const other = selectPageSql({ ...KEYLESS, schema: 'OTHER', keyColumns: [] }, 'plsql', { offset: 0, limit: 10, serverVersion: '11.2.0.4' });
    expect(other.sql).toBe('SELECT * FROM (\nSELECT OTHER.NOPK.*, ROWID\nFROM OTHER.NOPK\n)\nWHERE ROWNUM <= 10');
    // A quoted lower-case table.
    expect(selectPageSql({ ...KEYLESS, name: 'lower_tab', keyColumns: [] }, 'plsql', { offset: 0, limit: 5 }).sql)
      .toBe('SELECT "lower_tab".*, ROWID\nFROM "lower_tab"\nOFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY');
    // Without the flag (and on other dialects) nothing changes.
    expect(selectPageSql({ ...KEYLESS, rowid: false, keyColumns: [] }, 'plsql', { offset: 0, limit: 5 }).sql).toBe('SELECT *\nFROM NOPK\nOFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY');
  });

  it('UPDATE / DELETE identify the row by ROWID; the ROWID is never verified as a data column', () => {
    const upd: RowChange = { kind: 'update', ref: '1', key: [{ column: ROWID, value: RID }], set: [{ column: B, value: 'y', old: 'x' }] };
    const u = generateChange(upd, KEYLESS, 'plsql', { verifyUnchanged: true });
    expect(u.sql).toBe('UPDATE NOPK SET B = :p1 WHERE ROWID = :p2 AND B = :p3');
    expect(u.params).toEqual([{ name: 'p1', kind: 'string', value: 'y' }, { name: 'p2', kind: 'string', value: RID }, { name: 'p3', kind: 'string', value: 'x' }]);
    const del: RowChange = {
      kind: 'delete', ref: '1', key: [{ column: ROWID, value: RID }],
      original: [{ column: A, value: '1' }, { column: B, value: null }, { column: ROWID, value: RID }],
    };
    expect(generateChange(del, KEYLESS, 'plsql', { verifyUnchanged: true }).sql).toBe('DELETE FROM NOPK WHERE ROWID = :p1 AND A = :p2 AND B IS NULL');
  });

  it('INSERT returns the new ROWID as text; nothing typed sets one real column to DEFAULT', () => {
    const ins: RowChange = { kind: 'insert', ref: 'n1', values: [{ column: A, value: 9 }, { column: B, value: 'new' }] };
    const s = generateChange(ins, KEYLESS, 'plsql', { columns: [A, B, C, ROWID] });
    expect(s.sql).toBe('INSERT INTO NOPK (A, B) VALUES (:p1, :p2) RETURNING ROWID INTO :out1');
    expect(s.params.at(-1)).toEqual({ name: 'out1', kind: 'string', value: null, direction: 'out' });
    expect(s.returning).toEqual(['ROWID']);
    const empty = generateChange({ kind: 'insert', ref: 'n2', values: [] }, KEYLESS, 'plsql', { columns: [A, B, ROWID] });
    expect(empty.sql).toBe('INSERT INTO NOPK (A) VALUES (DEFAULT) RETURNING ROWID INTO :out1');
  });

  it('the refetch after a save reads ROWID too, so the saved rows keep their identity', () => {
    const q = refetchSql(KEYLESS, 'plsql', [[{ column: ROWID, value: RID }], [{ column: ROWID, value: 'AAAR6DAAYAAAAAeAAB' }]]);
    expect(q.sql).toBe('SELECT NOPK.*, ROWID\nFROM NOPK\nWHERE ROWID = :k1 OR ROWID = :k2');
  });

  it('isRowidColumn is Oracle-only', () => {
    expect(isRowidColumn(ROWID, 'plsql')).toBe(true);
    expect(isRowidColumn({ name: 'rowid' }, 'sqlite')).toBe(false);
    expect(isRowidColumn(B, 'plsql')).toBe(false);
  });
});

describe('Oracle optimistic concurrency ("verify unchanged values")', () => {
  const PK: TableTarget = { schema: 'SHOP', name: 'TYPES', keyColumns: ['ID'], identityColumns: [], defaultSchema: 'SHOP' };
  const ID = col('ID', 'int', 'NUMBER', 'TYPES');

  it('CLOB / NCLOB / BLOB / XMLTYPE are written but never compared (ORA-22848)', () => {
    const upd: RowChange = { kind: 'update', ref: '0', key: [{ column: ID, value: 1 }], set: [{ column: CL, value: 'new clob', old: 'clob text' }, { column: B, value: 'b', old: 'a' }] };
    expect(generateChange(upd, PK, 'plsql', { verifyUnchanged: true }).sql).toBe('UPDATE TYPES SET CL = :p1, B = :p2 WHERE ID = :p3 AND B = :p4');
    const del: RowChange = { kind: 'delete', ref: '0', key: [{ column: ID, value: 1 }], original: [{ column: CL, value: 'x' }, { column: col('X', 'xml', 'XMLTYPE'), value: '<a/>' }, { column: C, value: 'ab   ' }] };
    expect(generateChange(del, PK, 'plsql', { verifyUnchanged: true }).sql).toBe('DELETE FROM TYPES WHERE ID = :p1 AND C = :p2');
    for (const t of ['CLOB', 'NCLOB', 'BLOB', 'LONG', 'LONG RAW', 'BFILE', 'XMLTYPE', 'JSON']) expect(isComparableColumn(col('X', 'string', t), 'plsql'), t).toBe(false);
    // PostgreSQL text is an ordinary comparable type; T-SQL text is not.
    expect(isComparableColumn(col('X', 'string', 'text'), 'pgsql')).toBe(true);
    expect(isComparableColumn(col('X', 'string', 'text'), 'tsql')).toBe(false);
  });

  it('BINARY_FLOAT / BINARY_DOUBLE are not verified (0.1 read back is not the stored single-precision value)', () => {
    const F = col('F', 'float', 'BINARY_FLOAT');
    const upd: RowChange = { kind: 'update', ref: '0', key: [{ column: ID, value: 1 }], set: [{ column: F, value: 0.2, old: 0.1 }] };
    expect(generateChange(upd, PK, 'plsql', { verifyUnchanged: true }).sql).toBe('UPDATE TYPES SET F = :p1 WHERE ID = :p2');
  });

  it("an old '' is NULL in Oracle: compared with IS NULL (key columns too)", () => {
    const upd: RowChange = { kind: 'update', ref: '0', key: [{ column: ID, value: 1 }], set: [{ column: B, value: 'x', old: '' }] };
    expect(generateChange(upd, PK, 'plsql', { verifyUnchanged: true }).sql).toBe('UPDATE TYPES SET B = :p1 WHERE ID = :p2 AND B IS NULL');
    const keyed: RowChange = { kind: 'delete', ref: '0', key: [{ column: B, value: '' }] };
    expect(generateChange(keyed, { ...PK, keyColumns: ['B'] }, 'plsql').sql).toBe('DELETE FROM TYPES WHERE B IS NULL');
    // Elsewhere '' is a value.
    expect(generateChange(upd, PK, 'tsql', { verifyUnchanged: true }).sql).toBe('UPDATE SHOP.TYPES SET B = @p1 WHERE ID = @p2 AND B = @p3');
  });

  it('a CHAR value keeps its blank padding, so it still equals the stored CHAR', () => {
    const upd: RowChange = { kind: 'update', ref: '0', key: [{ column: ID, value: 1 }], set: [{ column: C, value: 'xy', old: 'ab   ' }] };
    expect(generateChange(upd, PK, 'plsql', { verifyUnchanged: true }).params.at(-1)).toEqual({ name: 'p3', kind: 'string', value: 'ab   ' });
  });
});

describe('Oracle identifiers', () => {
  it('reserved words are quoted (a column created as "COMMENT"), ROWID is the bare pseudo-column', () => {
    expect(quoteIdent('COMMENT', 'plsql')).toBe('"COMMENT"');
    expect(quoteIdent('MODE', 'plsql')).toBe('"MODE"');
    expect(quoteIdent('UID', 'plsql')).toBe('"UID"');
    expect(quoteIdent('ROWID', 'plsql')).toBe('ROWID');
    expect(quoteIdent('NAME', 'plsql')).toBe('NAME');
    const t: TableTarget = { schema: 'SHOP', name: 'NOTES', keyColumns: ['ID'], defaultSchema: 'SHOP' };
    const upd: RowChange = { kind: 'update', ref: '0', key: [{ column: col('ID', 'int'), value: 1 }], set: [{ column: col('COMMENT', 'string', 'VARCHAR2'), value: 'b', old: 'a' }] };
    expect(previewScript([generateChange(upd, t, 'plsql')], 'plsql')).toBe(`UPDATE NOTES SET "COMMENT" = 'b' WHERE ID = 1;`);
  });
});

// ---------------------------------------------------------------- editability

const snapshot = (objects: Record<string, { n: string; t?: 'table' | 'view'; pk?: string[]; c?: [string, string, 0 | 1, 0 | 1, number, string | null][] }[]>): CatalogSnapshot => ({
  connectionId: 'c', dialect: 'plsql', defaultSchema: 'SHOP', databases: [],
  schemas: Object.entries(objects).map(([name, objs]) => ({ name, objects: objs.map((o) => ({ t: o.t ?? 'table', n: o.n, pk: o.pk, c: o.c })) })),
} as unknown as CatalogSnapshot);

describe('Oracle editability', () => {
  const snap = snapshot({
    SHOP: [
      { n: 'NOPK', c: [['A', 'NUMBER', 1, 0, 0, null], ['B', 'VARCHAR2(20)', 1, 0, 0, null]] },
      {
        n: 'TYPES', pk: ['ID'],
        c: [['ID', 'NUMBER(10)', 0, 1, 1 | 8, null], ['V', 'VARCHAR2(50)', 1, 0, 0, null], ['VIRT', 'NUMBER', 1, 0, 2, null]],
      },
      { n: 'lower_tab', pk: ['id'] },
      { n: 'LOWER_TAB', pk: ['ID'] },
      { n: 'V_NOPK', t: 'view' },
    ],
    OTHER: [{ n: 'TYPES', pk: ['OID'] }],
  });

  it('a keyless table read with ROWID is editable by ROWID; ROWID itself is not editable', () => {
    const e = tableEditability([A, B, ROWID], 'SHOP', 'NOPK', snap, undefined, false, 'plsql', 'SHOP');
    expect(e.editable).toBe(true);
    expect(e.target).toMatchObject({ schema: 'SHOP', name: 'NOPK', keyColumns: ['ROWID'], rowid: true, defaultSchema: 'SHOP' });
    expect([...e.editableColumns]).toEqual([0, 1]);
    // Without the ROWID column, on views, and on other dialects it stays read-only.
    expect(tableEditability([A, B], 'SHOP', 'NOPK', snap, undefined, false, 'plsql').reason).toBe('No primary key: read-only');
    expect(tableEditability([A, B, ROWID], 'SHOP', 'V_NOPK', snap, undefined, true, 'plsql').reason).toBe('View without a key: read-only');
    expect(tableEditability([A, B, ROWID], 'SHOP', 'NOPK', snap, undefined, false, 'tsql').editable).toBe(false);
  });

  it('a table with a primary key keeps its key even when ROWID was read', () => {
    const cols = [col('ID', 'int', 'NUMBER', 'TYPES'), col('V', 'string', 'VARCHAR2', 'TYPES'), col('VIRT', 'decimal', 'NUMBER', 'TYPES'), ROWID];
    const e = tableEditability(cols, 'SHOP', 'TYPES', snap, undefined, false, 'plsql');
    expect(e.target?.keyColumns).toEqual(['ID']);
    expect(e.target?.rowid).toBeUndefined();
    // GENERATED ALWAYS identity (flag 8) and the virtual column are read-only.
    expect([...e.editableColumns]).toEqual([1]);
    expect(e.target?.identityColumns).toEqual(['ID']);
  });

  it('an exact-case name wins over a case-insensitive match; the current schema is searched first', () => {
    expect(findTable(snap, 'SHOP', 'lower_tab')?.obj.pk).toEqual(['id']);
    expect(findTable(snap, 'SHOP', 'LOWER_TAB')?.obj.pk).toEqual(['ID']);
    expect(findTable(snap, null, 'TYPES')?.schema).toBe('SHOP');
    expect(findTable(snap, null, 'TYPES', 'OTHER')?.schema).toBe('OTHER');
  });

  it('console results: SELECT t.*, ROWID edits a keyless table; SELECT * says how', () => {
    const ok = resultEditability([A, B, ROWID], { singleSelect: true, snapshot: snap, conn: undefined, dialect: 'plsql', currentSchema: 'SHOP' });
    expect(ok.target).toMatchObject({ keyColumns: ['ROWID'], rowid: true });
    const no = resultEditability([A, B], { singleSelect: true, snapshot: snap, conn: undefined, dialect: 'plsql', currentSchema: 'SHOP' });
    expect(no.reason).toBe('NOPK has no primary key: select ROWID too (SELECT t.*, ROWID FROM …) to edit');
    // The console's CURRENT_SCHEMA decides where an unqualified table lives, and stays the default schema of the SQL.
    const other = resultEditability([col('OID', 'int', 'NUMBER', 'TYPES')], { singleSelect: true, snapshot: snap, conn: undefined, dialect: 'plsql', currentSchema: 'OTHER' });
    expect(other.target).toMatchObject({ schema: 'OTHER', name: 'TYPES', keyColumns: ['OID'], defaultSchema: 'OTHER' });
    expect(resultEditability([A, B, ROWID], { singleSelect: true, snapshot: snap, conn: { readOnly: true } as never, dialect: 'plsql' }).reason).toBe('Read-only connection');
  });
});

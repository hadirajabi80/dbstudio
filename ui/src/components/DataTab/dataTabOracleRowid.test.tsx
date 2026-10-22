// Oracle table without a primary key in a Data tab: every page also reads ROWID (hidden last column), the grid is
// editable with ROWID as the row identity, and a save updates exactly that row (like SQL Developer / Navicat).
// The canvas grid is replaced by a probe; the SQL runner plays the Oracle server.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import type { ViewTab } from '../../store/tabs';
import type { DataGridProps } from '../Grid/DataGrid';
import { DataTabView } from './DataTabView';
import { dataGridKey } from './open';
import { setSqlRunner, type QueryOutcome } from './runner';

let gridProps: DataGridProps | null = null;
vi.mock('../Grid/DataGrid', () => ({
  DataGrid: (p: DataGridProps) => {
    gridProps = p;
    return <div data-testid="grid" data-rows={p.rows.length} />;
  },
  rowValue: () => null,
}));

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number, dbType = kind.toUpperCase()): ColumnInfo => ({
  name, ordinal, dbType, kind, nullable: true, size: null, precision: null, scale: null, table: 'NOPK', schema: null, isKey: false,
});
const OWN = [col('A', 'decimal', 0, 'NUMBER'), col('B', 'string', 1, 'VARCHAR2')];
const WITH_ROWID = [...OWN, col('ROWID', 'string', 2, 'VARCHAR2')];
// Two identical rows: only ROWID tells them apart.
const ROWS: CellValue[][] = [['1', 'x', 'AAAR6DAAYAAAAAeAAA'], ['1', 'x', 'AAAR6DAAYAAAAAeAAB']];

const calls: { sql: string; params: unknown[] }[] = [];
let refuseRowid = false;

function outcome(cols: ColumnInfo[], rows: CellValue[][], extra: Partial<QueryOutcome> = {}): QueryOutcome {
  return { executionId: 'x', status: 'ok', resultSets: cols.length ? [{ columns: cols, rows, truncated: false }] : [], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 1, txOpen: false, ...extra };
}

beforeAll(async () => {
  await useConnections.getState().load();
  // The fixture's Oracle connection is read-only: editable here.
  const ora = useConnections.getState().connections.find((c) => c.id === 'c_ora')!;
  useConnections.setState({ connections: useConnections.getState().connections.map((c) => (c === ora ? { ...ora, readOnly: false } : c)) });
  setSqlRunner(async (_sid, sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('WHERE 1 = 0')) return outcome(OWN, []);
    if (sql.startsWith('SELECT COUNT(*)')) return outcome([col('ROW_COUNT', 'int', 0)], [[2]]);
    if (sql.startsWith('UPDATE')) return outcome([], [], { affected: 1, affectedReported: true, txOpen: true });
    if (sql.startsWith('SELECT SHOP.NOPK.*, ROWID') && sql.includes('WHERE ROWID')) return outcome(WITH_ROWID, [['1', 'y', 'AAAR6DAAYAAAAAeAAB']]);
    if (sql.startsWith('SELECT SHOP.NOPK.*, ROWID')) {
      if (refuseRowid) return outcome([], [], { status: 'error', error: { message: 'ORA-01445: cannot select ROWID from a join view', code: 'ORA-01445', line: 1 } });
      return outcome(WITH_ROWID, ROWS);
    }
    if (sql.startsWith('SELECT *')) return outcome(OWN, ROWS.map((r) => r.slice(0, 2)));
    return outcome([], []);
  });
});
afterAll(() => setSqlRunner(null));
beforeEach(() => {
  cleanup();
  calls.length = 0;
  gridProps = null;
  refuseRowid = false;
  useSessions.setState({ sessions: {}, byTab: {} });
  // NOPK is not in the mock catalog: no primary key is known.
  useCatalog.setState({ dbs: {} });
  vi.spyOn(api, 'catalog').mockRejectedValue(new Error('catalog unavailable'));
  vi.spyOn(api, 'objectDetails').mockResolvedValue({ indexes: [] } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const tab = (id: string): ViewTab => ({
  kind: 'view', id, title: 'NOPK', view: 'data', connectionId: 'c_ora', database: null, state: { schema: 'SHOP', name: 'NOPK', type: 'table' },
});
const pages = () => calls.map((c) => c.sql).filter((s) => s.includes('FETCH NEXT'));

describe('Oracle keyless table: ROWID row identity', () => {
  it('reads ROWID as a hidden column, is editable, and saves one of two identical rows by its ROWID', async () => {
    render(<DataTabView tab={tab('ora-rowid')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 2);
    // (No catalog: the login schema is unknown, so the table is schema-qualified.)
    expect(pages()[0]).toBe('SELECT SHOP.NOPK.*, ROWID\nFROM SHOP.NOPK\nORDER BY ROWID\nOFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY');
    // The grid shows the table's own columns only; the rows still carry the ROWID for the edit statements.
    expect(gridProps!.columns.map((c) => c.name)).toEqual(['A', 'B']);
    expect(gridProps!.editability?.editable).toBe(true);
    expect(gridProps!.editability?.target?.keyColumns).toEqual(['ROWID']);
    expect([...gridProps!.editability!.editableColumns]).toEqual([0, 1]);
    expect(screen.getByText('Editable')).toBeInTheDocument();

    const key = dataGridKey('ora-rowid');
    act(() => useEdits.getState().setCell(key, 1, 1, 'y', 'x'));
    await act(async () => {
      gridProps!.onSubmit!();
    });
    await until(() => calls.some((c) => c.sql.startsWith('UPDATE')));
    const upd = calls.find((c) => c.sql.startsWith('UPDATE'))!;
    // The tab session's CURRENT_SCHEMA is SHOP: the table needs no qualifier any more.
    expect(upd.sql).toBe('UPDATE NOPK SET B = :p1 WHERE ROWID = :p2');
    expect(upd.params).toEqual([{ name: 'p1', kind: 'string', value: 'y' }, { name: 'p2', kind: 'string', value: 'AAAR6DAAYAAAAAeAAB' }]);
    // The saved row is read back by ROWID too.
    await until(() => calls.some((c) => c.sql.includes('WHERE ROWID = :k1')));
    expect(calls.find((c) => c.sql.includes('WHERE ROWID = :k1'))!.sql).toBe('SELECT NOPK.*, ROWID\nFROM NOPK\nWHERE ROWID = :k1');
  });

  it('an object that cannot give a ROWID is read without it, read-only', async () => {
    refuseRowid = true;
    render(<DataTabView tab={tab('ora-norowid')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 2);
    expect(pages()).toEqual([
      'SELECT SHOP.NOPK.*, ROWID\nFROM SHOP.NOPK\nORDER BY ROWID\nOFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY',
      'SELECT *\nFROM SHOP.NOPK\nORDER BY ROWID\nOFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY',
    ]);
    expect(gridProps!.editability?.editable).toBe(false);
    expect(screen.getByText('No primary key: read-only')).toBeInTheDocument();
  });
});

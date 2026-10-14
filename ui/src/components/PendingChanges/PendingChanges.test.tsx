import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { useGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { pendingCount, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { PendingChangesDialog } from './PendingChanges';
import { buildStatements, submitChanges, type EditContext } from './submit';

const mock = useGridMockEngine({ frameDelay: 0 }, true);

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'people', schema: 'main', isKey: name === 'Id',
});
const COLUMNS = [col('Id', 'int', 0), col('Name', 'string', 1), col('Total', 'decimal', 2)];
const KEY = 'pc-test';

function seed(): CellValue[][] {
  return [[1, 'Ada', '10.5'], [2, 'Grace', '20'], [3, 'Linus', null]];
}

let base: CellValue[][] = seed();
function ctx(): EditContext {
  return {
    gridKey: KEY, tabId: 'tab-pc', connectionId: 'c_shop', database: null, dialect: 'sqlite',
    target: { schema: 'main', name: 'people', keyColumns: ['Id'], identityColumns: ['Id'], defaultSchema: 'main' },
    columns: COLUMNS, rowAt: (i) => base[i], sourceLength: base.length, sqliteVersion: '3.46.1',
  };
}

describe('pending changes: preview → submit in a transaction → refetch', () => {
  beforeAll(async () => {
    await useConnections.getState().load();
  });
  beforeEach(() => {
    base = seed();
    mock.ctx.engine.addTable('people', { columns: COLUMNS, rows: seed().map((r) => [...r]), key: 'Id' });
    mock.ctx.engine.conflictOn = null;
    mock.ctx.engine.log = [];
    useEdits.getState().reset(KEY);
    useSessions.setState({ sessions: {}, byTab: {} });
  });

  it('shows the generated SQL per change with values as parameters', () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    s.setCell(KEY, 0, 2, '11', '10.5');
    s.toggleDelete(KEY, [2]);
    const id = s.addInsert(KEY, 3);
    s.setInsertCell(KEY, id, 1, 'Barbara');
    render(<PendingChangesDialog ctx={ctx()} onClose={() => {}} />);
    expect(screen.getByText('DELETE FROM people WHERE Id = 3')).toBeInTheDocument();
    expect(screen.getByText("UPDATE people SET Name = 'Ada L.', Total = 11 WHERE Id = 1")).toBeInTheDocument();
    expect(screen.getByText("INSERT INTO people (Name) VALUES ('Barbara') RETURNING Id")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show parameters'));
    expect(screen.getByText('UPDATE people SET Name = @p1, Total = @p2 WHERE Id = @p3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit \(3\)/ })).toBeEnabled();
  });

  it('edit 2 cells in one row → one UPDATE with 2 SET items', () => {
    const s = useEdits.getState();
    s.setCell(KEY, 1, 1, 'G', 'Grace');
    s.setCell(KEY, 1, 2, '1', '20');
    const st = buildStatements(ctx(), useEdits.getState().get(KEY).pending, false);
    expect(st).toHaveLength(1);
    expect(st[0].sql).toBe('UPDATE people SET Name = @p1, Total = @p2 WHERE Id = @p3');
  });

  it('submits, commits, refetches identities and clears the buffer', async () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    s.toggleDelete(KEY, [2]);
    const id = s.addInsert(KEY, 3);
    s.setInsertCell(KEY, id, 1, 'Barbara');
    const r = await submitChanges(ctx(), { verifyUnchanged: false });
    expect(r).toMatchObject({ ok: true, executed: 3, error: null });
    const t = mock.ctx.engine.tables.get('people')!;
    expect(t.rows.map((x) => x[1])).toEqual(['Ada L.', 'Grace', 'Barbara']);
    const b = useEdits.getState().get(KEY);
    expect(pendingCount(b.pending)).toBe(0);
    expect(b.committed.patched[0]).toEqual([1, 'Ada L.', '10.5']);
    expect(b.committed.hidden).toEqual({ 2: true });
    expect(b.committed.appended).toEqual([[4, 'Barbara', null]]);
    // values travelled as binds; no literal in the SQL
    const upd = mock.ctx.engine.log.find((l) => l.sql.startsWith('UPDATE'))!;
    expect(upd.sql).not.toContain('Ada L.');
    expect(upd.params).toEqual([{ name: 'p1', kind: 'string', value: 'Ada L.' }, { name: 'p2', kind: 'int', value: 1 }]);
    // tx: manual mode for the submit, commit, then back to auto
    expect(mock.hits('/tx-mode', 'POST')).toHaveLength(2);
    expect(mock.hits('/commit', 'POST')).toHaveLength(1);
    expect(mock.hits('/rollback', 'POST')).toHaveLength(0);
  });

  it('a failing statement rolls back and keeps the buffer', async () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'x', 'Ada');
    const id = s.addInsert(KEY, 3);
    s.setInsertCell(KEY, id, 1, 'fail');
    const r = await submitChanges(ctx(), { verifyUnchanged: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/INSERT failed: NOT NULL constraint failed/);
    expect(mock.hits('/rollback', 'POST')).toHaveLength(1);
    const b = useEdits.getState().get(KEY);
    expect(pendingCount(b.pending)).toBe(2);
    expect(b.issues[0]).toMatchObject({ ref: id, kind: 'error' });
  });

  it('conflict mode: 0 rows affected is reported as a conflict; overwrite submits without verification', async () => {
    useEdits.getState().setCell(KEY, 1, 1, 'Grace H.', 'Grace');
    mock.ctx.engine.conflictOn = /AND Name = @p3/;
    render(<PendingChangesDialog ctx={ctx()} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Verify unchanged values/));
    expect(screen.getByText("UPDATE people SET Name = 'Grace H.' WHERE Id = 2 AND Name = 'Grace'")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    });
    await until(() => useEdits.getState().get(KEY).issues.length > 0);
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed or deleted by someone else/);
    expect(mock.hits('/rollback', 'POST').length).toBeGreaterThan(0);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Overwrite/ }));
    });
    await until(() => pendingCount(useEdits.getState().get(KEY).pending) === 0);
    expect(mock.ctx.engine.tables.get('people')!.rows[1][1]).toBe('Grace H.');
  });

  it('empty state', () => {
    render(<PendingChangesDialog ctx={ctx()} onClose={() => {}} />);
    expect(screen.getByText('Edit a cell to start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit/ })).toBeDisabled();
  });
});

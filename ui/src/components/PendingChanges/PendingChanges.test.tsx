import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { pendingCount, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { PendingChangesDialog } from './PendingChanges';
import { runSql, setSqlRunner } from '../DataTab/runner';
import { buildStatements, submitChanges, type EditContext } from './submit';

const mock = installGridMockEngine({ frameDelay: 0 }, true);

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
    expect(screen.getByRole('button', { name: /Save \(3\)/ })).toBeEnabled();
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
      fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
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

  it('manual mode with an open transaction: a failing UPDATE rolls back only to the savepoint (code-01)', async () => {
    // The mock engine has no savepoints: record them and let everything else run on the mock.
    const seen: string[] = [];
    setSqlRunner(async (sid, sql, params, opts) => {
      seen.push(sql);
      if (/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) dbs_edit$/.test(sql)) {
        return { executionId: null, status: 'ok', resultSets: [], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 0, txOpen: true };
      }
      return runSql(sid, sql, params, opts);
    });
    try {
      // The console is in manual mode and the user already changed a row without committing.
      const s = await useSessions.getState().ensure('tab-pc', 'c_shop', null, 'manual');
      const own = await runSql(s.sessionId, 'UPDATE people SET Name = @p1 WHERE Id = @p2', [{ name: 'p1', kind: 'string', value: 'Ada (mine)' }, { name: 'p2', kind: 'int', value: 1 }]);
      expect(own.txOpen).toBe(true);
      await until(() => useSessions.getState().forTab('tab-pc')?.txOpen === true);
      mock.ctx.engine.log = [];
      seen.length = 0;

      // Now a grid edit that conflicts (0 rows affected).
      useEdits.getState().setCell(KEY, 1, 1, 'Grace H.', 'Grace');
      mock.ctx.engine.conflictOn = /WHERE Id = @p2$/;
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/affected 0 rows.*earlier uncommitted changes/);
      expect(seen).toEqual(['SAVEPOINT dbs_edit', 'UPDATE people SET Name = @p1 WHERE Id = @p2', 'ROLLBACK TO SAVEPOINT dbs_edit']);
      // No full ROLLBACK and no tx-mode switch: the user's own uncommitted UPDATE survives in the open transaction.
      expect(mock.hits('/rollback', 'POST')).toHaveLength(0);
      expect(mock.hits('/tx-mode', 'POST')).toHaveLength(0);
      expect(mock.ctx.engine.log.some((l) => /^ROLLBACK$/i.test(l.sql.trim()))).toBe(false);
      expect(mock.ctx.engine.tables.get('people')!.rows[0][1]).toBe('Ada (mine)');
      expect(useSessions.getState().forTab('tab-pc')?.txOpen).toBe(true);
      expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(1);
    } finally {
      setSqlRunner(null);
    }
  });

  it('T-SQL insert: the new key comes back from SELECT * FROM @ins and drives the refetch (features-10)', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const ok = (resultSets: { columns: ColumnInfo[]; rows: CellValue[][]; truncated: boolean }[] = []) => ({
      executionId: null, status: 'ok' as const, resultSets, affected: 1, affectedReported: true, error: null, messages: [], outParams: [], elapsedMs: 0, txOpen: true,
    });
    setSqlRunner(async (_sid, sql, params) => {
      seen.push({ sql, params });
      if (sql.startsWith('DECLARE @ins')) return ok([{ columns: [{ ...COLUMNS[0], dbType: 'int' }], rows: [[42]], truncated: false }]);
      if (sql.startsWith('SELECT')) return ok([{ columns: COLUMNS, rows: [[42, 'Barbara', null]], truncated: false }]);
      return ok();
    });
    try {
      const id = useEdits.getState().addInsert(KEY, 3);
      useEdits.getState().setInsertCell(KEY, id, 1, 'Barbara');
      const tctx: EditContext = {
        ...ctx(), dialect: 'tsql',
        target: { schema: 'dbo', name: 'people', keyColumns: ['Id'], identityColumns: ['Id'], defaultSchema: 'dbo' },
        columns: COLUMNS.map((c) => (c.name === 'Id' ? { ...c, dbType: 'int' } : c)),
      };
      const r = await submitChanges(tctx, { verifyUnchanged: false });
      expect(r).toMatchObject({ ok: true, executed: 1 });
      expect(seen[0].sql).toBe('DECLARE @ins TABLE (Id int);\nINSERT INTO dbo.people (Name) OUTPUT INSERTED.Id INTO @ins VALUES (@p1);\nSELECT * FROM @ins;');
      const refetch = seen.find((s) => s.sql.startsWith('SELECT'))!;
      expect(JSON.stringify(refetch.params)).toContain('42');
      expect(useEdits.getState().get(KEY).committed.appended).toEqual([[42, 'Barbara', null]]);
    } finally {
      setSqlRunner(null);
    }
  });

  it('auto mode: the submit opened the transaction, so a failure is a full ROLLBACK', async () => {
    useEdits.getState().setCell(KEY, 1, 1, 'Grace H.', 'Grace');
    mock.ctx.engine.conflictOn = /WHERE Id = @p2$/;
    const r = await submitChanges(ctx(), { verifyUnchanged: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Nothing was saved\.$/);
    expect(mock.hits('/rollback', 'POST')).toHaveLength(1);
    expect(mock.ctx.engine.log.some((l) => /SAVEPOINT/.test(l.sql))).toBe(false);
  });

  it('empty state', () => {
    render(<PendingChangesDialog ctx={ctx()} onClose={() => {}} />);
    expect(screen.getByText('Edit a cell to start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();
  });
});

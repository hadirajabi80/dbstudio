// code-r1-01: a grid save in a manual-mode console with no open transaction (fresh console, or just after Commit).
// No savepoint is set (outside a transaction it protects nothing: SQL Server refuses SAVE TRANSACTION, SQLite's
// RELEASE would commit), a failure is a full rollback as in auto mode, the session stays in manual mode, and "the
// transaction is still open" is said only when the engine reports it open.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { pendingCount, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { DEFAULT_SETTINGS, useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { runSql, setSqlRunner, type QueryOutcome, type SqlRunner } from '../DataTab/runner';
import { savePendingChanges } from './save';
import { submitChanges, type EditContext } from './submit';

const mock = installGridMockEngine({ frameDelay: 0 }, true);

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'people', schema: 'main', isKey: name === 'Id',
});
const COLUMNS = [col('Id', 'int', 0), col('Name', 'string', 1), col('Total', 'decimal', 2)];
const KEY = 'pc-manual';
const TAB = 'tab-manual';
const seed = (): CellValue[][] => [[1, 'Ada', '10.5'], [2, 'Grace', '20'], [3, 'Linus', null]];
let base: CellValue[][] = seed();

function ctx(): EditContext {
  return {
    gridKey: KEY, tabId: TAB, connectionId: 'c_shop', database: null, dialect: 'sqlite',
    target: { schema: 'main', name: 'people', keyColumns: ['Id'], identityColumns: ['Id'], defaultSchema: 'main' },
    columns: COLUMNS, rowAt: (i) => base[i], sourceLength: base.length, sqliteVersion: '3.46.1',
  };
}

const SAVEPOINT_SQL = /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT|SAVE TRANSACTION|ROLLBACK TRANSACTION) dbs_edit/i;
const toasts = () => useUi.getState().toasts;
const lastToast = () => toasts()[toasts().length - 1];

/** Records every statement the submit runs; `patch` may rewrite an outcome (e.g. what the engine says about txOpen). */
function recordRunner(seen: string[], patch?: (sql: string, out: QueryOutcome) => QueryOutcome): SqlRunner {
  return async (sid, sql, params, opts) => {
    seen.push(sql);
    const out = await runSql(sid, sql, params, opts);
    return patch ? patch(sql, out) : out;
  };
}

/** A manual-mode console session with nothing pending (as after a fresh open or a Commit). */
async function manualIdleSession() {
  const s = await useSessions.getState().ensure(TAB, 'c_shop', null, 'manual');
  expect(s.txMode).toBe('manual');
  expect(s.txOpen).toBe(false);
  mock.ctx.requests.length = 0;
  return s;
}

describe('grid submit: manual mode with no open transaction (code-r1-01)', () => {
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
    useUi.setState({ toasts: [] });
    useSettings.setState({ settings: { ...useSettings.getState().settings, grid: { ...DEFAULT_SETTINGS.grid } } });
  });

  it('sets no savepoint before the first DML and a failure is a full rollback, staying in manual mode', async () => {
    const seen: string[] = [];
    try {
      await manualIdleSession();
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      useEdits.getState().setCell(KEY, 1, 1, 'Grace H.', 'Grace');
      // The second UPDATE affects 0 rows (conflict) after the first one already ran.
      let calls = 0;
      setSqlRunner(recordRunner(seen, (sql, out) => (sql.startsWith('UPDATE') && ++calls === 2 ? { ...out, affected: 0, affectedReported: true } : out)));
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r.ok).toBe(false);
      expect(r.leftOpen).toBe(false);
      expect(r.error).toMatch(/affected 0 rows.*Nothing was saved\.$/);
      expect(r.error).not.toMatch(/earlier uncommitted changes/);
      expect(seen.some((s) => SAVEPOINT_SQL.test(s))).toBe(false);
      expect(seen.filter((s) => s.startsWith('UPDATE'))).toHaveLength(2);
      expect(seen[0]).toMatch(/^UPDATE people/);
      // Full rollback of what this submit ran; no tx-mode switch either way.
      expect(mock.hits('/rollback', 'POST')).toHaveLength(1);
      expect(mock.hits('/tx-mode', 'POST')).toHaveLength(0);
      expect(mock.hits('/commit', 'POST')).toHaveLength(0);
      await until(() => useSessions.getState().forTab(TAB)?.txOpen === false);
      expect(useSessions.getState().forTab(TAB)?.txMode).toBe('manual');
      expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(2);
    } finally {
      setSqlRunner(null);
    }
  });

  it('a failing statement rolls the whole submit back (no ROLLBACK TO a savepoint that never existed)', async () => {
    const seen: string[] = [];
    setSqlRunner(recordRunner(seen));
    try {
      await manualIdleSession();
      const id = useEdits.getState().addInsert(KEY, 3);
      useEdits.getState().setInsertCell(KEY, id, 1, 'fail');
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/INSERT failed: NOT NULL constraint failed.*Nothing was saved\./);
      expect(seen.some((s) => SAVEPOINT_SQL.test(s))).toBe(false);
      expect(mock.hits('/rollback', 'POST')).toHaveLength(1);
      expect(mock.hits('/tx-mode', 'POST')).toHaveLength(0);
      expect(useEdits.getState().get(KEY).issues[0]).toMatchObject({ ref: id, kind: 'error' });
    } finally {
      setSqlRunner(null);
    }
  });

  it('success: no commit, the changes wait in the transaction the engine reports open', async () => {
    const seen: string[] = [];
    setSqlRunner(recordRunner(seen));
    try {
      await manualIdleSession();
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      const r = await savePendingChanges(ctx(), { preview: () => {} });
      expect(r).toMatchObject({ ok: true, executed: 1, leftOpen: true });
      expect(seen.some((s) => SAVEPOINT_SQL.test(s))).toBe(false);
      expect(mock.hits('/commit', 'POST')).toHaveLength(0);
      expect(mock.hits('/tx-mode', 'POST')).toHaveLength(0);
      expect(lastToast()).toMatchObject({ kind: 'success', detail: 'The transaction is still open: commit to keep the changes.' });
      await until(() => useSessions.getState().forTab(TAB)?.txOpen === true);
    } finally {
      setSqlRunner(null);
    }
  });

  it('rows left in the open transaction are remembered for a later Rollback (features-r2-01)', async () => {
    setSqlRunner(recordRunner([]));
    try {
      const s = await manualIdleSession();
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      useEdits.getState().setCell(KEY, 1, 1, 'Grace H.', 'Grace');
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r).toMatchObject({ ok: true, leftOpen: true });
      expect(useEdits.getState().get(KEY).savedInTx).toEqual({ sessionId: s.sessionId, rows: 2 });
      await until(() => useSessions.getState().forTab(TAB)?.txOpen === true);
      await useSessions.getState().rollback(TAB);
      expect(useSessions.getState().lastTxEnd).toMatchObject({ sessionId: s.sessionId, kind: 'rollback' });
      useEdits.getState().applyTxEnd(useSessions.getState().lastTxEnd!);
      expect(useEdits.getState().get(KEY)).toMatchObject({ savedInTx: null, rolledBack: { rows: 2 } });
    } finally {
      setSqlRunner(null);
    }
  });

  it('auto mode commits at once: nothing is remembered', async () => {
    setSqlRunner(recordRunner([]));
    try {
      await useSessions.getState().ensure(TAB, 'c_shop', null, 'auto');
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r).toMatchObject({ ok: true, leftOpen: false });
      expect(useEdits.getState().get(KEY).savedInTx).toBeNull();
    } finally {
      setSqlRunner(null);
    }
  });

  it('"the transaction is still open" only when the engine says so', async () => {
    // An engine that ended the transaction (e.g. an older engine whose RELEASE committed it): txOpen false.
    const seen: string[] = [];
    setSqlRunner(recordRunner(seen, (_sql, out) => ({ ...out, txOpen: false })));
    try {
      await manualIdleSession();
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      const r = await savePendingChanges(ctx(), { preview: () => {} });
      expect(r).toMatchObject({ ok: true, executed: 1, leftOpen: false });
      const t = lastToast();
      expect(t.kind).toBe('success');
      expect(t.detail ?? '').not.toMatch(/still open/);
    } finally {
      setSqlRunner(null);
    }
  });

  it('manual mode with an open transaction still uses the savepoint, and leftOpen follows the engine after RELEASE', async () => {
    const seen: string[] = [];
    // The mock engine has no savepoints: answer them here; RELEASE reports the transaction ended.
    setSqlRunner(async (sid, sql, params, opts) => {
      seen.push(sql);
      if (SAVEPOINT_SQL.test(sql)) {
        return {
          executionId: null, status: 'ok', resultSets: [], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 0,
          txOpen: !/^RELEASE/.test(sql),
        };
      }
      return runSql(sid, sql, params, opts);
    });
    try {
      const s = await useSessions.getState().ensure(TAB, 'c_shop', null, 'manual');
      await runSql(s.sessionId, 'UPDATE people SET Name = @p1 WHERE Id = @p2', [{ name: 'p1', kind: 'string', value: 'mine' }, { name: 'p2', kind: 'int', value: 3 }]);
      await until(() => useSessions.getState().forTab(TAB)?.txOpen === true);
      seen.length = 0;
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r.ok).toBe(true);
      expect(seen[0]).toBe('SAVEPOINT dbs_edit');
      expect(seen).toContain('RELEASE SAVEPOINT dbs_edit');
      // The refetch SELECT after RELEASE does not count: leftOpen is what RELEASE reported.
      expect(r.leftOpen).toBe(false);
    } finally {
      setSqlRunner(null);
    }
  });

  /** Savepoint statements answered here (the mock engine has none); `rollbackTo` overrides the ROLLBACK TO outcome. */
  function savepointRunner(seen: string[], rollbackTo: Partial<QueryOutcome> = {}): SqlRunner {
    return async (sid, sql, params, opts) => {
      seen.push(sql);
      if (SAVEPOINT_SQL.test(sql)) {
        return {
          executionId: null, status: 'ok', resultSets: [], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 0,
          txOpen: true, ...(/^ROLLBACK TO/.test(sql) ? rollbackTo : {}),
        };
      }
      return runSql(sid, sql, params, opts);
    };
  }

  async function openTransaction() {
    const s = await useSessions.getState().ensure(TAB, 'c_shop', null, 'manual');
    await runSql(s.sessionId, 'UPDATE people SET Name = @p1 WHERE Id = @p2', [{ name: 'p1', kind: 'string', value: 'mine' }, { name: 'p2', kind: 'int', value: 3 }]);
    await until(() => useSessions.getState().forTab(TAB)?.txOpen === true);
    return s.sessionId;
  }

  it('a failure inside the open transaction rolls back to the savepoint and releases it on SQLite (features-r2-01)', async () => {
    const seen: string[] = [];
    setSqlRunner(savepointRunner(seen));
    try {
      await openTransaction();
      seen.length = 0;
      const id = useEdits.getState().addInsert(KEY, 3);
      useEdits.getState().setInsertCell(KEY, id, 1, 'fail');
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/the open transaction keeps your earlier uncommitted changes/);
      const sp = seen.filter((x) => SAVEPOINT_SQL.test(x));
      // Released after ROLLBACK TO, so repeated failures do not nest savepoints.
      expect(sp).toEqual(['SAVEPOINT dbs_edit', 'ROLLBACK TO SAVEPOINT dbs_edit', 'RELEASE SAVEPOINT dbs_edit']);
      expect(mock.hits('/rollback', 'POST')).toHaveLength(0);
    } finally {
      setSqlRunner(null);
    }
  });

  it('a server that ended the whole transaction instead flags the rows other grids saved into it', async () => {
    const seen: string[] = [];
    setSqlRunner(savepointRunner(seen, { status: 'error', error: { code: 'SQL_ERROR', message: 'no such savepoint' }, txOpen: false } as Partial<QueryOutcome>));
    try {
      const sid = await openTransaction();
      useEdits.getState().noteSavedInTx('other-grid', sid, 3);
      const id = useEdits.getState().addInsert(KEY, 3);
      useEdits.getState().setInsertCell(KEY, id, 1, 'fail');
      const r = await submitChanges(ctx(), { verifyUnchanged: false });
      expect(r.error).toMatch(/rolled back the whole open transaction/);
      expect(seen).not.toContain('RELEASE SAVEPOINT dbs_edit');
      expect(useEdits.getState().get('other-grid')).toMatchObject({ savedInTx: null, rolledBack: { rows: 3 } });
    } finally {
      setSqlRunner(null);
      useEdits.getState().reset('other-grid');
    }
  });
});

import { http, HttpResponse } from 'msw';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind, ExecuteRequest } from '../../api/types';
import { newCondition, newGroup } from '../../filter/model';
import { useGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { useFilters } from '../../store/filters';
import { useResults, viewKey } from '../../store/results';
import { createExecution } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import { applyServerFilter, originalBatch, serverFilterAvailability } from './serverFilter';

const mock = useGridMockEngine();
const bodies: ExecuteRequest[] = [];

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'orders', schema: 'dbo', isKey: false,
});
const COLS = [col('Id', 'int', 0), col('Total', 'decimal', 1)];

function seedExec(tabId: string, sql: string) {
  const localId = `l-${tabId}-${Math.random()}`;
  const e = createExecution({ localId, tabId, connectionId: 'c_prod', sessionId: null, label: 'statement', batches: [{ sql, line: 3, col: 1 }], maxRows: 1000 });
  useResults.getState().begin({ ...e, status: 'ok', resultSets: [{ id: 0, batchIndex: 0, columns: COLS, rows: { length: 0 } as never, rowCount: 0, truncated: false, elapsedMs: 1, done: true, rev: 1 }] });
  return useResults.getState().executions[localId];
}

describe('apply filter on server (console results)', () => {
  beforeAll(async () => {
    mock.server.use(http.post('*/api/v1/sessions/:sid/execute', async ({ request }) => {
      bodies.push((await request.json()) as ExecuteRequest);
      return HttpResponse.json({ executionId: `x${bodies.length}`, startedAt: new Date().toISOString() }, { status: 202 });
    }));
    await useConnections.getState().load();
  });

  it('is available for a single SELECT, not for scripts or procedures', () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_prod' });
    expect(serverFilterAvailability(seedExec(tab, 'SELECT * FROM dbo.Orders ORDER BY Total DESC'), COLS, 'tsql').available).toBe(true);
    expect(serverFilterAvailability(seedExec(tab, 'EXEC dbo.GetCustomer 1'), COLS, 'tsql')).toMatchObject({ available: false });
    expect(serverFilterAvailability(seedExec(tab, 'SELECT * FROM a JOIN b ON 1=1'), [col('Id', 'int', 0), col('Id', 'int', 1)], 'tsql').reason).toMatch(/appears twice/);
  });

  it('re-runs the rewritten statement with parameters as a "filter" execution, and keeps the original for re-filtering', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_prod' });
    await useSessions.getState().ensure(tab, 'c_prod', null, 'auto');
    const exec = seedExec(tab, 'SELECT * FROM dbo.Orders ORDER BY Total DESC');
    const filter = newGroup('and', [newCondition('Total', 'gt', ['100'])]);
    await applyServerFilter(exec, COLS, 'tsql', filter, '', []);
    await until(() => bodies.length === 1);
    expect(bodies[0]).toMatchObject({
      label: 'filter', maxRows: 1000,
      batches: [{ sql: 'SELECT * FROM (\n  SELECT * FROM dbo.Orders\n) AS q\nWHERE q.Total > @fp1\nORDER BY q.Total DESC', line: 3, col: 1 }],
      params: [{ name: 'fp1', kind: 'int', value: 100 }],
    });
    expect(bodies[0].batches[0].sql).not.toContain('100');
    const sf = useFilters.getState().serverFilters[tab];
    expect(sf.original.sql).toBe('SELECT * FROM dbo.Orders ORDER BY Total DESC');
    const next = useResults.getState().executions[useResults.getState().byTab[tab]];
    expect(originalBatch(next)!.sql).toBe('SELECT * FROM dbo.Orders ORDER BY Total DESC');
    expect(useResults.getState().views[viewKey(next.localId, 0)].filter).toBe(filter);

    // Clearing re-runs the original.
    await applyServerFilter(next, COLS, 'tsql', null, '', [], true);
    await until(() => bodies.length === 2);
    expect(bodies[1].batches[0].sql).toBe('SELECT * FROM dbo.Orders ORDER BY Total DESC');
    expect(bodies[1].params ?? []).toEqual([]);
    expect(useFilters.getState().serverFilters[tab]).toBeUndefined();
  });
});

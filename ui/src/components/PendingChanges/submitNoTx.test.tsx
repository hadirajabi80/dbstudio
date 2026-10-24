// Grid edits on databases without transactions (Cassandra, ClickHouse): statements run one by one on the session in
// auto mode (no manual mode, no commit, no savepoint); after a failure the message says which ones stayed applied.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind, Dialect } from '../../api/types';
import { installGridMockEngine } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { pendingCount, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { submitChanges, type EditContext } from './submit';

const mock = installGridMockEngine({ frameDelay: 0 }, true);

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'people', schema: 'main', isKey: name === 'Id',
});
const COLUMNS = [col('Id', 'int', 0), col('Name', 'string', 1), col('Total', 'decimal', 2)];
const KEY = 'pc-notx';
const seed = (): CellValue[][] => [[1, 'Ada', '10.5'], [2, 'Grace', '20'], [3, 'Linus', null]];
let base: CellValue[][] = seed();

function ctx(dialect: Dialect): EditContext {
  return {
    gridKey: KEY, tabId: 'tab-notx', connectionId: 'c_shop', database: null, dialect,
    target: { schema: 'main', name: 'people', keyColumns: ['Id'], identityColumns: ['Id'], defaultSchema: 'main' },
    columns: COLUMNS, rowAt: (i) => base[i], sourceLength: base.length, sqliteVersion: '3.46.1',
  };
}

describe.each(['cql', 'clickhouse'] as const)('%s: grid submit without transactions', (dialect) => {
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

  it('runs every statement without touching the transaction mode, then refetches', async () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    s.toggleDelete(KEY, [2]);
    const r = await submitChanges(ctx(dialect), { verifyUnchanged: false });
    expect(r).toMatchObject({ ok: true, executed: 2, error: null, leftOpen: false });
    expect(mock.hits('/tx-mode', 'POST')).toHaveLength(0);
    expect(mock.hits('/commit', 'POST')).toHaveLength(0);
    expect(mock.hits('/rollback', 'POST')).toHaveLength(0);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
  });

  it('a failure keeps the buffer and names the statements that stayed applied', async () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'x', 'Ada');
    const id = s.addInsert(KEY, 3);
    s.setInsertCell(KEY, id, 1, 'fail');
    const r = await submitChanges(ctx(dialect), { verifyUnchanged: false });
    expect(r.ok).toBe(false);
    expect(r.executed).toBe(1);
    expect(r.error).toMatch(/INSERT failed/);
    expect(r.error).toMatch(/1 earlier statement\(s\) stayed applied.*UPDATE of row 1/);
    expect(mock.hits('/rollback', 'POST')).toHaveLength(0);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(2);
  });

  it('a failure of the first statement says nothing was saved', async () => {
    const s = useEdits.getState();
    const id = s.addInsert(KEY, 3);
    s.setInsertCell(KEY, id, 1, 'fail');
    const r = await submitChanges(ctx(dialect), { verifyUnchanged: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Nothing was saved\./);
  });
});

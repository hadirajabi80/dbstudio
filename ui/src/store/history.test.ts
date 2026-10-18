// 1.1.3 history filter chips: Connection (multi), Status, When, Only pinned; engine params + client-side safety net.
import { beforeEach, describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../api/types';
import { installMockEngine } from '../test/mockServer';
import { applyHistoryFilters, EMPTY_HISTORY_FILTERS, historyRange, useHistory } from './history';

const mock = installMockEngine();

const now = new Date('2026-10-14T15:00:00');
const h = (id: number, connectionId: string, status: HistoryEntry['status'], daysAgo: number, pinned = false): HistoryEntry => ({
  id, connectionId, database: null, sql: `select ${id}`, startedAt: new Date(now.getTime() - daysAgo * 86400000).toISOString(), durationMs: 5,
  status, rowsAffected: null, resultRows: 1, error: null, label: 'statement', pinned,
});

const LIST = [h(1, 'a', 'ok', 0), h(2, 'b', 'error', 2), h(3, 'a', 'cancelled', 10, true), h(4, 'c', 'ok', 40)];

describe('history filters', () => {
  it('filters by connection (multi), status, pinned', () => {
    expect(applyHistoryFilters(LIST, { ...EMPTY_HISTORY_FILTERS, connections: ['a', 'b'] }, now).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(applyHistoryFilters(LIST, { ...EMPTY_HISTORY_FILTERS, statuses: ['error', 'cancelled'] }, now).map((x) => x.id)).toEqual([2, 3]);
    expect(applyHistoryFilters(LIST, { ...EMPTY_HISTORY_FILTERS, pinnedOnly: true }, now).map((x) => x.id)).toEqual([3]);
  });

  it('filters by time range', () => {
    expect(applyHistoryFilters(LIST, { ...EMPTY_HISTORY_FILTERS, when: 'today' }, now).map((x) => x.id)).toEqual([1]);
    expect(applyHistoryFilters(LIST, { ...EMPTY_HISTORY_FILTERS, when: '7d' }, now).map((x) => x.id)).toEqual([1, 2]);
    expect(applyHistoryFilters(LIST, { ...EMPTY_HISTORY_FILTERS, when: '30d' }, now).map((x) => x.id)).toEqual([1, 2, 3]);
    const r = historyRange({ ...EMPTY_HISTORY_FILTERS, when: 'custom', from: '2026-10-01', to: '2026-10-05' }, now);
    expect(r.from! < r.to!).toBe(true);
  });

  beforeEach(() => mock.reset());

  it('sends status/from/pinned to GET /history', async () => {
    useHistory.getState().setFilters({ statuses: ['error'], when: '7d', pinnedOnly: true });
    await useHistory.getState().load();
    const req = mock.hits('/history').at(-1)!;
    expect(req.url.searchParams.get('status')).toBe('error');
    expect(req.url.searchParams.get('pinned')).toBe('true');
    expect(req.url.searchParams.get('from')).toBeTruthy();
    useHistory.getState().clearFilters();
  });
});

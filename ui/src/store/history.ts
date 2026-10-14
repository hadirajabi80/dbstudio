import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { HistoryEntry, HistoryStatus } from '../api/types';

/** "When" chip of the history filter (1.1.3). */
export type HistoryWhen = 'any' | 'today' | '7d' | '30d' | 'custom';

export interface HistoryFilters {
  /** Empty = all connections. */
  connections: string[];
  /** Empty = all statuses. */
  statuses: HistoryStatus[];
  when: HistoryWhen;
  /** Custom range (yyyy-mm-dd, inclusive) when `when` is 'custom'. */
  from: string | null;
  to: string | null;
  pinnedOnly: boolean;
}

export const EMPTY_HISTORY_FILTERS: HistoryFilters = { connections: [], statuses: [], when: 'any', from: null, to: null, pinnedOnly: false };

interface HistoryState {
  entries: HistoryEntry[];
  query: string;
  /** M1 single-connection filter (kept for callers; mirrors filters.connections when it has one id). */
  connectionFilter: string | null;
  filters: HistoryFilters;
  loading: boolean;
  error: string | null;
  /** Incremented to focus the search box (Ctrl+F in the history panel). */
  focusSeq: number;
  setQuery(q: string): void;
  setConnectionFilter(id: string | null): void;
  setFilters(p: Partial<HistoryFilters>): void;
  clearFilters(): void;
  requestFocus(): void;
  load(): Promise<void>;
  /** Debounced reload (after executions finish). */
  reloadSoon(): void;
  togglePin(id: number): Promise<void>;
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
}

let reqSeq = 0;
let inflight: { key: string; p: Promise<void> } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function sortEntries(list: HistoryEntry[]): HistoryEntry[] {
  return [...list].sort((a, b) => (a.pinned === b.pinned ? b.startedAt.localeCompare(a.startedAt) : a.pinned ? -1 : 1));
}

/** ISO range of the "When" chip; `now` injectable for tests. */
export function historyRange(f: HistoryFilters, now = new Date()): { from: string | null; to: string | null } {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (f.when) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: null };
    case '7d':
      return { from: new Date(startOfDay(now).getTime() - 6 * 86400000).toISOString(), to: null };
    case '30d':
      return { from: new Date(startOfDay(now).getTime() - 29 * 86400000).toISOString(), to: null };
    case 'custom': {
      const from = f.from ? new Date(`${f.from}T00:00:00`).toISOString() : null;
      const to = f.to ? new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000 - 1).toISOString() : null;
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

/**
 * Client-side application of the filters. The engine applies them too (GET /history params); this keeps the panel
 * correct with engines that ignore a parameter and for multi-connection selections (the API takes one id).
 */
export function applyHistoryFilters(list: HistoryEntry[], f: HistoryFilters, now = new Date()): HistoryEntry[] {
  const { from, to } = historyRange(f, now);
  const conns = f.connections.length ? new Set(f.connections) : null;
  const sts = f.statuses.length ? new Set(f.statuses) : null;
  return list.filter(
    (h) =>
      (!conns || conns.has(h.connectionId)) && (!sts || sts.has(h.status)) && (!f.pinnedOnly || h.pinned)
      && (!from || h.startedAt >= from) && (!to || h.startedAt <= to),
  );
}

export function activeFilterCount(f: HistoryFilters): number {
  return (f.connections.length ? 1 : 0) + (f.statuses.length ? 1 : 0) + (f.when !== 'any' ? 1 : 0) + (f.pinnedOnly ? 1 : 0);
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  query: '',
  connectionFilter: null,
  filters: EMPTY_HISTORY_FILTERS,
  loading: false,
  error: null,
  focusSeq: 0,
  setQuery(q) {
    set({ query: q });
    get().reloadSoon();
  },
  setConnectionFilter(id) {
    get().setFilters({ connections: id ? [id] : [] });
  },
  setFilters(p) {
    const filters = { ...get().filters, ...p };
    set({ filters, connectionFilter: filters.connections.length === 1 ? filters.connections[0] : null });
    void get().load();
  },
  clearFilters() {
    set({ filters: EMPTY_HISTORY_FILTERS, connectionFilter: null, query: '' });
    void get().load();
  },
  requestFocus() {
    set({ focusSeq: get().focusSeq + 1 });
  },
  async load() {
    const f = get().filters;
    const { from, to } = historyRange(f);
    // Identical request already in flight (StrictMode double effects, panel mount + reload): share it.
    const key = JSON.stringify([f, get().query, from, to]);
    if (inflight && inflight.key === key) return inflight.p;
    const my = ++reqSeq;
    set({ loading: true });
    const p = (async () => { try {
      const entries = await api.history({
        connectionId: f.connections.length === 1 ? f.connections[0] : undefined,
        q: get().query || undefined,
        limit: 200,
        status: f.statuses.length ? f.statuses : undefined,
        from,
        to,
        pinned: f.pinnedOnly || undefined,
      });
      if (my === reqSeq) set({ entries: sortEntries(applyHistoryFilters(entries, f)), loading: false, error: null });
    } catch (e) {
      if (my === reqSeq) set({ loading: false, error: errorMessage(e) });
    } finally {
      if (inflight?.key === key) inflight = null;
    } })();
    inflight = { key, p };
    return p;
  },
  reloadSoon() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void get().load(), 250);
  },
  async togglePin(id) {
    const e = get().entries.find((x) => x.id === id);
    if (!e) return;
    set({ entries: sortEntries(get().entries.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x))) });
    try {
      await api.pinHistory(id, !e.pinned);
    } catch (err) {
      set({ entries: sortEntries(get().entries.map((x) => (x.id === id ? { ...x, pinned: e.pinned } : x))) });
      throw err;
    }
  },
  async remove(id) {
    await api.deleteHistory(id);
    set({ entries: get().entries.filter((x) => x.id !== id) });
  },
  async clear() {
    await api.clearHistory(get().connectionFilter);
    await get().load();
  },
}));

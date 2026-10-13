import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { HistoryEntry } from '../api/types';

interface HistoryState {
  entries: HistoryEntry[];
  query: string;
  /** null = all connections. */
  connectionFilter: string | null;
  loading: boolean;
  error: string | null;
  setQuery(q: string): void;
  setConnectionFilter(id: string | null): void;
  load(): Promise<void>;
  /** Debounced reload (after executions finish). */
  reloadSoon(): void;
  togglePin(id: number): Promise<void>;
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
}

let reqSeq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function sortEntries(list: HistoryEntry[]): HistoryEntry[] {
  return [...list].sort((a, b) => (a.pinned === b.pinned ? b.startedAt.localeCompare(a.startedAt) : a.pinned ? -1 : 1));
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  query: '',
  connectionFilter: null,
  loading: false,
  error: null,
  setQuery(q) {
    set({ query: q });
    get().reloadSoon();
  },
  setConnectionFilter(id) {
    set({ connectionFilter: id });
    void get().load();
  },
  async load() {
    const my = ++reqSeq;
    set({ loading: true });
    try {
      const entries = await api.history({ connectionId: get().connectionFilter, q: get().query || undefined, limit: 200 });
      if (my === reqSeq) set({ entries: sortEntries(entries), loading: false, error: null });
    } catch (e) {
      if (my === reqSeq) set({ loading: false, error: errorMessage(e) });
    }
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

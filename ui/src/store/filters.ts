// Saved filters (engine `/filters`, per connection + column signature), recent filters (local) and the
// server-filter state of console result sets (PLAN-M1.5 1.1.1).
import { create } from 'zustand';
import { errorMessage } from '../api/client';
import type { SqlBatch } from '../api/types';
import { filtersApi } from '../filter/api';
import { stripOrdinals, type FilterGroup, type FilterModel } from '../filter/model';
import type { ExecParam, SavedFilter } from '../filter/wire';

const RECENT_KEY = 'dbstudio.filters.recent.v1';
const RECENT_MAX = 5;

export interface ServerFilterState {
  /** The statement as the user wrote it (re-filtering always rewrites this, never the rewritten SQL). */
  original: SqlBatch;
  /** Rewritten SQL that produced the current result. */
  sql: string;
  params: ExecParam[];
  /** Filter that was pushed (for "Server · N rows" and to clear). */
  filter: FilterGroup | null;
  quick: string;
  /** Regex remainder applied client-side on top. */
  clientOnly: FilterGroup | null;
  /** The original limits its rows: the filter only sees the first N. */
  limited: boolean;
  maxRows: number;
}

function loadRecent(): Record<string, FilterModel[]> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, FilterModel[]>) : {};
  } catch {
    return {};
  }
}

function saveRecent(r: Record<string, FilterModel[]>) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  } catch {
    /* quota / private mode */
  }
}

export const recentKey = (connectionId: string, signature: string) => `${connectionId}|${signature}`;

interface FiltersState {
  saved: Record<string, SavedFilter[]>;
  status: Record<string, 'loading' | 'ready' | 'error'>;
  error: Record<string, string>;
  recent: Record<string, FilterModel[]>;
  serverFilters: Record<string, ServerFilterState>;
  load(connectionId: string, force?: boolean): Promise<void>;
  save(connectionId: string, signature: string, name: string, model: FilterModel): Promise<SavedFilter>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  touch(id: string): void;
  pushRecent(connectionId: string, signature: string, model: FilterModel): void;
  setServerFilter(tabId: string, s: ServerFilterState | null): void;
}

export const useFilters = create<FiltersState>((set, get) => {
  const connOf = (id: string) => Object.entries(get().saved).find(([, list]) => list.some((f) => f.id === id))?.[0];
  const replace = (cid: string, fn: (l: SavedFilter[]) => SavedFilter[]) => set({ saved: { ...get().saved, [cid]: fn(get().saved[cid] ?? []) } });

  return {
    saved: {},
    status: {},
    error: {},
    recent: loadRecent(),
    serverFilters: {},

    async load(connectionId, force = false) {
      const st = get().status[connectionId];
      if (!force && (st === 'loading' || st === 'ready')) return;
      set({ status: { ...get().status, [connectionId]: 'loading' } });
      try {
        const list = await filtersApi.list(connectionId);
        set({ saved: { ...get().saved, [connectionId]: list ?? [] }, status: { ...get().status, [connectionId]: 'ready' } });
      } catch (e) {
        set({ status: { ...get().status, [connectionId]: 'error' }, error: { ...get().error, [connectionId]: errorMessage(e) } });
      }
    },

    async save(connectionId, signature, name, model) {
      const clean: FilterModel = { ...model, root: stripOrdinals(model.root) };
      const existing = (get().saved[connectionId] ?? []).find((f) => f.signature === signature && f.name.toLowerCase() === name.toLowerCase());
      const saved = existing
        ? await filtersApi.update(existing.id, { model: clean })
        : await filtersApi.create({ connectionId, signature, name, model: clean });
      replace(connectionId, (l) => [...l.filter((f) => f.id !== saved.id), saved]);
      return saved;
    },

    async rename(id, name) {
      const cid = connOf(id);
      const f = await filtersApi.update(id, { name });
      if (cid) replace(cid, (l) => l.map((x) => (x.id === id ? f : x)));
    },

    async remove(id) {
      const cid = connOf(id);
      await filtersApi.remove(id);
      if (cid) replace(cid, (l) => l.filter((x) => x.id !== id));
    },

    touch(id) {
      const cid = connOf(id);
      const now = new Date().toISOString();
      if (cid) replace(cid, (l) => l.map((x) => (x.id === id ? { ...x, lastUsedAt: now } : x)));
      void filtersApi.update(id, { lastUsedAt: now }).catch(() => undefined);
    },

    pushRecent(connectionId, signature, model) {
      if (!model.root.items.length && !model.quick) return;
      const key = recentKey(connectionId, signature);
      const clean: FilterModel = { ...model, root: stripOrdinals(model.root) };
      const sig = JSON.stringify(strip(clean));
      const list = (get().recent[key] ?? []).filter((m) => JSON.stringify(strip(m)) !== sig);
      const recent = { ...get().recent, [key]: [clean, ...list].slice(0, RECENT_MAX) };
      set({ recent });
      saveRecent(recent);
    },

    setServerFilter(tabId, s) {
      const serverFilters = { ...get().serverFilters };
      if (s) serverFilters[tabId] = s;
      else delete serverFilters[tabId];
      set({ serverFilters });
    },
  };
});

/** Model without ids, for duplicate detection. */
function strip(m: FilterModel): unknown {
  const walk = (n: FilterModel['root'] | FilterModel['root']['items'][number]): unknown =>
    n.kind === 'group' ? { l: n.logic, n: !!n.negate, i: n.items.map(walk) } : { c: n.column, o: n.op, v: n.values, s: !!n.caseSensitive, e: n.enabled !== false };
  return { r: walk(m.root), q: m.quick ?? '' };
}

/** Saved filters of a connection that match a column signature, most recently used first. */
export function savedFor(list: SavedFilter[] | undefined, signature: string): SavedFilter[] {
  return (list ?? [])
    .filter((f) => f.signature === signature)
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
}

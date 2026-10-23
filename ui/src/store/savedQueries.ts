// Saved queries per connection (Navicat's "Queries" node under each schema). Loaded once per connection the first time
// something needs them (the explorer expands the connection, the Objects tab, Ctrl+P), then kept in step by the
// create / update / delete calls made here. Tiny on purpose: the explorer and the palette import it statically.
import { create } from 'zustand';
import { errorMessage } from '../api/client';
import { savedQueriesApi, type SavedQuery, type SavedQueryInput, type SavedQueryPatch, type SavedQueryScope } from '../api/savedQueries';

export type { SavedQuery, SavedQueryScope } from '../api/savedQueries';

export interface ConnQueries {
  status: 'loading' | 'ready' | 'error';
  items: SavedQuery[];
  error?: string | null;
}

interface SavedQueriesState {
  byConn: Record<string, ConnQueries>;
  /** Loads the connection's queries unless they are loaded or loading (errors are not retried: use `load`). */
  ensure(connectionId: string): Promise<void>;
  /** (Re)loads the connection's queries. */
  load(connectionId: string): Promise<void>;
  create(connectionId: string, input: SavedQueryInput): Promise<SavedQuery>;
  update(connectionId: string, id: string, patch: SavedQueryPatch): Promise<SavedQuery>;
  duplicate(connectionId: string, id: string, name?: string): Promise<SavedQuery>;
  remove(connectionId: string, id: string): Promise<void>;
  /** The connection was deleted: drop its list. */
  forget(connectionId: string): void;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function byName(a: SavedQuery, b: SavedQuery): number {
  return collator.compare(a.name, b.name);
}

const inflight = new Map<string, Promise<void>>();

export const useSavedQueries = create<SavedQueriesState>((set, get) => {
  const put = (cid: string, items: SavedQuery[]) => {
    set({ byConn: { ...get().byConn, [cid]: { status: 'ready', items: [...items].sort(byName), error: null } } });
  };
  const upsert = (q: SavedQuery) => {
    const cur = get().byConn[q.connectionId];
    const items = cur?.items ?? [];
    put(q.connectionId, [...items.filter((x) => x.id !== q.id), q]);
  };
  return {
    byConn: {},

    ensure(cid) {
      if (get().byConn[cid]) return inflight.get(cid) ?? Promise.resolve();
      return get().load(cid);
    },

    load(cid) {
      const running = inflight.get(cid);
      if (running) return running;
      const prev = get().byConn[cid];
      set({ byConn: { ...get().byConn, [cid]: { status: prev?.status === 'ready' ? 'ready' : 'loading', items: prev?.items ?? [], error: null } } });
      const p = savedQueriesApi.list(cid)
        .then((items) => put(cid, items ?? []))
        .catch((e) => {
          set({ byConn: { ...get().byConn, [cid]: { status: 'error', items: get().byConn[cid]?.items ?? [], error: errorMessage(e) } } });
        })
        .finally(() => inflight.delete(cid));
      inflight.set(cid, p);
      return p;
    },

    async create(cid, input) {
      const q = await savedQueriesApi.create(cid, input);
      upsert(q);
      return q;
    },

    async update(cid, id, patch) {
      const q = await savedQueriesApi.update(cid, id, patch);
      upsert(q);
      return q;
    },

    async duplicate(cid, id, name) {
      const q = await savedQueriesApi.duplicate(cid, id, name);
      upsert(q);
      return q;
    },

    async remove(cid, id) {
      await savedQueriesApi.remove(cid, id);
      const cur = get().byConn[cid];
      if (cur) put(cid, cur.items.filter((x) => x.id !== id));
    },

    forget(cid) {
      if (!get().byConn[cid]) return;
      const next = { ...get().byConn };
      delete next[cid];
      set({ byConn: next });
    },
  };
});

/** Same database and schema (null and '' are the same: "none"). */
export function sameScope(a: Pick<SavedQueryScope, 'database' | 'schema'>, b: Pick<SavedQueryScope, 'database' | 'schema'>): boolean {
  return (a.database ?? '') === (b.database ?? '') && (a.schema ?? '') === (b.schema ?? '');
}

/**
 * The queries of one schema (by name). A null `schema` keeps every schema of the database (an Objects tab on a whole
 * database); `database` is always compared.
 */
export function queriesIn(items: readonly SavedQuery[] | undefined, database: string | null, schema: string | null): SavedQuery[] {
  if (!items?.length) return [];
  return items.filter((q) => (q.database ?? '') === (database ?? '') && (schema === null || (q.schema ?? '') === schema));
}

/** A loaded saved query by id (any connection). */
export function findSavedQuery(id: string, connectionId?: string): SavedQuery | undefined {
  const by = useSavedQueries.getState().byConn;
  if (connectionId) return by[connectionId]?.items.find((q) => q.id === id);
  for (const c of Object.values(by)) {
    const q = c.items.find((x) => x.id === id);
    if (q) return q;
  }
  return undefined;
}

/** "Shop.dbo", "main", "SHOP": where a query lives, for titles and messages. */
export function scopeLabel(s: Pick<SavedQueryScope, 'database' | 'schema'>): string {
  if (s.database && s.schema && s.database !== s.schema) return `${s.database}.${s.schema}`;
  return s.schema ?? s.database ?? 'the connection';
}

/** A name not used yet in the scope: "Query 1", "Query 2"… (or `base`, then "base 2"…). */
export function freeQueryName(items: readonly SavedQuery[] | undefined, scope: Pick<SavedQueryScope, 'database' | 'schema'>, base?: string): string {
  const taken = new Set(queriesIn(items, scope.database, scope.schema ?? '').map((q) => q.name.toLowerCase()));
  const stem = base?.trim();
  if (stem && !taken.has(stem.toLowerCase())) return stem;
  for (let n = stem ? 2 : 1; ; n++) {
    const candidate = `${stem || 'Query'} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Another query of the scope already has this name (case-insensitive), not counting `exceptId`. */
export function nameTaken(items: readonly SavedQuery[] | undefined, scope: Pick<SavedQueryScope, 'database' | 'schema'>, name: string, exceptId?: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return queriesIn(items, scope.database, scope.schema ?? '').some((q) => q.id !== exceptId && q.name.toLowerCase() === n);
}

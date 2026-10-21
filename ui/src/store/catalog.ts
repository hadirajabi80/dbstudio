import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import type { CatalogSchema, CatalogSnapshot, DatabasesResponse, Dialect, SchemasResponse, WsEventOf } from '../api/types';

/**
 * Catalog cache, keyed by connectionId and database. Every connection has its own lazily loaded tree;
 * nothing here assumes a "current" connection.
 */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ConnCatalog {
  databases: DatabasesResponse | null;
  status: LoadStatus;
  error: string | null;
  /** A forced reload of an already loaded list is on its way: `status` stays 'ready' and the old list stays shown. */
  revalidating?: boolean;
}

export interface DbCatalog {
  connectionId: string;
  database: string | null;
  schemasResp: SchemasResponse | null;
  schemasStatus: LoadStatus;
  schemasError: string | null;
  loaded: Record<string, CatalogSchema>;
  schemaStatus: Record<string, LoadStatus>;
  schemaError: Record<string, string>;
  etags: Record<string, string>;
  dialect: Dialect | null;
  defaultSchema: string | null;
  databasesList: string[];
  /** PostgreSQL search_path (snapshot `searchPath`, else the schemas' searchPathIndex); null elsewhere. */
  searchPath?: string[] | null;
  /** Merged snapshot of every loaded schema (stable identity until a schema changes). */
  snapshot: CatalogSnapshot | null;
  /**
   * Forced reloads of data that is already shown (refresh, save of an edited object, catalog.changed): the status
   * stays 'ready' and the old data stays until the response swaps it in, so the explorer never collapses or flashes.
   */
  schemasRevalidating?: boolean;
  revalidating?: Record<string, boolean>;
}

export const dbKey = (connectionId: string, database: string | null | undefined) => `${connectionId}\u0001${database ?? ''}`;

function emptyDb(connectionId: string, database: string | null): DbCatalog {
  return {
    connectionId, database, schemasResp: null, schemasStatus: 'idle', schemasError: null, loaded: {}, schemaStatus: {},
    schemaError: {}, etags: {}, dialect: null, defaultSchema: null, databasesList: [], searchPath: null, snapshot: null,
    schemasRevalidating: false, revalidating: {},
  };
}

function buildSnapshot(d: DbCatalog): CatalogSnapshot | null {
  const schemas = Object.values(d.loaded);
  if (!d.dialect || schemas.length === 0) return null;
  schemas.sort((a, b) => a.name.localeCompare(b.name));
  return {
    connectionId: d.connectionId,
    dialect: d.dialect,
    database: d.database,
    defaultSchema: d.defaultSchema ?? schemas[0].name,
    version: schemas.reduce((m, s) => Math.max(m, s.version), 0),
    databases: d.databasesList,
    schemas,
    // every schema of the database, loaded or not, so IntelliSense offers them and lazy-loads one on `schema.`
    ...(d.schemasResp?.schemas.length ? { schemaNames: d.schemasResp.schemas.map((s) => s.name) } : {}),
    ...(d.searchPath?.length ? { searchPath: d.searchPath } : {}),
  };
}

/** search_path from a schema list (PostgreSQL `searchPathIndex`), in order; null when no schema has one. */
export function searchPathOf(r: SchemasResponse | null | undefined): string[] | null {
  const on = (r?.schemas ?? []).filter((s) => typeof s.searchPathIndex === 'number');
  if (!on.length) return null;
  return on.sort((a, b) => (a.searchPathIndex ?? 0) - (b.searchPathIndex ?? 0)).map((s) => s.name);
}

interface CatalogState {
  conns: Record<string, ConnCatalog>;
  dbs: Record<string, DbCatalog>;
  loadDatabases(connectionId: string, force?: boolean): Promise<DatabasesResponse | null>;
  loadSchemas(connectionId: string, database: string | null, force?: boolean): Promise<SchemasResponse | null>;
  /** Default schema(s), the engine decides which (GET /catalog without `schemas`). */
  ensureDefault(connectionId: string, database: string | null): Promise<void>;
  loadSchema(connectionId: string, database: string | null, schema: string, force?: boolean): Promise<void>;
  refresh(connectionId: string, database?: string | null): Promise<void>;
  /**
   * Targeted, flash-free reload of some schemas of one database (after saving an edited object): the engine reloads
   * them, and every cached entry of that database revalidates them in place (loaded data stays shown meanwhile).
   */
  revalidate(connectionId: string, database: string | null, schemas: (string | null)[]): Promise<void>;
  applyChanged(ev: WsEventOf<'catalog.changed'>): void;
  forget(connectionId: string): void;
}

const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const useCatalog = create<CatalogState>((set, get) => {
  const patchDb = (cid: string, db: string | null, fn: (d: DbCatalog) => Partial<DbCatalog>) => {
    const key = dbKey(cid, db);
    const cur = get().dbs[key] ?? emptyDb(cid, db);
    const next = { ...cur, ...fn(cur) };
    set({ dbs: { ...get().dbs, [key]: next } });
    return next;
  };
  const patchConn = (cid: string, p: Partial<ConnCatalog>) => {
    const cur = get().conns[cid] ?? { databases: null, status: 'idle', error: null };
    set({ conns: { ...get().conns, [cid]: { ...cur, ...p } } });
  };

  const mergeSnapshot = (cid: string, db: string | null, snap: CatalogSnapshot, etag: string | null, requested: string[] | null) => {
    patchDb(cid, db, (d) => {
      const loaded = { ...d.loaded };
      const schemaStatus = { ...d.schemaStatus };
      const etags = { ...d.etags };
      const schemaError = { ...d.schemaError };
      const revalidating = { ...d.revalidating };
      for (const s of snap.schemas) {
        loaded[s.name] = s;
        schemaStatus[s.name] = 'ready';
        delete schemaError[s.name];
        delete revalidating[s.name];
        if (etag && requested?.length === 1) etags[s.name] = etag;
      }
      for (const r of requested ?? []) {
        if (!loaded[r]) schemaStatus[r] = 'ready';
        delete revalidating[r];
      }
      const next: DbCatalog = {
        ...d, loaded, schemaStatus, etags, schemaError, revalidating,
        dialect: snap.dialect, defaultSchema: snap.defaultSchema ?? d.defaultSchema,
        // the databases for IntelliSense (T-SQL `db.`): the snapshot's list, else the connection's GET /databases
        databasesList: snap.databases?.length ? snap.databases : d.databasesList.length ? d.databasesList : get().conns[cid]?.databases?.databases ?? [],
        searchPath: snap.searchPath?.length ? snap.searchPath : d.searchPath ?? searchPathOf(d.schemasResp),
      };
      return { ...next, snapshot: buildSnapshot(next) };
    });
  };

  /**
   * Cached database entries an engine database name refers to. The engine may name no database (SQLite, Oracle: one
   * per connection) while the cache is keyed by the effective database ("main", "Shop"): a null database means every
   * cached database of the connection; a database that matches no key falls back to the connection's default (null /
   * current database) entry.
   */
  const cachedEntries = (cid: string, database: string | null | undefined): DbCatalog[] => {
    const all = Object.values(get().dbs).filter((d) => d.connectionId === cid);
    const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
    if (database == null) return all;
    const hits = all.filter((d) => same(d.database, database));
    if (hits.length) return hits;
    const current = get().conns[cid]?.databases?.current ?? null;
    return all.filter((d) => d.database === null || (current !== null && same(d.database, current)));
  };

  return {
    conns: {},
    dbs: {},

    loadDatabases(cid, force = false) {
      const cur = get().conns[cid];
      if (!force && cur?.status === 'ready') return Promise.resolve(cur.databases);
      return once(`db:${cid}`, async () => {
        // A list that is already shown stays shown (and 'ready') while it reloads: no "Connecting…" flash.
        const shown = get().conns[cid]?.status === 'ready' && !!get().conns[cid]?.databases;
        patchConn(cid, shown ? { revalidating: true } : { status: 'loading', error: null });
        try {
          const r = await api.databases(cid);
          patchConn(cid, { databases: r, status: 'ready', error: null, revalidating: false });
          return r;
        } catch (e) {
          if (shown) {
            console.warn('[catalog] reloading the database list failed', e);
            patchConn(cid, { revalidating: false });
            return get().conns[cid]?.databases ?? null;
          }
          patchConn(cid, { status: 'error', error: errorMessage(e) });
          return null;
        }
      });
    },

    loadSchemas(cid, db, force = false) {
      const cur = get().dbs[dbKey(cid, db)];
      if (!force && cur?.schemasStatus === 'ready') return Promise.resolve(cur.schemasResp);
      return once(`sc:${dbKey(cid, db)}`, async () => {
        const shown = get().dbs[dbKey(cid, db)]?.schemasStatus === 'ready' && !!get().dbs[dbKey(cid, db)]?.schemasResp;
        patchDb(cid, db, () => (shown ? { schemasRevalidating: true } : { schemasStatus: 'loading', schemasError: null }));
        try {
          const r = await api.schemas(cid, db);
          patchDb(cid, db, (d) => {
            const next: DbCatalog = {
              ...d, schemasResp: r, schemasStatus: 'ready', schemasError: null, schemasRevalidating: false,
              defaultSchema: r.defaultSchema ?? d.defaultSchema, searchPath: d.searchPath ?? searchPathOf(r),
            };
            // The schema list (and a search_path learned from it) reaches an already built snapshot too.
            return d.snapshot ? { ...next, snapshot: buildSnapshot(next) } : next;
          });
          return r;
        } catch (e) {
          if (shown) {
            console.warn('[catalog] reloading the schema list failed', e);
            patchDb(cid, db, () => ({ schemasRevalidating: false }));
            return get().dbs[dbKey(cid, db)]?.schemasResp ?? null;
          }
          patchDb(cid, db, () => ({ schemasStatus: 'error', schemasError: errorMessage(e) }));
          return null;
        }
      });
    },

    ensureDefault(cid, db) {
      const cur = get().dbs[dbKey(cid, db)];
      if (cur && Object.keys(cur.loaded).length > 0) {
        // Loaded by another path (an object opened from the explorer, a data tab): IntelliSense still needs the schema
        // list to offer (and lazy-load) the other schemas.
        if (cur.schemasStatus === 'idle') void get().loadSchemas(cid, db);
        return Promise.resolve();
      }
      return once(`def:${dbKey(cid, db)}`, async () => {
        try {
          const r = await api.catalog(cid, db, null);
          if (!r.notModified) mergeSnapshot(cid, db, r.snapshot, null, null);
          // the schema list too, so IntelliSense can offer (and lazy-load) the other schemas
          void get().loadSchemas(cid, db);
        } catch (e) {
          console.warn('[catalog] default load failed', e);
        }
      });
    },

    loadSchema(cid, db, schema, force = false) {
      const cur = get().dbs[dbKey(cid, db)];
      const st = cur?.schemaStatus[schema];
      if (!force && (st === 'ready' || st === 'loading')) return Promise.resolve();
      return once(`s:${dbKey(cid, db)}:${schema}`, async () => {
        // Revalidating a schema whose objects are shown keeps it 'ready' with the old objects until the new ones
        // arrive (a 304 changes nothing at all); only a schema that is not loaded yet shows 'loading'.
        const shown = !!get().dbs[dbKey(cid, db)]?.loaded[schema];
        const done = (d: DbCatalog): Record<string, boolean> => {
          const rv = { ...d.revalidating };
          delete rv[schema];
          return rv;
        };
        patchDb(cid, db, (d) => (shown
          ? { revalidating: { ...d.revalidating, [schema]: true } }
          : { schemaStatus: { ...d.schemaStatus, [schema]: 'loading' } }));
        try {
          const etag = force ? get().dbs[dbKey(cid, db)]?.etags[schema] : undefined;
          const r = await api.catalog(cid, db, [schema], etag);
          if (r.notModified) {
            patchDb(cid, db, (d) => ({ schemaStatus: { ...d.schemaStatus, [schema]: 'ready' }, revalidating: done(d) }));
          } else {
            mergeSnapshot(cid, db, r.snapshot, r.etag, [schema]);
          }
        } catch (e) {
          if (shown) {
            console.warn(`[catalog] reloading schema ${schema} failed`, e);
            patchDb(cid, db, (d) => ({ revalidating: done(d) }));
            return;
          }
          patchDb(cid, db, (d) => ({
            schemaStatus: { ...d.schemaStatus, [schema]: 'error' },
            schemaError: { ...d.schemaError, [schema]: errorMessage(e) },
          }));
        }
      });
    },

    async refresh(cid, database) {
      const keys = Object.values(get().dbs).filter((d) => d.connectionId === cid && (database === undefined || d.database === (database ?? null)));
      try {
        await Promise.all(keys.map((d) => api.refreshCatalog(cid, d.database, null)));
      } catch (e) {
        console.warn('[catalog] refresh request failed', e);
      }
      if (database === undefined) await get().loadDatabases(cid, true);
      for (const d of keys) {
        await get().loadSchemas(cid, d.database, true);
        await Promise.all(Object.keys(d.loaded).map((s) => get().loadSchema(cid, d.database, s, true)));
      }
    },

    async revalidate(cid, database, schemas) {
      const targets = cachedEntries(cid, database);
      // No schema (an object reference without one): the database's default schema.
      const names = [...new Set(schemas.map((s) => s ?? targets.find((d) => d.defaultSchema)?.defaultSchema ?? null).filter((s): s is string => !!s))];
      if (!targets.length || !names.length) return;
      try {
        // The engine reloads these schemas (its cache may predate the change) and pushes catalog.changed.
        await api.refreshCatalog(cid, targets[0].database, names);
      } catch (e) {
        console.warn('[catalog] refresh request failed', e);
      }
      // Only schemas the entry has loaded (by their cached spelling): the others load on demand anyway.
      const keyIn = (d: DbCatalog, s: string) => (d.loaded[s] ? s : Object.keys(d.loaded).find((k) => k.toLowerCase() === s.toLowerCase()));
      await Promise.all(targets.flatMap((d) => names
        .map((s) => keyIn(d, s))
        .filter((s): s is string => !!s)
        .map((s) => get().loadSchema(cid, d.database, s, true))));
    },

    applyChanged(ev) {
      for (const d of cachedEntries(ev.connectionId, ev.database)) {
        if (d.schemasStatus === 'ready') void get().loadSchemas(ev.connectionId, d.database, true);
        const schemas = ev.schemas.length ? ev.schemas : Object.keys(d.loaded);
        for (const s of schemas) if (d.loaded[s] || d.schemaStatus[s] === 'ready') void get().loadSchema(ev.connectionId, d.database, s, true);
      }
    },

    forget(cid) {
      const dbs = { ...get().dbs };
      for (const k of Object.keys(dbs)) if (dbs[k].connectionId === cid) delete dbs[k];
      const conns = { ...get().conns };
      delete conns[cid];
      set({ dbs, conns });
    },
  };
});

export function useSnapshot(connectionId: string | null | undefined, database: string | null | undefined): CatalogSnapshot | null {
  return useCatalog((s) => (connectionId ? s.dbs[dbKey(connectionId, database)]?.snapshot ?? null : null));
}

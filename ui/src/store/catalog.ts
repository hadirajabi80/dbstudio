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
}

export const dbKey = (connectionId: string, database: string | null | undefined) => `${connectionId}\u0001${database ?? ''}`;

function emptyDb(connectionId: string, database: string | null): DbCatalog {
  return {
    connectionId, database, schemasResp: null, schemasStatus: 'idle', schemasError: null, loaded: {}, schemaStatus: {},
    schemaError: {}, etags: {}, dialect: null, defaultSchema: null, databasesList: [], searchPath: null, snapshot: null,
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
      for (const s of snap.schemas) {
        loaded[s.name] = s;
        schemaStatus[s.name] = 'ready';
        delete schemaError[s.name];
        if (etag && requested?.length === 1) etags[s.name] = etag;
      }
      for (const r of requested ?? []) if (!loaded[r]) schemaStatus[r] = 'ready';
      const next: DbCatalog = {
        ...d, loaded, schemaStatus, etags, schemaError,
        dialect: snap.dialect, defaultSchema: snap.defaultSchema ?? d.defaultSchema, databasesList: snap.databases ?? d.databasesList,
        searchPath: snap.searchPath?.length ? snap.searchPath : d.searchPath ?? searchPathOf(d.schemasResp),
      };
      return { ...next, snapshot: buildSnapshot(next) };
    });
  };

  return {
    conns: {},
    dbs: {},

    loadDatabases(cid, force = false) {
      const cur = get().conns[cid];
      if (!force && cur?.status === 'ready') return Promise.resolve(cur.databases);
      return once(`db:${cid}`, async () => {
        patchConn(cid, { status: 'loading', error: null });
        try {
          const r = await api.databases(cid);
          patchConn(cid, { databases: r, status: 'ready' });
          return r;
        } catch (e) {
          patchConn(cid, { status: 'error', error: errorMessage(e) });
          return null;
        }
      });
    },

    loadSchemas(cid, db, force = false) {
      const cur = get().dbs[dbKey(cid, db)];
      if (!force && cur?.schemasStatus === 'ready') return Promise.resolve(cur.schemasResp);
      return once(`sc:${dbKey(cid, db)}`, async () => {
        patchDb(cid, db, () => ({ schemasStatus: 'loading', schemasError: null }));
        try {
          const r = await api.schemas(cid, db);
          patchDb(cid, db, (d) => {
            const next: DbCatalog = { ...d, schemasResp: r, schemasStatus: 'ready', defaultSchema: r.defaultSchema ?? d.defaultSchema, searchPath: d.searchPath ?? searchPathOf(r) };
            // A search_path learned from the schema list reaches an already built snapshot too.
            return (next.searchPath ?? null) !== (d.searchPath ?? null) && d.snapshot ? { ...next, snapshot: buildSnapshot(next) } : next;
          });
          return r;
        } catch (e) {
          patchDb(cid, db, () => ({ schemasStatus: 'error', schemasError: errorMessage(e) }));
          return null;
        }
      });
    },

    ensureDefault(cid, db) {
      const cur = get().dbs[dbKey(cid, db)];
      if (cur && Object.keys(cur.loaded).length > 0) return Promise.resolve();
      return once(`def:${dbKey(cid, db)}`, async () => {
        try {
          const r = await api.catalog(cid, db, null);
          if (!r.notModified) mergeSnapshot(cid, db, r.snapshot, null, null);
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
        patchDb(cid, db, (d) => ({ schemaStatus: { ...d.schemaStatus, [schema]: 'loading' } }));
        try {
          const etag = force ? get().dbs[dbKey(cid, db)]?.etags[schema] : undefined;
          const r = await api.catalog(cid, db, [schema], etag);
          if (r.notModified) {
            patchDb(cid, db, (d) => ({ schemaStatus: { ...d.schemaStatus, [schema]: 'ready' } }));
          } else {
            mergeSnapshot(cid, db, r.snapshot, r.etag, [schema]);
          }
        } catch (e) {
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

    applyChanged(ev) {
      // The engine may name no database (SQLite, Oracle: one per connection) while the cache is keyed by the effective
      // database ("main", "Shop"): a null database refreshes every cached database of the connection; a database that
      // matches no key falls back to the connection's default (null / current database) entry.
      const all = Object.values(get().dbs).filter((d) => d.connectionId === ev.connectionId);
      const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
      let targets = ev.database == null ? all : all.filter((d) => same(d.database, ev.database!));
      if (!targets.length && ev.database != null) {
        const current = get().conns[ev.connectionId]?.databases?.current ?? null;
        targets = all.filter((d) => d.database === null || (current !== null && same(d.database, current)));
      }
      for (const d of targets) {
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

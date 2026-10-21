// Explorer data of MongoDB connections (docs/PLAN-M2.md 6.2): databases and collections per connection, loaded
// lazily as the explorer expands, plus the sampled field paths used by completion (cached 60 s like the engine).
import { create } from 'zustand';
import { api } from '../../api/client';
import type { MongoCollectionInfo, MongoDatabaseInfo, MongoFieldPath } from '../../api/types';
import { notifySourceTreeChanged } from '../../lib/sources';

export interface Loadable<T> {
  data?: T;
  loading?: boolean;
  error?: string;
}

interface ConnData {
  databases: Loadable<MongoDatabaseInfo[]>;
  collections: Record<string, Loadable<MongoCollectionInfo[]>>;
}

interface MongoState {
  conns: Record<string, ConnData>;
}

export const useMongo = create<MongoState>(() => ({ conns: {} }));

const empty = (): ConnData => ({ databases: {}, collections: {} });

function patchConn(cid: string, fn: (c: ConnData) => ConnData) {
  useMongo.setState((s) => ({ conns: { ...s.conns, [cid]: fn(s.conns[cid] ?? empty()) } }));
  notifySourceTreeChanged();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const p = inflight.get(key) as Promise<T> | undefined;
  if (p) return p;
  const next = run().finally(() => inflight.delete(key));
  inflight.set(key, next);
  return next;
}

export function loadDatabases(cid: string, force = false): Promise<MongoDatabaseInfo[] | undefined> {
  const cur = useMongo.getState().conns[cid]?.databases;
  if (!force && (cur?.data || cur?.loading)) return Promise.resolve(cur.data);
  return once(`db:${cid}`, async () => {
    patchConn(cid, (c) => ({ ...c, databases: { ...c.databases, loading: true, error: undefined } }));
    try {
      const list = await api.mongo.databases(cid);
      patchConn(cid, (c) => ({ ...c, databases: { data: list } }));
      return list;
    } catch (e) {
      patchConn(cid, (c) => ({ ...c, databases: { error: message(e) } }));
      return undefined;
    }
  });
}

export function loadCollections(cid: string, db: string, force = false): Promise<MongoCollectionInfo[] | undefined> {
  const cur = useMongo.getState().conns[cid]?.collections[db];
  if (!force && (cur?.data || cur?.loading)) return Promise.resolve(cur.data);
  return once(`coll:${cid}:${db}`, async () => {
    patchConn(cid, (c) => ({ ...c, collections: { ...c.collections, [db]: { ...c.collections[db], loading: true, error: undefined } } }));
    try {
      const list = await api.mongo.collections(cid, db);
      patchConn(cid, (c) => ({ ...c, collections: { ...c.collections, [db]: { data: list } } }));
      return list;
    } catch (e) {
      patchConn(cid, (c) => ({ ...c, collections: { ...c.collections, [db]: { error: message(e) } } }));
      return undefined;
    }
  });
}

/** Reloads what is loaded (Refresh). */
export async function refreshConnection(cid: string): Promise<void> {
  const c = useMongo.getState().conns[cid];
  await loadDatabases(cid, true);
  await Promise.all(Object.keys(c?.collections ?? {}).map((db) => loadCollections(cid, db, true)));
}

export function forgetConnection(cid: string): void {
  useMongo.setState((s) => {
    const next = { ...s.conns };
    delete next[cid];
    return { conns: next };
  });
  for (const k of [...fieldCache.keys()]) if (k.startsWith(`${cid}\u0001`)) fieldCache.delete(k);
  notifySourceTreeChanged();
}

export function collectionInfo(cid: string, db: string, coll: string): MongoCollectionInfo | undefined {
  return useMongo.getState().conns[cid]?.collections[db]?.data?.find((c) => c.name === coll);
}

/** Updates one collection's count badge (after inserts/deletes) without a reload. */
export function setCollectionCount(cid: string, db: string, coll: string, count: number): void {
  const list = useMongo.getState().conns[cid]?.collections[db]?.data;
  if (!list) return;
  patchConn(cid, (c) => ({ ...c, collections: { ...c.collections, [db]: { data: list.map((x) => (x.name === coll ? { ...x, count } : x)) } } }));
}

// ---- sampled fields (completion)

const FIELD_TTL = 60_000;
const fieldCache = new Map<string, { at: number; fields: MongoFieldPath[] } | Promise<MongoFieldPath[]>>();

export function cachedFields(cid: string, db: string, coll: string): MongoFieldPath[] {
  const hit = fieldCache.get(`${cid}\u0001${db}\u0001${coll}`);
  return hit && !(hit instanceof Promise) ? hit.fields : [];
}

/** Sampled field paths of a collection (shared by every editor on it). */
export function loadFields(cid: string, db: string, coll: string, force = false): Promise<MongoFieldPath[]> {
  const key = `${cid}\u0001${db}\u0001${coll}`;
  const hit = fieldCache.get(key);
  if (hit instanceof Promise) return hit;
  if (hit && !force && Date.now() - hit.at < FIELD_TTL) return Promise.resolve(hit.fields);
  const p = api.mongo.fields(cid, db, coll, { sampleSize: 500 })
    .then((r) => {
      fieldCache.set(key, { at: Date.now(), fields: r.fields });
      return r.fields;
    })
    .catch(() => {
      fieldCache.delete(key);
      return [] as MongoFieldPath[];
    });
  fieldCache.set(key, p);
  return p;
}

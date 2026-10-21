// Redis UI state shared by the explorer subtree, the palette and the views: server facts, a key cache per database
// (explorer folders, Ctrl+P `k:` entries, Workbench key completion) and the per-connection command history.
import { create } from 'zustand';
import { ApiError, api } from '../../api/client';
import type { RedisKeySummary, RedisServerInfo } from '../../api/types';
import { notifySourceTreeChanged } from '../../lib/sources';

export interface Loadable<T> {
  data?: T;
  loading?: boolean;
  error?: string;
}

export interface KeyCache {
  /** Keys by name (scanned by the explorer or the browser). */
  keys: Map<string, RedisKeySummary>;
  /** Folder prefixes the explorer already scanned (`SCAN MATCH prefix*`), '' = the database root. */
  scanned: Set<string>;
  dbSize: number;
  /** The root scan stopped before the end (the explorer shows "open the browser for more"). */
  truncated: boolean;
  loading: number;
  error?: string;
}

interface ConnState {
  server: Loadable<RedisServerInfo>;
  dbs: Record<number, KeyCache>;
}

interface RedisStore {
  conns: Record<string, ConnState>;
}

export const useRedis = create<RedisStore>(() => ({ conns: {} }));

export const EXPLORER_SCAN_LIMIT = 1000;
const MAX_CACHED_KEYS = 100_000;

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function patchConn(cid: string, fn: (c: ConnState) => ConnState): void {
  useRedis.setState((s) => ({ conns: { ...s.conns, [cid]: fn(s.conns[cid] ?? { server: {}, dbs: {} }) } }));
  notifySourceTreeChanged();
}

export function cacheOf(cid: string, db: number): KeyCache | undefined {
  return useRedis.getState().conns[cid]?.dbs[db];
}

function ensureCache(c: ConnState, db: number): KeyCache {
  return c.dbs[db] ?? { keys: new Map(), scanned: new Set(), dbSize: 0, truncated: false, loading: 0 };
}

export async function loadServer(cid: string, force = false): Promise<RedisServerInfo | null> {
  const cur = useRedis.getState().conns[cid]?.server;
  if (!force && (cur?.data || cur?.loading)) return cur.data ?? null;
  patchConn(cid, (c) => ({ ...c, server: { ...c.server, loading: true, error: undefined } }));
  try {
    const data = await api.redis.server(cid);
    patchConn(cid, (c) => ({ ...c, server: { data } }));
    return data;
  } catch (e) {
    patchConn(cid, (c) => ({ ...c, server: { error: errorText(e) } }));
    return null;
  }
}

/** Adds scanned keys to the cache (browser pages, explorer scans). */
export function rememberKeys(cid: string, db: number, keys: readonly RedisKeySummary[], dbSize?: number): void {
  if (!keys.length && dbSize === undefined) return;
  patchConn(cid, (c) => {
    const cache = ensureCache(c, db);
    const map = new Map(cache.keys);
    for (const k of keys) if (map.size < MAX_CACHED_KEYS || map.has(k.key)) map.set(k.key, k);
    return { ...c, dbs: { ...c.dbs, [db]: { ...cache, keys: map, dbSize: dbSize ?? cache.dbSize } } };
  });
}

export function forgetKeys(cid: string, db: number, keys: readonly string[]): void {
  patchConn(cid, (c) => {
    const cache = c.dbs[db];
    if (!cache) return c;
    const map = new Map(cache.keys);
    for (const k of keys) map.delete(k);
    return { ...c, dbs: { ...c.dbs, [db]: { ...cache, keys: map } } };
  });
}

/** Explorer lazy scan of a database root (prefix '') or of a folder (prefix 'user:'); one at a time per prefix. */
export async function scanForExplorer(cid: string, db: number, prefix: string, pattern: string): Promise<void> {
  const cache = cacheOf(cid, db);
  if (cache?.scanned.has(prefix)) return;
  patchConn(cid, (c) => {
    const cur = ensureCache(c, db);
    const scanned = new Set(cur.scanned);
    scanned.add(prefix);
    return { ...c, dbs: { ...c.dbs, [db]: { ...cur, scanned, loading: cur.loading + 1, error: undefined } } };
  });
  let cursor = '0';
  let found: RedisKeySummary[] = [];
  let dbSize = 0;
  let error: string | undefined;
  try {
    do {
      const r = await api.redis.scan(cid, { db, pattern, cursor, count: 500 });
      found = found.concat(r.keys);
      cursor = r.cursor;
      dbSize = r.dbSize;
    } while (cursor !== '0' && found.length < EXPLORER_SCAN_LIMIT);
  } catch (e) {
    error = errorText(e);
  }
  patchConn(cid, (c) => {
    const cur = ensureCache(c, db);
    const map = new Map(cur.keys);
    for (const k of found) map.set(k.key, k);
    const scanned = new Set(cur.scanned);
    if (error) scanned.delete(prefix);
    return {
      ...c,
      dbs: { ...c.dbs, [db]: { ...cur, keys: map, scanned, dbSize: dbSize || cur.dbSize, loading: Math.max(0, cur.loading - 1), error, truncated: prefix === '' ? cursor !== '0' : cur.truncated } },
    };
  });
}

/** Drops the explorer cache of a database (refresh). */
export function resetKeys(cid: string, db?: number): void {
  patchConn(cid, (c) => {
    if (db === undefined) return { ...c, dbs: {} };
    const dbs = { ...c.dbs };
    delete dbs[db];
    return { ...c, dbs };
  });
}

export function forgetConnection(cid: string): void {
  useRedis.setState((s) => {
    const conns = { ...s.conns };
    delete conns[cid];
    return { conns };
  });
  notifySourceTreeChanged();
}

/** Cached key names of a connection's database (Workbench / CLI completion). */
export function cachedKeyNames(cid: string, db: number): string[] {
  return [...(cacheOf(cid, db)?.keys.keys() ?? [])].sort();
}

// ---- command history (per connection, 200 entries, newest last; survives reloads in localStorage)

export const HISTORY_LIMIT = 200;
const histKey = (cid: string) => `dbstudio.redis.history.${cid}`;
const memoryHistory = new Map<string, string[]>();

export function loadHistory(cid: string): string[] {
  const mem = memoryHistory.get(cid);
  if (mem) return mem;
  let list: string[] = [];
  try {
    const raw = localStorage.getItem(histKey(cid));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string').slice(-HISTORY_LIMIT);
  } catch {
    list = [];
  }
  memoryHistory.set(cid, list);
  return list;
}

export function pushHistory(cid: string, lines: readonly string[]): string[] {
  let list = loadHistory(cid).slice();
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    list = list.filter((x) => x !== t);
    list.push(t);
  }
  list = list.slice(-HISTORY_LIMIT);
  memoryHistory.set(cid, list);
  try {
    localStorage.setItem(histKey(cid), JSON.stringify(list));
  } catch {
    // storage unavailable: keep the in-memory history
  }
  return list;
}

export function clearHistoryForTests(): void {
  memoryHistory.clear();
}

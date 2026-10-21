// Explorer subtree of a Redis connection (docs/PLAN-M2.md 5.2):
//   connection → db 0..15 (INFO keyspace counts; cluster: one "keys" root) → key folders by delimiter → keys
//   (type icon, TTL badge), plus the fixed nodes Workbench, CLI, Pub/Sub, Slowlog, Info, Analysis.
// Folders are built client-side from the cached scan pages; expanding a folder of a truncated database scans
// `SCAN MATCH prefix*`. Paths: [db], [db, prefix] (folder), [db, key] (key), ['~', view] (tool).
import { Boxes, Braces, ChartBar, Clock, Database, Folder, Gauge, Hash, KeyRound, List, ListOrdered, Radio, Rows3, SquareChevronRight, SquareTerminal, Type, Waves } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConnectionProfile, RedisKeySummary, RedisKeyType } from '../../api/types';
import { sourceNodeId, sourceRow, type SourceTreeInput } from '../../lib/sources';
import { buildKeyIndex, folderPattern, type KeyFolder } from '../../redis/keyTree';
import { formatCount, formatTtl } from '../../redis/format';
import type { TreeRow } from '../Explorer/tree';
import { VIEW_TITLE, profileDb, type RedisView } from './open';
import { cacheOf, loadServer, scanForExplorer, useRedis } from './store';

export type RedisNodeType = 'db' | 'folder' | 'key' | 'tool';

export interface KeyMeta { db: number; key: string; type: RedisKeyType; ttl: number }
export interface FolderMeta { db: number; prefix: string }
export interface DbMeta { db: number }

export const TOOLS: RedisView[] = ['redis.workbench', 'redis.cli', 'redis.pubsub', 'redis.slowlog', 'redis.info', 'redis.analysis'];

/** Per-type colour (existing theme tokens; no new colours). */
export const TYPE_COLOR: Record<RedisKeyType, string> = {
  string: 'var(--string)', hash: 'var(--obj-table)', list: 'var(--obj-routine)', set: 'var(--obj-view)', zset: 'var(--obj-package)',
  stream: 'var(--obj-fk)', rejson: 'var(--bool)', unknown: 'var(--obj-other)',
};

export function typeIcon(type: RedisKeyType, size = 14): ReactNode {
  const style = { color: TYPE_COLOR[type], flex: 'none' as const };
  const p = { size, strokeWidth: 1.75, style, 'aria-hidden': true as const };
  switch (type) {
    case 'string': return <Type {...p} />;
    case 'hash': return <Hash {...p} />;
    case 'list': return <List {...p} />;
    case 'set': return <Rows3 {...p} />;
    case 'zset': return <ListOrdered {...p} />;
    case 'stream': return <Waves {...p} />;
    case 'rejson': return <Braces {...p} />;
    default: return <KeyRound {...p} />;
  }
}

const TOOL_ICON: Record<string, (s: number) => ReactNode> = {
  'redis.workbench': (s) => <SquareTerminal size={s} strokeWidth={1.75} />,
  'redis.cli': (s) => <SquareChevronRight size={s} strokeWidth={1.75} />,
  'redis.pubsub': (s) => <Radio size={s} strokeWidth={1.75} />,
  'redis.slowlog': (s) => <Clock size={s} strokeWidth={1.75} />,
  'redis.info': (s) => <Gauge size={s} strokeWidth={1.75} />,
  'redis.analysis': (s) => <ChartBar size={s} strokeWidth={1.75} />,
};

export function redisTreeIcon(row: TreeRow): ReactNode {
  const s = row.source;
  if (!s) return null;
  if (s.nodeType === 'key') return typeIcon((s.meta as KeyMeta).type);
  if (s.nodeType === 'folder') return <Folder size={14} strokeWidth={1.75} style={{ color: 'var(--obj-other)' }} />;
  if (s.nodeType === 'db') return <Database size={14} strokeWidth={1.75} style={{ color: 'var(--provider-redis)' }} />;
  if (s.nodeType === 'tool') return TOOL_ICON[s.path[1]]?.(14) ?? <Boxes size={14} />;
  return null;
}

function statusRow(parent: string, depth: number, status: 'loading' | 'error' | 'empty' | 'hint', label: string): TreeRow {
  return { id: `${parent}#${status}:${label.length}`, kind: 'status', depth, label, expandable: false, expanded: false, status };
}

/** Databases shown: those with keys, plus the profile's database (always). Cluster: db 0 only. */
export function visibleDbs(connection: ConnectionProfile): number[] {
  const server = useRedis.getState().conns[connection.id]?.server.data;
  if (!server) return [];
  if (server.mode === 'cluster') return [0];
  const set = new Set(server.keyspace.filter((k) => k.keys > 0).map((k) => k.db));
  set.add(profileDb(connection.id));
  return [...set].sort((a, b) => a - b);
}

type Base = { connectionId: string; providerId: 'redis'; expanded: ReadonlySet<string> };

function keyRow(base: Base, db: number, k: RedisKeySummary, label: string, depth: number, match?: number[]): TreeRow {
  return sourceRow({
    ...base, nodeType: 'key', path: [String(db), k.key], depth, label, detail: formatTtl(k.ttl),
    meta: { db, key: k.key, type: k.type, ttl: k.ttl } satisfies KeyMeta, match,
  });
}

function folderRows(base: Base, db: number, folder: KeyFolder, depth: number, out: TreeRow[]): void {
  const folders = [...folder.folders.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  for (const f of folders) {
    const row = sourceRow({
      ...base, nodeType: 'folder', path: [String(db), f.prefix], depth, label: f.label || '(empty)', expandable: true, count: f.count,
      meta: { db, prefix: f.prefix } satisfies FolderMeta,
    });
    out.push(row);
    if (row.expanded) folderRows(base, db, f, depth + 1, out);
  }
  const keys = [...folder.keys].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  for (const k of keys) out.push(keyRow(base, db, k, k.key.slice(folder.prefix.length) || k.key, depth));
}

export function redisTree({ connection, depth, expanded, filter }: SourceTreeInput): TreeRow[] {
  const cid = connection.id;
  const state = useRedis.getState().conns[cid];
  const connId = `c:${cid}`;
  const server = state?.server;
  if (!server?.data) {
    if (server?.error) return [statusRow(connId, depth, 'error', server.error)];
    return [statusRow(connId, depth, 'loading', 'Connecting…')];
  }
  const base: Base = { connectionId: cid, providerId: 'redis', expanded };
  const delimiter = server.data.delimiter || (typeof connection.props.keyDelimiter === 'string' && connection.props.keyDelimiter) || ':';
  const cluster = server.data.mode === 'cluster';
  const rows: TreeRow[] = [];
  const f = filter.trim().toLowerCase();
  for (const db of visibleDbs(connection)) {
    const ks = server.data.keyspace.find((k) => k.db === db);
    const cache = cacheOf(cid, db);
    const dbRow = sourceRow({
      ...base, nodeType: 'db', path: [String(db)], depth, label: cluster ? 'keys' : `db${db}`, expandable: true,
      detail: formatCount(cache?.dbSize || ks?.keys || 0), meta: { db } satisfies DbMeta, forceOpen: !!f,
    });
    if (f) {
      const hits: TreeRow[] = [];
      for (const k of cache?.keys.values() ?? []) {
        const at = k.key.toLowerCase().indexOf(f);
        if (at < 0) continue;
        hits.push(keyRow(base, db, k, k.key, depth + 1, Array.from({ length: f.length }, (_, i) => at + i)));
        if (hits.length >= 200) break;
      }
      if (!hits.length) continue;
      rows.push(dbRow, ...hits);
      continue;
    }
    rows.push(dbRow);
    if (!dbRow.expanded) continue;
    if (!cache || (cache.loading > 0 && cache.keys.size === 0)) {
      rows.push(statusRow(dbRow.id, depth + 1, cache?.error ? 'error' : 'loading', cache?.error ?? 'Scanning keys…'));
      continue;
    }
    if (cache.error) rows.push(statusRow(dbRow.id, depth + 1, 'error', cache.error));
    if (!cache.keys.size) {
      rows.push(statusRow(dbRow.id, depth + 1, 'empty', 'No keys'));
      continue;
    }
    folderRows(base, db, buildKeyIndex([...cache.keys.values()], delimiter), depth + 1, rows);
    if (cache.truncated) {
      rows.push(statusRow(dbRow.id, depth + 1, 'hint', `${formatCount(cache.keys.size)} of ${formatCount(cache.dbSize)} keys: open the browser to scan more`));
    }
  }
  if (f) return rows;
  for (const view of TOOLS) {
    rows.push(sourceRow({ ...base, nodeType: 'tool', path: ['~', view], depth, label: VIEW_TITLE[view] }));
  }
  return rows;
}

/** Explorer lazy loads: server facts when the connection opens; a root scan when a db opens; folder scans. */
export function ensureRedisLoaded(connection: ConnectionProfile, expanded: ReadonlySet<string>): void {
  const cid = connection.id;
  if (!expanded.has(`c:${cid}`)) return;
  const state = useRedis.getState().conns[cid];
  if (!state?.server.data && !state?.server.loading && !state?.server.error) {
    void loadServer(cid);
    return;
  }
  for (const db of visibleDbs(connection)) {
    if (!expanded.has(sourceNodeId(cid, [String(db)]))) continue;
    const cache = cacheOf(cid, db);
    if (!cache?.scanned.has('')) {
      void scanForExplorer(cid, db, '', '*');
      continue;
    }
    if (!cache.truncated) continue;
    const prefix = `x:${cid}:${encodeURIComponent(String(db))}/`;
    for (const id of expanded) {
      if (!id.startsWith(prefix)) continue;
      const folder = decodeURIComponent(id.slice(prefix.length));
      if (folder && !cache.scanned.has(folder) && !cache.keys.has(folder)) void scanForExplorer(cid, db, folder, folderPattern(folder));
    }
  }
}

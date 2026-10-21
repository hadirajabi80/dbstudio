// Redis mock routes and stream emitters (docs/PLAN-M2.md section 5, package M2-R): an in-memory Redis with a 5k-key
// fixture (hashes, lists, sets, sorted sets, streams with consumer groups, RedisJSON documents, strings with TTLs,
// a binary value), SCAN with cursors, typed values with paging, every mutation (READ_ONLY on read-only profiles), a
// small command interpreter for the Workbench/CLI (blocked commands, SELECT tracking), pub/sub, MONITOR (with the
// auto-stop), slowlog, INFO with moving counters, CLIENT LIST/KILL, CONFIG and the delete-pattern / analysis jobs.
import { http, HttpResponse, type RequestHandler } from 'msw';
import type {
  RedisAnalysisNamespace, RedisAnalysisResult, RedisClientInfo, RedisCommandResult, RedisKeySummary, RedisKeyType, RedisKeyValue,
  RedisReplyValue, RedisSlowlogEntry, RedisStreamEntry, RedisStreamGroup,
} from '../../api/types';
import { parseArgs } from '../../redis/args';
import { findCommand } from '../../redis/catalog';
import { globMatch } from '../../redis/glob';
import { M2_PREFIX, type M2MockContext } from './index';

// ------------------------------------------------------------------------------------------------ model

interface MockStream {
  entries: RedisStreamEntry[];
  groups: Map<string, { last: string; consumers: Map<string, number>; pending: Map<string, { consumer: string; at: number; count: number }> }>;
}

type Val =
  | { type: 'string'; v: string; hex?: boolean }
  | { type: 'hash'; v: Map<string, string> }
  | { type: 'list'; v: string[] }
  | { type: 'set'; v: Set<string> }
  | { type: 'zset'; v: Map<string, number> }
  | { type: 'stream'; v: MockStream }
  | { type: 'rejson'; v: unknown };

interface Entry { val: Val; expiresAt: number | null }

class MockDb {
  readonly map = new Map<string, Entry>();
  /** SCAN order: keys are appended once (tombstones stay), so cursors stay valid while keys are deleted. */
  readonly order: string[] = [];
  private readonly ordered = new Set<string>();

  get(key: string): Entry | undefined {
    const e = this.map.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  set(key: string, val: Val, expiresAt: number | null = null): void {
    if (!this.ordered.has(key)) {
      this.ordered.add(key);
      this.order.push(key);
    }
    this.map.set(key, { val, expiresAt });
  }

  delete(key: string): boolean {
    return !!this.get(key) && this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.order.length = 0;
    this.ordered.clear();
  }

  size(): number {
    let n = 0;
    for (const k of this.map.keys()) if (this.get(k)) n++;
    return n;
  }
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Alice', 'Bob', 'Carla', 'Dmitri', 'Erin', 'Farah', 'Goran', 'Hana', 'Ivo', 'Jules', 'Kemal', 'Lena', 'Milo', 'Nora'];
const CITIES = ['Berlin', 'Paris', 'Lisbon', 'Oslo', 'Austin', 'Osaka', 'Lyon'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
/** Right-to-left sample names (Persian, Arabic) for a few user profiles. */
const RTL_NAMES: Record<number, string> = { 2: 'علی رضایی', 3: 'مریم احمدی', 4: 'محمد' };

export const MOCK_REDIS_KEY_COUNT = 5000;

/** The 5k-key fixture of db 0 (+ a few keys in db 1). Deterministic. */
export function createRedisFixture(): Map<number, MockDb> {
  const rnd = prng(42);
  const now = Date.now();
  const dbs = new Map<number, MockDb>();
  const db = new MockDb();
  dbs.set(0, db);
  let n = 0;
  const add = (key: string, val: Val, ttlSeconds: number | null = null) => {
    db.set(key, val, ttlSeconds === null ? null : now + ttlSeconds * 1000);
    n++;
  };
  // signature keys used by the walkthrough
  add('greeting', { type: 'string', v: 'hello world' });
  add('config:feature-flags', { type: 'string', v: JSON.stringify({ darkMode: true, beta: ['search', 'export'], rollout: 0.25 }) });
  add('bin:thumbnail', { type: 'string', v: '89504e470d0a1a0a0000000d49484452', hex: true });
  add('counter:visits', { type: 'string', v: '48213' });
  add('leaderboard:daily', { type: 'zset', v: new Map(FIRST.map((f, i) => [f.toLowerCase(), 1000 + ((i * 337) % 900)])) });
  add('leaderboard:weekly', { type: 'zset', v: new Map(Array.from({ length: 450 }, (_, i) => [`player:${i}`, Math.round(rnd() * 100_000)])) });
  add('queue:emails', { type: 'list', v: Array.from({ length: 640 }, (_, i) => JSON.stringify({ to: `user${i}@example.com`, template: 'welcome' })) });
  add('queue:jobs', { type: 'list', v: ['job:1', 'job:2', 'job:3', 'job:4'] });
  const orders: RedisStreamEntry[] = [];
  for (let i = 0; i < 260; i++) orders.push({ id: `${1_760_000_000_000 + i * 1000}-0`, fields: { type: i % 5 === 0 ? 'refund' : 'purchase', user: String(1000 + (i % 90)), amount: (rnd() * 200).toFixed(2) } });
  const ordersStream: MockStream = { entries: orders, groups: new Map() };
  ordersStream.groups.set('billing', {
    last: orders[249].id, consumers: new Map([['billing-1', now - 4000], ['billing-2', now - 61_000]]),
    pending: new Map(orders.slice(240, 250).map((e, i) => [e.id, { consumer: i % 2 ? 'billing-2' : 'billing-1', at: now - i * 5000, count: 1 + (i % 3) }])),
  });
  ordersStream.groups.set('analytics', { last: orders[259].id, consumers: new Map([['etl', now - 900]]), pending: new Map() });
  add('events:orders', { type: 'stream', v: ordersStream });
  add('events:logins', { type: 'stream', v: { entries: Array.from({ length: 30 }, (_, i) => ({ id: `${1_760_100_000_000 + i * 60_000}-0`, fields: { user: String(1000 + i), ip: `10.0.0.${i}` } })), groups: new Map() } });
  for (let i = 1; i <= 200; i++) {
    add(`doc:product:${i}`, { type: 'rejson', v: { sku: `SKU-${1000 + i}`, name: `Product ${i}`, price: Math.round(rnd() * 10_000) / 100, tags: ['coffee', i % 2 ? 'beans' : 'gear'], stock: { eu: Math.round(rnd() * 50), us: Math.round(rnd() * 50) } } });
  }
  for (let i = 1; i <= 1100; i++) {
    const f = FIRST[i % FIRST.length];
    add(`user:${1000 + i}:profile`, { type: 'hash', v: new Map([['name', RTL_NAMES[i] ?? `${f} ${String.fromCharCode(65 + (i % 26))}.`], ['email', `${f.toLowerCase()}${i}@example.com`], ['city', CITIES[i % CITIES.length]], ['tier', TIERS[i % TIERS.length]], ['visits', String(i * 7 % 300)]]) });
    if (i <= 500) add(`user:${1000 + i}:cart`, { type: 'list', v: Array.from({ length: 1 + (i % 4) }, (_, j) => `sku:${(i * 13 + j) % 400}`) });
  }
  for (let i = 0; i < 900; i++) add(`session:${(0x10000 + i * 7919).toString(16)}`, { type: 'string', v: JSON.stringify({ user: 1000 + (i % 1100), ua: 'Mozilla/5.0' }) }, 300 + ((i * 97) % 7000));
  for (let i = 0; i < 300; i++) add(`tags:post:${i}`, { type: 'set', v: new Set(['redis', 'cache', 'db', 'kv', 'nosql', 'fast'].filter((_, j) => (i + j) % 3 !== 0)) });
  add('tags:all', { type: 'set', v: new Set(Array.from({ length: 320 }, (_, i) => `tag-${i}`)) });
  while (n < MOCK_REDIS_KEY_COUNT) {
    const i = n;
    add(`cache:page:/articles/${i}`, { type: 'string', v: `<html><body>Article ${i}</body></html>` }, i % 3 === 0 ? 86_400 : null);
  }
  const db1 = new MockDb();
  db1.set('jobs:scheduled', { type: 'zset', v: new Map([['cleanup', now / 1000 + 3600], ['report', now / 1000 + 7200]]) }, null);
  db1.set('lock:migration', { type: 'string', v: 'host-7' }, now + 120_000);
  dbs.set(1, db1);
  return dbs;
}

const enc = (s: string) => new TextEncoder().encode(s).length;

function memoryOf(val: Val, key: string): number {
  const base = 56 + enc(key);
  switch (val.type) {
    case 'string': return base + (val.hex ? val.v.length / 2 : enc(val.v));
    case 'hash': return base + [...val.v].reduce((s, [f, v]) => s + enc(f) + enc(v) + 16, 0);
    case 'list': return base + val.v.reduce((s, v) => s + enc(v) + 11, 0);
    case 'set': return base + [...val.v].reduce((s, v) => s + enc(v) + 8, 0);
    case 'zset': return base + [...val.v.keys()].reduce((s, v) => s + enc(v) + 24, 0);
    case 'stream': return base + val.v.entries.reduce((s, e) => s + 24 + Object.entries(e.fields).reduce((t, [f, v]) => t + enc(f) + enc(v), 0), 0);
    case 'rejson': return base + enc(JSON.stringify(val.v)) * 2;
  }
}

function encodingOf(val: Val): string {
  switch (val.type) {
    case 'string': return /^-?\d+$/.test(val.v) ? 'int' : val.v.length <= 44 ? 'embstr' : 'raw';
    case 'hash': return val.v.size <= 128 ? 'listpack' : 'hashtable';
    case 'list': return 'quicklist';
    case 'set': return val.v.size <= 128 ? 'listpack' : 'hashtable';
    case 'zset': return val.v.size <= 128 ? 'listpack' : 'skiplist';
    case 'stream': return 'stream';
    case 'rejson': return 'raw';
  }
}

const ttlOf = (e: Entry) => (e.expiresAt === null ? -1 : Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000)));

function compareIds(a: string, b: string): number {
  const [am, as] = a.split('-').map((x) => BigInt(x || '0'));
  const [bm, bs] = b.split('-').map((x) => BigInt(x || '0'));
  return am === bm ? (as === bs ? 0 : as < bs ? -1 : 1) : am < bm ? -1 : 1;
}

// ------------------------------------------------------------------------------------------------ helpers

const err = (status: number, code: string, message: string, detail?: unknown) =>
  HttpResponse.json({ error: { code, message, detail } }, { status });

const noContent = () => new HttpResponse(null, { status: 204 });

class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** What MSW hands a resolver (the parts the Redis routes read). */
interface RouteInfo { params: Record<string, string | readonly string[] | undefined>; request: Request }

interface ValOf { string: string; hash: Map<string, string>; list: string[]; set: Set<string>; zset: Map<string, number>; stream: MockStream; rejson: unknown }

/** The `{key}` segment of /redis/:cid/keys/:key/... decoded once (keys may contain `/`). */
function keyOf(url: string): string {
  const parts = new URL(url).pathname.split('/');
  const i = parts.indexOf('keys');
  return decodeURIComponent(parts[i + 1] ?? '');
}

async function body<T>(request: Request): Promise<Partial<T>> {
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

const SLOWLOG_COMMANDS: string[][] = [
  ['KEYS', '*'], ['HGETALL', 'user:1042:profile'], ['ZRANGE', 'leaderboard:weekly', '0', '-1', 'WITHSCORES'], ['LRANGE', 'queue:emails', '0', '-1'],
  ['SMEMBERS', 'tags:all'], ['SCAN', '0', 'MATCH', 'session:*', 'COUNT', '10000'], ['EVAL', 'return redis.call("DBSIZE")', '0'], ['DEL', 'cache:page:/articles/17'],
];

const MONITOR_SAMPLES: string[][] = [
  ['GET', 'session:1a2b3'], ['HGET', 'user:1042:profile', 'email'], ['INCR', 'counter:visits'], ['EXPIRE', 'session:1a2b3', '3600'],
  ['ZINCRBY', 'leaderboard:daily', '5', 'alice'], ['LPUSH', 'queue:jobs', 'job:9'], ['PING'], ['SET', 'cache:page:/home', '<html>…</html>', 'EX', '60'],
];

const DEMO_CHANNELS = ['notifications', 'orders.eu', 'orders.us', 'chat:general'];

interface Subscription { channels: string[]; patterns: string[]; push: (items: unknown[]) => void }

/** Per-connection mock server state. */
class MockRedisServer {
  dbs = createRedisFixture();
  slowlog: RedisSlowlogEntry[];
  clients: RedisClientInfo[];
  config: Record<string, string> = {
    'slowlog-log-slower-than': '10000', 'slowlog-max-len': '128', maxmemory: '0', 'maxmemory-policy': 'noeviction', databases: '16', timeout: '0',
    appendonly: 'no', save: '3600 1 300 100 60 10000',
  };
  monitors = new Set<(items: unknown[]) => void>();
  subs = new Set<Subscription>();
  commandsProcessed = 1_204_331;
  startedAt = Date.now() - 3 * 86_400_000 - 4 * 3_600_000;

  constructor() {
    const now = Math.floor(Date.now() / 1000);
    this.slowlog = Array.from({ length: 24 }, (_, i) => {
      const args = SLOWLOG_COMMANDS[i % SLOWLOG_COMMANDS.length];
      return { id: 124 - i, ts: new Date((now - i * 517) * 1000).toISOString(), durationUs: 12_000 + ((i * 7919) % 180_000), args, client: `10.0.1.${10 + (i % 5)}:5${1000 + i}`, name: i % 3 ? null : 'worker' };
    });
    this.clients = [
      { id: '7', addr: '127.0.0.1:52011', name: 'DbStudio', user: 'default', db: 0, ageSeconds: 120, idleSeconds: 0, cmd: 'client|list', flags: 'N', fields: {} },
      { id: '12', addr: '10.0.1.10:51120', name: 'api-1', user: 'app', db: 0, ageSeconds: 86_400, idleSeconds: 2, cmd: 'get', flags: 'N', fields: {} },
      { id: '13', addr: '10.0.1.11:51121', name: 'api-2', user: 'app', db: 0, ageSeconds: 86_399, idleSeconds: 1, cmd: 'hget', flags: 'N', fields: {} },
      { id: '21', addr: '10.0.1.20:40001', name: 'worker', user: 'jobs', db: 1, ageSeconds: 3600, idleSeconds: 30, cmd: 'blpop', flags: 'b', fields: {} },
      { id: '22', addr: '10.0.1.21:40002', name: null, user: 'default', db: 0, ageSeconds: 500, idleSeconds: 500, cmd: 'subscribe', flags: 'P', fields: {} },
      { id: '30', addr: '10.0.2.5:60100', name: 'replica-sync', user: 'replicator', db: 0, ageSeconds: 7200, idleSeconds: 0, cmd: 'replconf', flags: 'S', fields: {} },
    ];
    for (const c of this.clients) c.fields = { id: c.id, addr: c.addr, name: c.name ?? '', user: c.user ?? '', db: String(c.db), age: String(c.ageSeconds), idle: String(c.idleSeconds), flags: c.flags, cmd: c.cmd ?? '' };
  }

  db(n: number): MockDb {
    if (!Number.isInteger(n) || n < 0 || n > 15) throw new Refusal(400, 'VALIDATION', `Database ${n} does not exist (the server has 16).`);
    let d = this.dbs.get(n);
    if (!d) {
      d = new MockDb();
      this.dbs.set(n, d);
    }
    return d;
  }

  echo(db: number, args: string[]): void {
    this.commandsProcessed++;
    if (!this.monitors.size) return;
    const item = { ts: new Date().toISOString(), db, client: '127.0.0.1:52011', args };
    for (const m of this.monitors) m([item]);
  }

  publish(channel: string, payload: string): number {
    let n = 0;
    for (const s of this.subs) {
      const items: unknown[] = [];
      if (s.channels.includes(channel)) items.push({ ts: new Date().toISOString(), channel, payload });
      for (const p of s.patterns) if (globMatch(p, channel)) items.push({ ts: new Date().toISOString(), channel, pattern: p, payload });
      if (items.length) {
        n += items.length;
        s.push(items);
      }
    }
    return n + this.clients.filter((c) => c.flags === 'P').length * (channel === 'notifications' ? 1 : 0);
  }
}

// ------------------------------------------------------------------------------------------------ handlers

export function createRedisHandlers(ctx: M2MockContext): RequestHandler[] {
  const P = `${M2_PREFIX}/redis/:cid`;
  const servers = new Map<string, MockRedisServer>();
  const serverOf = (cid: string) => {
    let s = servers.get(cid);
    if (!s) {
      s = new MockRedisServer();
      servers.set(cid, s);
    }
    return s;
  };

  /** Opens the source client (503 for unreachable hosts), checks the provider; returns the server. */
  const open = (cid: string) => {
    const r = ctx.clients.get(cid);
    if (!('connectionId' in r)) throw new Refusal(r.status, r.code, r.message);
    const conn = ctx.engine.conn(cid);
    if (conn?.providerId !== 'redis') throw new Refusal(400, 'VALIDATION', `Connection '${cid}' is not a Redis connection.`);
    return { server: serverOf(cid), conn };
  };
  const writable = (cid: string, action: string) => {
    const { server, conn } = open(cid);
    if (conn.readOnly) throw new Refusal(403, 'READ_ONLY', `The connection '${conn.name}' is read-only: ${action} is not allowed.`);
    return server;
  };
  const route = (fn: (info: RouteInfo) => Promise<Response> | Response) => async (info: RouteInfo): Promise<Response> => {
    try {
      return await fn(info);
    } catch (e) {
      if (e instanceof Refusal) return err(e.status, e.code, e.message);
      throw e;
    }
  };
  const dbParam = (url: string) => Number(new URL(url).searchParams.get('db') ?? 0);
  const entryOf = (server: MockRedisServer, db: number, key: string) => {
    const e = server.db(db).get(key);
    if (!e) throw new Refusal(404, 'NOT_FOUND', `Key '${key}' was not found.`);
    return e;
  };
  const expectType = <T extends Val['type']>(e: Entry, type: T): Extract<Val, { type: T }> => {
    if (e.val.type !== type) throw new Refusal(400, 'PROVIDER_ERROR', 'WRONGTYPE Operation against a key holding the wrong kind of value');
    return e.val as Extract<Val, { type: T }>;
  };
  const getOrCreate = <T extends keyof ValOf>(d: MockDb, key: string, type: T, make: () => ValOf[T]): ValOf[T] => {
    const e = d.get(key);
    if (e) return expectType(e, type).v as ValOf[T];
    const v = make();
    d.set(key, { type, v } as Val);
    return v;
  };
  // ---- streams
  ctx.streams.register('redis.monitor', ({ connectionId, params, push, end, signal }) => {
    const server = serverOf(connectionId);
    const minutes = typeof params.maxMinutes === 'number' ? params.maxMinutes : 10;
    let i = 0;
    const tick = setInterval(() => {
      const batch = Array.from({ length: 1 + (i % 4) }, (_, j) => ({
        ts: new Date().toISOString(), db: (i + j) % 7 === 0 ? 1 : 0, client: `10.0.1.${10 + ((i + j) % 4)}:5${1100 + j}`, args: MONITOR_SAMPLES[(i + j) % MONITOR_SAMPLES.length],
      }));
      i++;
      push(batch);
    }, 400);
    server.monitors.add(push);
    const stop = setTimeout(() => end('completed'), minutes * 60_000);
    signal.addEventListener('abort', () => {
      clearInterval(tick);
      clearTimeout(stop);
      server.monitors.delete(push);
    });
  });

  ctx.streams.register('redis.subscribe', ({ connectionId, params, push, signal }) => {
    const server = serverOf(connectionId);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
    const sub: Subscription = { channels: list(params.channels), patterns: list(params.patterns), push };
    server.subs.add(sub);
    let i = 0;
    const tick = setInterval(() => {
      const channel = DEMO_CHANNELS[i % DEMO_CHANNELS.length];
      const payload = channel.startsWith('orders')
        ? JSON.stringify({ orderId: 5000 + i, total: Math.round(((i * 37) % 900) * 1.13) / 10, items: 1 + (i % 4) })
        : channel === 'notifications' ? `User ${1000 + (i % 90)} signed in` : `message ${i}`;
      i++;
      const items: unknown[] = [];
      if (sub.channels.includes(channel)) items.push({ ts: new Date().toISOString(), channel, payload });
      for (const p of sub.patterns) if (globMatch(p, channel)) items.push({ ts: new Date().toISOString(), channel, pattern: p, payload });
      if (items.length) push(items);
    }, 700);
    signal.addEventListener('abort', () => {
      clearInterval(tick);
      server.subs.delete(sub);
    });
  });

  // ---- value reader
  function readValue(server: MockRedisServer, db: number, key: string, q: URLSearchParams): RedisKeyValue {
    const e = entryOf(server, db, key);
    const header = { key, db, ttl: ttlOf(e), objectEncoding: encodingOf(e.val), memory: memoryOf(e.val, key) };
    const count = Number(q.get('count') ?? 0) || 0;
    const cursor = q.get('cursor') ?? '0';
    const field = q.get('field') ?? '';
    const page = <T>(all: T[], size: number, match: (x: T) => string) => {
      const filtered = field ? all.filter((x) => globMatch(field, match(x))) : all;
      const start = Number(cursor.replace(/^i:/, '')) || 0;
      const slice = filtered.slice(start, start + size);
      return { slice, next: start + size < filtered.length ? String(start + size) : '0' };
    };
    const v = e.val;
    switch (v.type) {
      case 'string': {
        const isJson = !v.hex && /^\s*[[{]/.test(v.v) && (() => { try { JSON.parse(v.v); return true; } catch { return false; } })();
        return { ...header, type: 'string', value: v.v, encoding: v.hex ? 'hex' : 'utf8', isJson, length: v.hex ? v.v.length / 2 : enc(v.v) };
      }
      case 'hash': {
        const { slice, next } = page([...v.v], count || 200, ([f]) => f);
        return { ...header, type: 'hash', fields: slice.map(([f, val]) => ({ field: f, value: val })), cursor: next, length: v.v.size };
      }
      case 'list': {
        const start = Number(q.get('start') ?? 0);
        const stop = q.get('stop') !== null ? Number(q.get('stop')) : start + (count || 200) - 1;
        const items = v.v.slice(start, stop + 1).map((value, i) => ({ index: start + i, value }));
        return { ...header, type: 'list', items, length: v.v.length, start, stop: start + items.length - 1 };
      }
      case 'set': {
        const { slice, next } = page([...v.v], count || 200, (m) => m);
        return { ...header, type: 'set', members: slice, cursor: next, length: v.v.size };
      }
      case 'zset': {
        const sorted = [...v.v].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
        const { slice, next } = page(sorted, count || 200, ([m]) => m);
        return { ...header, type: 'zset', members: slice.map(([member, score]) => ({ member, score })), cursor: next === '0' ? '0' : field ? next : `i:${next}`, length: v.v.size };
      }
      case 'stream': {
        const size = count || 100;
        let stop = q.get('stop') ?? '+';
        const exclusive = stop.startsWith('(');
        if (exclusive) stop = stop.slice(1);
        const newestFirst = [...v.v.entries].reverse().filter((x) => stop === '+' || (exclusive ? compareIds(x.id, stop) < 0 : compareIds(x.id, stop) <= 0));
        const groups: RedisStreamGroup[] = [...v.v.groups].map(([name, g]) => ({
          name, consumers: g.consumers.size, pending: g.pending.size, lastDeliveredId: g.last,
          lag: v.v.entries.filter((x) => compareIds(x.id, g.last) > 0).length,
        }));
        return {
          ...header, type: 'stream', entries: newestFirst.slice(0, size), length: v.v.entries.length,
          firstId: v.v.entries[0]?.id ?? null, lastId: v.v.entries.at(-1)?.id ?? null, groups,
        };
      }
      case 'rejson':
        return { ...header, type: 'rejson', json: structuredClone(v.v), path: '$' };
    }
  }

  // ---- command interpreter (Workbench / CLI)
  function runCommand(server: MockRedisServer, dbRef: { db: number }, args: string[], readOnly: boolean, name: string): RedisCommandResult {
    const t0 = performance.now();
    const ok = (type: RedisCommandResult['type'], value: RedisReplyValue): RedisCommandResult => ({ ok: true, type, value, elapsedMs: Math.round(performance.now() - t0) });
    const fail = (message: string): RedisCommandResult => ({ ok: false, type: 'error', value: message, elapsedMs: 0 });
    const cmd = args[0].toUpperCase();
    const d = server.db(dbRef.db);
    const a = args.slice(1);
    const arity = (n: number) => a.length < n;
    void readOnly;
    void name;
    server.echo(dbRef.db, args);
    try {
      switch (cmd) {
        case 'PING': return a.length ? ok('bulk', a[0]) : ok('simple', 'PONG');
        case 'ECHO': return arity(1) ? fail("ERR wrong number of arguments for 'echo' command") : ok('bulk', a[0]);
        case 'TIME': return ok('array', [String(Math.floor(Date.now() / 1000)), '0']);
        case 'SELECT': {
          const n = Number(a[0]);
          if (!Number.isInteger(n) || n < 0 || n > 15) return fail('ERR DB index is out of range');
          dbRef.db = n;
          return ok('simple', 'OK');
        }
        case 'DBSIZE': return ok('int', d.size());
        case 'FLUSHDB': d.clear(); return ok('simple', 'OK');
        case 'GET': {
          const e = d.get(a[0]);
          if (!e) return ok('null', null);
          return ok('bulk', expectType(e, 'string').v);
        }
        case 'SET': {
          if (arity(2)) return fail("ERR wrong number of arguments for 'set' command");
          const exIdx = a.findIndex((x) => x.toUpperCase() === 'EX');
          const exp = exIdx > 0 ? Date.now() + Number(a[exIdx + 1]) * 1000 : a.some((x) => x.toUpperCase() === 'KEEPTTL') ? d.get(a[0])?.expiresAt ?? null : null;
          if (a.some((x) => x.toUpperCase() === 'NX') && d.get(a[0])) return ok('null', null);
          d.set(a[0], { type: 'string', v: a[1] }, exp);
          return ok('simple', 'OK');
        }
        case 'INCR': case 'INCRBY': case 'DECR': {
          const e = d.get(a[0]);
          const cur = e ? Number(expectType(e, 'string').v) : 0;
          if (!Number.isInteger(cur)) return fail('ERR value is not an integer or out of range');
          const by = cmd === 'INCRBY' ? Number(a[1]) : cmd === 'DECR' ? -1 : 1;
          d.set(a[0], { type: 'string', v: String(cur + by) }, e?.expiresAt ?? null);
          return ok('int', cur + by);
        }
        case 'APPEND': {
          const e = d.get(a[0]);
          const next = (e ? expectType(e, 'string').v : '') + a[1];
          d.set(a[0], { type: 'string', v: next }, e?.expiresAt ?? null);
          return ok('int', enc(next));
        }
        case 'STRLEN': { const e = d.get(a[0]); return ok('int', e ? enc(expectType(e, 'string').v) : 0); }
        case 'MGET': return ok('array', a.map((k) => { const e = d.get(k); return e?.val.type === 'string' ? e.val.v : null; }));
        case 'DEL': case 'UNLINK': return ok('int', a.filter((k) => d.delete(k)).length);
        case 'EXISTS': return ok('int', a.filter((k) => d.get(k)).length);
        case 'TYPE': { const e = d.get(a[0]); return ok('simple', e ? (e.val.type === 'rejson' ? 'ReJSON-RL' : e.val.type) : 'none'); }
        case 'TTL': { const e = d.get(a[0]); return ok('int', e ? ttlOf(e) : -2); }
        case 'PTTL': { const e = d.get(a[0]); return ok('int', e ? (e.expiresAt === null ? -1 : e.expiresAt - Date.now()) : -2); }
        case 'EXPIRE': { const e = d.get(a[0]); if (!e) return ok('int', 0); e.expiresAt = Date.now() + Number(a[1]) * 1000; return ok('int', 1); }
        case 'PERSIST': { const e = d.get(a[0]); if (!e || e.expiresAt === null) return ok('int', 0); e.expiresAt = null; return ok('int', 1); }
        case 'RENAME': {
          const e = d.get(a[0]);
          if (!e) return fail('ERR no such key');
          d.delete(a[0]);
          d.set(a[1], e.val, e.expiresAt);
          return ok('simple', 'OK');
        }
        case 'KEYS': return ok('array', d.order.filter((k) => d.get(k) && globMatch(a[0] ?? '*', k)).slice(0, 10_000));
        case 'SCAN': {
          const cursor = Number(a[0] ?? 0);
          const mi = a.findIndex((x) => x.toUpperCase() === 'MATCH');
          const ci = a.findIndex((x) => x.toUpperCase() === 'COUNT');
          const pattern = mi >= 0 ? a[mi + 1] : '*';
          const count = ci >= 0 ? Number(a[ci + 1]) : 10;
          const end = Math.min(d.order.length, cursor + count);
          const keys = d.order.slice(cursor, end).filter((k) => d.get(k) && globMatch(pattern, k));
          return ok('array', [end >= d.order.length ? '0' : String(end), keys]);
        }
        case 'HGET': { const e = d.get(a[0]); return e ? ok(expectType(e, 'hash').v.has(a[1]) ? 'bulk' : 'null', expectType(e, 'hash').v.get(a[1]) ?? null) : ok('null', null); }
        case 'HGETALL': { const e = d.get(a[0]); return ok('array', e ? [...expectType(e, 'hash').v].flat() : []); }
        case 'HLEN': { const e = d.get(a[0]); return ok('int', e ? expectType(e, 'hash').v.size : 0); }
        case 'HSET': {
          if (a.length < 3 || a.length % 2 === 0) return fail("ERR wrong number of arguments for 'hset' command");
          const h = getOrCreate(d, a[0], 'hash', () => new Map());
          let added = 0;
          for (let i = 1; i + 1 < a.length; i += 2) { if (!h.has(a[i])) added++; h.set(a[i], a[i + 1]); }
          return ok('int', added);
        }
        case 'HDEL': { const e = d.get(a[0]); if (!e) return ok('int', 0); const h = expectType(e, 'hash').v; return ok('int', a.slice(1).filter((f) => h.delete(f)).length); }
        case 'LPUSH': case 'RPUSH': {
          const l = getOrCreate(d, a[0], 'list', () => []);
          for (const x of a.slice(1)) { if (cmd === 'LPUSH') l.unshift(x); else l.push(x); }
          return ok('int', l.length);
        }
        case 'LLEN': { const e = d.get(a[0]); return ok('int', e ? expectType(e, 'list').v.length : 0); }
        case 'LRANGE': {
          const e = d.get(a[0]);
          if (!e) return ok('array', []);
          const l = expectType(e, 'list').v;
          const s = Number(a[1]) < 0 ? Math.max(0, l.length + Number(a[1])) : Number(a[1]);
          const t = Number(a[2]) < 0 ? l.length + Number(a[2]) : Number(a[2]);
          return ok('array', l.slice(s, t + 1));
        }
        case 'LPOP': case 'RPOP': { const e = d.get(a[0]); if (!e) return ok('null', null); const l = expectType(e, 'list').v; return ok('bulk', (cmd === 'LPOP' ? l.shift() : l.pop()) ?? null); }
        case 'SADD': { const s = getOrCreate(d, a[0], 'set', () => new Set()); let n = 0; for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; } return ok('int', n); }
        case 'SMEMBERS': { const e = d.get(a[0]); return ok('array', e ? [...expectType(e, 'set').v] : []); }
        case 'SCARD': { const e = d.get(a[0]); return ok('int', e ? expectType(e, 'set').v.size : 0); }
        case 'SISMEMBER': { const e = d.get(a[0]); return ok('int', e && expectType(e, 'set').v.has(a[1]) ? 1 : 0); }
        case 'ZADD': {
          const z = getOrCreate(d, a[0], 'zset', () => new Map());
          let n = 0;
          for (let i = 1; i + 1 < a.length; i += 2) { if (!z.has(a[i + 1])) n++; z.set(a[i + 1], Number(a[i])); }
          return ok('int', n);
        }
        case 'ZCARD': { const e = d.get(a[0]); return ok('int', e ? expectType(e, 'zset').v.size : 0); }
        case 'ZSCORE': { const e = d.get(a[0]); const s = e ? expectType(e, 'zset').v.get(a[1]) : undefined; return s === undefined ? ok('null', null) : ok('bulk', String(s)); }
        case 'ZRANGE': case 'ZREVRANGE': {
          const e = d.get(a[0]);
          if (!e) return ok('array', []);
          const sorted = [...expectType(e, 'zset').v].sort((x, y) => x[1] - y[1]);
          if (cmd === 'ZREVRANGE' || a.some((x) => x.toUpperCase() === 'REV')) sorted.reverse();
          const s = Number(a[1]);
          const t = Number(a[2]) < 0 ? sorted.length + Number(a[2]) : Number(a[2]);
          const slice = sorted.slice(s, t + 1);
          return ok('array', a.some((x) => x.toUpperCase() === 'WITHSCORES') ? slice.flatMap(([m, sc]) => [m, String(sc)]) : slice.map(([m]) => m));
        }
        case 'XLEN': { const e = d.get(a[0]); return ok('int', e ? expectType(e, 'stream').v.entries.length : 0); }
        case 'XADD': {
          const st = getOrCreate(d, a[0], 'stream', () => ({ entries: [], groups: new Map() }));
          const id = a[1] === '*' ? `${Date.now()}-0` : a[1];
          const fields: Record<string, string> = {};
          for (let i = 2; i + 1 < a.length; i += 2) fields[a[i]] = a[i + 1];
          st.entries.push({ id, fields });
          return ok('bulk', id);
        }
        case 'XRANGE': case 'XREVRANGE': {
          const e = d.get(a[0]);
          if (!e) return ok('array', []);
          const list = expectType(e, 'stream').v.entries.slice();
          if (cmd === 'XREVRANGE') list.reverse();
          const ci = a.findIndex((x) => x.toUpperCase() === 'COUNT');
          return ok('array', list.slice(0, ci > 0 ? Number(a[ci + 1]) : list.length).map((x) => [x.id, Object.entries(x.fields).flat()]));
        }
        case 'XINFO': {
          const e = d.get(a[1]);
          if (!e) return fail('ERR no such key');
          const st = expectType(e, 'stream').v;
          if (a[0].toUpperCase() === 'GROUPS') return ok('array', [...st.groups].map(([n, g]) => ['name', n, 'consumers', g.consumers.size, 'pending', g.pending.size, 'last-delivered-id', g.last]));
          return ok('array', ['length', st.entries.length, 'groups', st.groups.size, 'last-generated-id', st.entries.at(-1)?.id ?? '0-0']);
        }
        case 'JSON.GET': { const e = d.get(a[0]); return e ? ok('bulk', JSON.stringify(a[1] === '$' ? [expectType(e, 'rejson').v] : expectType(e, 'rejson').v)) : ok('null', null); }
        case 'JSON.SET': {
          if (a[1] !== '$' && a[1] !== '.') return fail('ERR the mock supports root paths only');
          try { d.set(a[0], { type: 'rejson', v: JSON.parse(a[2]) }, d.get(a[0])?.expiresAt ?? null); } catch { return fail('ERR expected value'); }
          return ok('simple', 'OK');
        }
        case 'INFO': return ok('bulk', infoText(server, a[0]));
        case 'CONFIG': {
          if (a[0]?.toUpperCase() === 'GET') return ok('array', Object.entries(server.config).filter(([k]) => globMatch(a[1] ?? '*', k)).flat());
          if (a[0]?.toUpperCase() === 'SET') { server.config[a[1]] = a[2]; return ok('simple', 'OK'); }
          return fail('ERR unknown subcommand');
        }
        case 'CLIENT': {
          const sub = a[0]?.toUpperCase();
          if (sub === 'LIST') return ok('bulk', server.clients.map((c) => Object.entries(c.fields).map(([k, v]) => `${k}=${v}`).join(' ')).join('\n') + '\n');
          if (sub === 'ID') return ok('int', 7);
          if (sub === 'GETNAME') return ok('bulk', 'DbStudio');
          return fail('ERR unknown subcommand');
        }
        case 'SLOWLOG': {
          if (a[0]?.toUpperCase() === 'LEN') return ok('int', server.slowlog.length);
          if (a[0]?.toUpperCase() === 'RESET') { server.slowlog = []; return ok('simple', 'OK'); }
          return ok('array', server.slowlog.slice(0, Number(a[1] ?? 10)).map((e) => [e.id, Math.floor(Date.parse(e.ts) / 1000), e.durationUs, e.args, e.client ?? '', e.name ?? '']));
        }
        case 'MEMORY': { const e = d.get(a[1]); return e ? ok('int', memoryOf(e.val, a[1])) : ok('null', null); }
        case 'OBJECT': { const e = d.get(a[1]); return e ? ok('bulk', encodingOf(e.val)) : ok('null', null); }
        case 'PUBLISH': return ok('int', server.publish(a[0], a[1] ?? ''));
        case 'PUBSUB': return ok('array', DEMO_CHANNELS.filter((c) => [...server.subs].some((s) => s.channels.includes(c))));
        case 'MODULE': return ok('array', [['name', 'ReJSON', 'ver', 20612], ['name', 'search', 'ver', 21005]]);
        case 'MULTI': return ok('simple', 'OK');
        case 'EXEC': return ok('array', []);
        default: return fail(`ERR unknown command '${args[0]}', with args beginning with: ${a.slice(0, 3).map((x) => `'${x}'`).join(' ')}`);
      }
    } catch (e) {
      if (e instanceof Refusal) return fail(e.message);
      throw e;
    }
  }

  function infoText(server: MockRedisServer, section?: string): string {
    const s = infoSections(server);
    const pick = section ? Object.entries(s).filter(([k]) => k === section.toLowerCase()) : Object.entries(s);
    return pick.map(([name, kv]) => `# ${name[0].toUpperCase()}${name.slice(1)}\r\n${Object.entries(kv).map(([k, v]) => `${k}:${v}`).join('\r\n')}\r\n`).join('\r\n');
  }

  function infoSections(server: MockRedisServer): Record<string, Record<string, string>> {
    const t = Date.now() / 1000;
    const wave = (period: number, amp: number) => Math.sin(t / period) * amp;
    const used = Math.round(48_000_000 + wave(37, 3_000_000) + server.db(0).size() * 900);
    server.commandsProcessed += Math.round(1200 + wave(11, 400));
    const hits = 9_420_311 + Math.floor(t % 10_000) * 7;
    const ks: Record<string, string> = {};
    for (const [n, d] of server.dbs) {
      const size = d.size();
      if (!size) continue;
      let expires = 0;
      for (const k of d.map.keys()) if (d.get(k)?.expiresAt !== null && d.get(k)) expires++;
      ks[`db${n}`] = `keys=${size},expires=${expires},avg_ttl=1843000`;
    }
    return {
      server: {
        redis_version: '7.4.1', redis_mode: 'standalone', os: 'Linux 6.8.0 x86_64', arch_bits: '64', tcp_port: '6379',
        uptime_in_seconds: String(Math.floor((Date.now() - server.startedAt) / 1000)), uptime_in_days: String(Math.floor((Date.now() - server.startedAt) / 86_400_000)),
        executable: '/usr/local/bin/redis-server', config_file: '/etc/redis/redis.conf', run_id: '6c1f0b1e4d7a2b9c3e5f8a0d1c2b3a4f5e6d7c8b',
      },
      clients: { connected_clients: String(server.clients.length), blocked_clients: '1', maxclients: '10000', pubsub_clients: String(server.subs.size + 1) },
      memory: {
        used_memory: String(used), used_memory_human: `${(used / 1048576).toFixed(2)}M`, used_memory_peak: String(Math.round(used * 1.35)),
        used_memory_peak_human: `${(used * 1.35 / 1048576).toFixed(2)}M`, used_memory_rss: String(Math.round(used * 1.18)), mem_fragmentation_ratio: (1.18 + wave(53, 0.04)).toFixed(2),
        maxmemory: server.config.maxmemory, maxmemory_policy: server.config['maxmemory-policy'],
      },
      persistence: { loading: '0', rdb_changes_since_last_save: '1932', rdb_last_save_time: String(Math.floor(t) - 1240), aof_enabled: server.config.appendonly === 'yes' ? '1' : '0' },
      stats: {
        total_connections_received: '18231', total_commands_processed: String(server.commandsProcessed), instantaneous_ops_per_sec: String(Math.round(1650 + wave(9, 600) + wave(3, 120))),
        instantaneous_input_kbps: (42 + wave(7, 10)).toFixed(2), instantaneous_output_kbps: (180 + wave(7, 40)).toFixed(2),
        keyspace_hits: String(hits), keyspace_misses: String(Math.round(hits * 0.061)), expired_keys: '88231', evicted_keys: '0',
      },
      replication: { role: 'master', connected_slaves: '1', slave0: 'ip=10.0.2.5,port=6379,state=online,offset=922337,lag=0', master_repl_offset: '922337' },
      cpu: { used_cpu_sys: (812 + t % 100 / 10).toFixed(2), used_cpu_user: (1420 + t % 100 / 7).toFixed(2) },
      keyspace: ks,
    };
  }

  function summary(d: MockDb, key: string): RedisKeySummary | null {
    const e = d.get(key);
    return e ? { key, type: e.val.type as RedisKeyType, ttl: ttlOf(e) } : null;
  }

  function analyse(d: MockDb, limit: number, delimiter: string): RedisAnalysisResult {
    const t0 = Date.now();
    const ns = new Map<string, { keys: number; memory: number; ttlSum: number; ttlN: number; types: Partial<Record<RedisKeyType, number>> }>();
    const byType: RedisAnalysisResult['byType'] = {};
    const top: RedisAnalysisResult['topKeys'] = [];
    const buckets = [{ label: '< 1 hour', maxSeconds: 3600, keys: 0 }, { label: '< 1 day', maxSeconds: 86_400, keys: 0 }, { label: '< 1 week', maxSeconds: 604_800, keys: 0 },
      { label: '< 1 month', maxSeconds: 2_592_000, keys: 0 }, { label: '> 1 month', maxSeconds: null as number | null, keys: 0 }];
    let scanned = 0;
    let noTtl = 0;
    for (const key of d.order) {
      if (scanned >= limit) break;
      const e = d.get(key);
      if (!e) continue;
      scanned++;
      const type = e.val.type as RedisKeyType;
      const mem = memoryOf(e.val, key);
      const ttl = ttlOf(e);
      const t = byType[type] ?? { keys: 0, memory: 0 };
      byType[type] = { keys: t.keys + 1, memory: t.memory + mem };
      if (ttl < 0) noTtl++;
      else buckets.find((b) => b.maxSeconds === null || ttl < b.maxSeconds)!.keys++;
      const prefixes: string[] = [];
      const i1 = key.indexOf(delimiter);
      if (i1 < 0) prefixes.push('');
      else {
        prefixes.push(key.slice(0, i1 + delimiter.length));
        const i2 = key.indexOf(delimiter, i1 + delimiter.length);
        if (i2 > 0) prefixes.push(key.slice(0, i2 + delimiter.length));
      }
      for (const p of prefixes) {
        const n = ns.get(p) ?? { keys: 0, memory: 0, ttlSum: 0, ttlN: 0, types: {} };
        n.keys++;
        n.memory += mem;
        n.types[type] = (n.types[type] ?? 0) + 1;
        if (ttl >= 0) { n.ttlSum += ttl; n.ttlN++; }
        ns.set(p, n);
      }
      top.push({ key, type, memory: mem, ttl });
    }
    top.sort((a, b) => b.memory - a.memory);
    const namespaces: RedisAnalysisNamespace[] = [...ns].sort((a, b) => b[1].memory - a[1].memory).slice(0, 2000)
      .map(([prefix, n]) => ({ prefix, keys: n.keys, memory: n.memory, avgTtl: n.ttlN ? Math.round(n.ttlSum / n.ttlN) : null, types: n.types }));
    const total = d.size();
    return { scanned, totalKeys: total, sampled: scanned < total, namespaces, topKeys: top.slice(0, 100), byType, ttl: { noTtl, buckets }, expiring: scanned - noTtl, elapsedMs: Date.now() - t0 + 840 };
  }

  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); });
  });

  return [
    http.get(`${P}/server`, route(({ params }) => {
      const { server, conn } = open(String(params.cid));
      const keyspace = [...server.dbs].map(([db, d]) => {
        let expires = 0;
        for (const k of d.map.keys()) if (d.get(k)?.expiresAt) expires++;
        return { db, keys: d.size(), expires };
      }).filter((k) => k.keys > 0).sort((a, b) => a.db - b.db);
      return ctx.ok({
        server: { version: 'Redis 7.4.1', productVersion: '7.4.1', serverName: `${String(conn.props.host ?? 'localhost')}:${String(conn.props.port ?? 6379)}`, user: 'default', database: String(conn.props.db ?? 0) },
        mode: 'standalone', modules: ['ReJSON', 'search', 'timeseries'], databases: 16, keyspace, readOnly: !!conn.readOnly,
        delimiter: typeof conn.props.keyDelimiter === 'string' && conn.props.keyDelimiter ? conn.props.keyDelimiter : ':', scanCount: 500,
      });
    })),

    http.post(`${P}/keys/scan`, route(async ({ params, request }) => {
      const { server } = open(String(params.cid));
      const b = await body<{ db: number; pattern: string; type: string | null; cursor: string; count: number }>(request);
      const d = server.db(b.db ?? 0);
      const count = b.count ?? 500;
      const pattern = b.pattern || '*';
      let cursor = Number(b.cursor ?? 0) || 0;
      const keys: RedisKeySummary[] = [];
      let examined = 0;
      while (cursor < d.order.length && keys.length < count && examined < count * 64) {
        const key = d.order[cursor++];
        examined++;
        const s = summary(d, key);
        if (!s || !globMatch(pattern, key) || (b.type && s.type !== b.type)) continue;
        keys.push(s);
      }
      return ctx.ok({ cursor: cursor >= d.order.length ? '0' : String(cursor), keys, scanned: examined, dbSize: d.size() });
    })),

    http.post(`${P}/keys/memory`, route(async ({ params, request }) => {
      const { server } = open(String(params.cid));
      const b = await body<{ db: number; keys: string[] }>(request);
      if ((b.keys?.length ?? 0) > 100) throw new Refusal(400, 'VALIDATION', 'At most 100 keys per request.');
      const d = server.db(b.db ?? 0);
      const sizes: Record<string, number | null> = {};
      for (const k of b.keys ?? []) { const e = d.get(k); sizes[k] = e ? memoryOf(e.val, k) : null; }
      return ctx.ok({ sizes });
    })),

    http.post(`${P}/keys/delete-pattern`, route(async ({ params, request }) => {
      const cid = String(params.cid);
      const server = writable(cid, 'deleting keys by pattern');
      const b = await body<{ db: number; pattern: string }>(request);
      if (!b.pattern) throw new Refusal(400, 'VALIDATION', 'pattern is required.');
      const d = server.db(b.db ?? 0);
      const pattern = b.pattern;
      const jobId = ctx.jobs.start('redis.deletePattern', async (report, signal) => {
        const matches = d.order.filter((k) => d.get(k) && globMatch(pattern, k));
        let deleted = 0;
        for (let i = 0; i < matches.length; i += 250) {
          await sleep(15, signal);
          for (const k of matches.slice(i, i + 250)) if (d.delete(k)) deleted++;
          report(deleted, matches.length, `Deleted ${deleted.toLocaleString('en-US')} keys`);
        }
        return { scanned: d.order.length, deleted };
      });
      return ctx.ok({ jobId }, { status: 202 });
    })),

    http.post(`${P}/keys`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'creating a key');
      const b = await body<{ key: string; db: number; ttl: number | null; type: RedisKeyType; value: string; fields: Record<string, string>; values: string[]; members: unknown[]; json: unknown }>(request);
      if (!b.key) throw new Refusal(400, 'VALIDATION', 'key is required.');
      const d = server.db(b.db ?? 0);
      if (d.get(b.key)) throw new Refusal(400, 'VALIDATION', `Key '${b.key}' already exists.`);
      const exp = b.ttl ? Date.now() + b.ttl * 1000 : null;
      switch (b.type) {
        case 'string': d.set(b.key, { type: 'string', v: b.value ?? '' }, exp); break;
        case 'hash': d.set(b.key, { type: 'hash', v: new Map(Object.entries(b.fields ?? {})) }, exp); break;
        case 'list': d.set(b.key, { type: 'list', v: [...(b.values ?? [])] }, exp); break;
        case 'set': d.set(b.key, { type: 'set', v: new Set((b.members ?? []) as string[]) }, exp); break;
        case 'zset': d.set(b.key, { type: 'zset', v: new Map(((b.members ?? []) as { member: string; score: number }[]).map((m) => [m.member, m.score])) }, exp); break;
        case 'stream': d.set(b.key, { type: 'stream', v: { entries: [{ id: `${Date.now()}-0`, fields: b.fields ?? {} }], groups: new Map() } }, exp); break;
        case 'rejson': d.set(b.key, { type: 'rejson', v: b.json ?? {} }, exp); break;
        default: throw new Refusal(400, 'VALIDATION', 'type must be string, hash, list, set, zset, stream or rejson.');
      }
      server.echo(b.db ?? 0, ['CREATE', b.key]);
      return noContent();
    })),

    http.get(`${P}/keys/:key/stream/groups/:group`, route(({ params, request }) => {
      const { server } = open(String(params.cid));
      const e = entryOf(server, dbParam(request.url), keyOf(request.url));
      const g = expectType(e, 'stream').v.groups.get(String(params.group));
      if (!g) throw new Refusal(400, 'PROVIDER_ERROR', 'NOGROUP No such consumer group');
      return ctx.ok({
        group: String(params.group),
        consumers: [...g.consumers].map(([name, at]) => ({ name, pending: [...g.pending.values()].filter((p) => p.consumer === name).length, idleMs: Date.now() - at, inactiveMs: Date.now() - at })),
        pending: [...g.pending].slice(0, 100).map(([id, p]) => ({ id, consumer: p.consumer, idleMs: Date.now() - p.at, deliveries: p.count })),
      });
    })),

    http.get(`${P}/keys/:key`, route(({ params, request }) => {
      const { server } = open(String(params.cid));
      const url = new URL(request.url);
      return ctx.ok(readValue(server, dbParam(request.url), keyOf(request.url), url.searchParams) as never);
    })),

    http.put(`${P}/keys/:key/string`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing a string value');
      const b = await body<{ value: string }>(request);
      const d = server.db(dbParam(request.url));
      const key = keyOf(request.url);
      d.set(key, { type: 'string', v: b.value ?? '' }, d.get(key)?.expiresAt ?? null);
      server.echo(dbParam(request.url), ['SET', key, b.value ?? '', 'KEEPTTL']);
      return noContent();
    })),

    http.post(`${P}/keys/:key/hash`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing hash fields');
      const b = await body<{ set: Record<string, string>; del: string[] }>(request);
      const d = server.db(dbParam(request.url));
      const h = getOrCreate(d, keyOf(request.url), 'hash', () => new Map());
      for (const f of b.del ?? []) h.delete(f);
      for (const [f, v] of Object.entries(b.set ?? {})) h.set(f, v);
      return noContent();
    })),

    http.post(`${P}/keys/:key/list`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing list items');
      const b = await body<{ push: { side: 'left' | 'right'; values: string[] }; setIndex: { index: number; value: string }; remove: { value: string; count: number } }>(request);
      const d = server.db(dbParam(request.url));
      const l = getOrCreate(d, keyOf(request.url), 'list', () => []);
      if (b.push) { if (b.push.side === 'left') l.unshift(...[...b.push.values].reverse()); else l.push(...b.push.values); }
      else if (b.setIndex) {
        if (b.setIndex.index >= l.length) throw new Refusal(400, 'PROVIDER_ERROR', 'ERR index out of range');
        l[b.setIndex.index] = b.setIndex.value;
      } else if (b.remove) {
        let n = 0;
        for (let i = 0; i < l.length && (b.remove.count === 0 || n < Math.abs(b.remove.count));) { if (l[i] === b.remove.value) { l.splice(i, 1); n++; } else i++; }
      } else throw new Refusal(400, 'VALIDATION', 'Exactly one of push, setIndex or remove is required.');
      return noContent();
    })),

    http.post(`${P}/keys/:key/set`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing set members');
      const b = await body<{ add: string[]; remove: string[] }>(request);
      const s = getOrCreate(server.db(dbParam(request.url)), keyOf(request.url), 'set', () => new Set());
      for (const m of b.remove ?? []) s.delete(m);
      for (const m of b.add ?? []) s.add(m);
      return noContent();
    })),

    http.post(`${P}/keys/:key/zset`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing sorted set members');
      const b = await body<{ add: { member: string; score: number }[]; remove: string[] }>(request);
      const z = getOrCreate(server.db(dbParam(request.url)), keyOf(request.url), 'zset', () => new Map());
      for (const m of b.remove ?? []) z.delete(m);
      for (const m of b.add ?? []) z.set(m.member, m.score);
      return noContent();
    })),

    http.post(`${P}/keys/:key/stream`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing a stream');
      const b = await body<{ add: Record<string, string>; id: string; delete: string[]; ack: { group: string; ids: string[] }; groupCreate: { name: string; id: string }; groupDestroy: string }>(request);
      const e = entryOf(server, dbParam(request.url), keyOf(request.url));
      const st = expectType(e, 'stream').v;
      if (b.add) {
        const last = st.entries.at(-1)?.id ?? '0-0';
        const ms = Date.now();
        const id = b.id && b.id !== '*' ? b.id : `${Math.max(ms, Number(last.split('-')[0]))}-${ms <= Number(last.split('-')[0]) ? Number(last.split('-')[1]) + 1 : 0}`;
        if (compareIds(id, last) <= 0) throw new Refusal(400, 'PROVIDER_ERROR', 'ERR The ID specified in XADD is equal or smaller than the target stream top item');
        st.entries.push({ id, fields: b.add });
        return ctx.ok({ id });
      }
      if (b.delete) { const del = b.delete; st.entries = st.entries.filter((x) => !del.includes(x.id)); }
      else if (b.ack) { const g = st.groups.get(b.ack.group); for (const id of b.ack.ids) g?.pending.delete(id); }
      else if (b.groupCreate) {
        if (st.groups.has(b.groupCreate.name)) throw new Refusal(400, 'PROVIDER_ERROR', 'BUSYGROUP Consumer Group name already exists');
        st.groups.set(b.groupCreate.name, { last: b.groupCreate.id === '$' ? st.entries.at(-1)?.id ?? '0-0' : b.groupCreate.id || '0-0', consumers: new Map(), pending: new Map() });
      } else if (b.groupDestroy) st.groups.delete(b.groupDestroy);
      else throw new Refusal(400, 'VALIDATION', 'Exactly one of add, delete, ack, groupCreate or groupDestroy is required.');
      return noContent();
    })),

    http.put(`${P}/keys/:key/json`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'editing a JSON document');
      const b = await body<{ path: string; value: unknown }>(request);
      const d = server.db(dbParam(request.url));
      const key = keyOf(request.url);
      const e = entryOf(server, dbParam(request.url), key);
      const path = b.path || '$';
      if (path === '$' || path === '.') d.set(key, { type: 'rejson', v: b.value }, e.expiresAt);
      else {
        const doc = expectType(e, 'rejson').v as Record<string, unknown>;
        const parts = path.replace(/^\$\.?/, '').split('.');
        let cur = doc;
        for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
        cur[parts.at(-1)!] = b.value;
      }
      return noContent();
    })),

    http.post(`${P}/keys/:key/rename`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'renaming a key');
      const b = await body<{ newKey: string; overwrite: boolean }>(request);
      const d = server.db(dbParam(request.url));
      const key = keyOf(request.url);
      const e = entryOf(server, dbParam(request.url), key);
      if (!b.newKey) throw new Refusal(400, 'VALIDATION', 'newKey is required.');
      if (b.newKey === key) throw new Refusal(400, 'VALIDATION', 'The new name is the current name.');
      if (!b.overwrite && d.get(b.newKey)) throw new Refusal(400, 'VALIDATION', `Key '${b.newKey}' already exists (tick Overwrite to replace it).`);
      d.delete(key);
      d.set(b.newKey, e.val, e.expiresAt);
      return noContent();
    })),

    http.put(`${P}/keys/:key/ttl`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'setting a TTL');
      const b = await body<{ seconds: number | null }>(request);
      const e = entryOf(server, dbParam(request.url), keyOf(request.url));
      if (b.seconds !== null && b.seconds !== undefined && b.seconds <= 0) throw new Refusal(400, 'VALIDATION', 'seconds must be positive (null removes the TTL).');
      e.expiresAt = b.seconds ? Date.now() + b.seconds * 1000 : null;
      return noContent();
    })),

    http.delete(`${P}/keys/:key`, route(({ params, request }) => {
      const server = writable(String(params.cid), 'deleting a key');
      const key = keyOf(request.url);
      if (!server.db(dbParam(request.url)).delete(key)) throw new Refusal(404, 'NOT_FOUND', `Key '${key}' was not found.`);
      server.echo(dbParam(request.url), ['UNLINK', key]);
      return noContent();
    })),

    http.post(`${P}/commands`, route(async ({ params, request }) => {
      const { server, conn } = open(String(params.cid));
      const b = await body<{ db: number; commands: string[][]; raw: string[] }>(request);
      const lines: (string[] | Error)[] = b.raw
        ? b.raw.map((l) => { try { return parseArgs(l); } catch (e) { return e as Error; } })
        : b.commands ?? [];
      if (!lines.length) throw new Refusal(400, 'VALIDATION', 'No command to run.');
      for (const args of lines) {
        if (args instanceof Error || !args.length) continue;
        const spec = findCommand(args);
        const name = spec?.name ?? args[0].toUpperCase();
        if (spec?.flags.includes('blocked')) {
          const hint = name === 'MONITOR' ? 'MONITOR cannot run here: open Info › Monitor, which streams it with a time limit.'
            : /SUBSCRIBE/.test(name) ? `${name} cannot run here: use the Pub/Sub tab.` : `${name} cannot run in the Workbench or CLI (use the Pub/Sub or Slowlog tab, or redis-cli).`;
          throw new Refusal(400, 'VALIDATION', hint);
        }
        if (conn.readOnly && !spec?.flags.includes('readonly'))
          throw new Refusal(403, 'READ_ONLY', `The connection '${conn.name}' is read-only: ${name} (only read commands run on a read-only connection) is not allowed.`);
      }
      const dbRef = { db: b.db ?? 0 };
      const results = lines.map((args) => args instanceof Error
        ? { ok: false, type: 'error' as const, value: args.message, elapsedMs: 0 }
        : args.length ? runCommand(server, dbRef, args, !!conn.readOnly, '') : { ok: false, type: 'error' as const, value: 'ERR empty command', elapsedMs: 0 });
      return ctx.ok({ results, db: dbRef.db } as never);
    })),

    http.post(`${P}/publish`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'PUBLISH');
      const b = await body<{ channel: string; message: string }>(request);
      if (!b.channel) throw new Refusal(400, 'VALIDATION', 'channel is required.');
      return ctx.ok({ receivers: server.publish(b.channel, b.message ?? '') });
    })),

    http.get(`${P}/pubsub/channels`, route(({ params, request }) => {
      const { server } = open(String(params.cid));
      const pattern = new URL(request.url).searchParams.get('pattern') || '*';
      const names = new Set<string>(['notifications', 'presence']);
      for (const s of server.subs) for (const c of s.channels) names.add(c);
      const channels = [...names].filter((c) => globMatch(pattern, c)).sort()
        .map((channel) => ({ channel, subscribers: [...server.subs].filter((s) => s.channels.includes(channel)).length + (channel === 'notifications' ? 1 : channel === 'presence' ? 3 : 0) }));
      return ctx.ok({ channels, patterns: [...server.subs].reduce((n, s) => n + s.patterns.length, 0) });
    })),

    http.get(`${P}/slowlog`, route(({ params, request }) => {
      const { server } = open(String(params.cid));
      const count = Number(new URL(request.url).searchParams.get('count') ?? 128);
      return ctx.ok(server.slowlog.slice(0, count) as never);
    })),

    http.post(`${P}/slowlog/reset`, route(({ params }) => {
      const server = writable(String(params.cid), 'SLOWLOG RESET');
      server.slowlog = [];
      return noContent();
    })),

    http.get(`${P}/config`, route(({ params, request }) => {
      const { server } = open(String(params.cid));
      const pattern = new URL(request.url).searchParams.get('pattern');
      if (!pattern) throw new Refusal(400, 'VALIDATION', 'pattern is required.');
      return ctx.ok({ values: Object.fromEntries(Object.entries(server.config).filter(([k]) => globMatch(pattern, k))) });
    })),

    http.put(`${P}/config`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'CONFIG SET');
      const b = await body<{ name: string; value: string }>(request);
      if (!b.name) throw new Refusal(400, 'VALIDATION', 'name is required.');
      server.config[b.name] = b.value ?? '';
      return noContent();
    })),

    http.get(`${P}/info`, route(({ params }) => {
      const { server } = open(String(params.cid));
      return ctx.ok({ sections: infoSections(server), dbSize: server.db(0).size(), clients: server.clients.length, clusterNodes: null });
    })),

    http.get(`${P}/clients`, route(({ params }) => ctx.ok(open(String(params.cid)).server.clients as never))),

    http.post(`${P}/clients/kill`, route(async ({ params, request }) => {
      const server = writable(String(params.cid), 'CLIENT KILL');
      const b = await body<{ id: string }>(request);
      const before = server.clients.length;
      server.clients = server.clients.filter((c) => c.id !== b.id);
      if (server.clients.length === before) throw new Refusal(404, 'NOT_FOUND', `Client ${b.id ?? ''} was not found.`);
      return noContent();
    })),

    http.post(`${P}/analysis`, route(async ({ params, request }) => {
      const { server } = open(String(params.cid));
      const b = await body<{ db: number; sampleLimit: number; delimiter: string }>(request);
      const d = server.db(b.db ?? 0);
      const limit = b.sampleLimit ?? 100_000;
      if (limit < 1) throw new Refusal(400, 'VALIDATION', 'sampleLimit must be between 1 and 5000000.');
      const jobId = ctx.jobs.start('redis.analysis', async (report, signal) => {
        const total = Math.min(limit, d.size());
        for (let i = 1; i <= 5; i++) {
          await sleep(30, signal);
          report(Math.round((total * i) / 5), total, `Analysed ${Math.round((total * i) / 5).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} keys`);
        }
        return analyse(d, limit, b.delimiter || ':');
      });
      return ctx.ok({ jobId }, { status: 202 });
    })),
  ];
}

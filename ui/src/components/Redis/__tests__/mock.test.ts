// The Redis MSW module (mocks/m2/redis.ts): fixture size, routes, key decoding, command interpreter, read-only
// refusals and validation, like the engine.
import { getResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../../mocks/engine';
import { createHandlers } from '../../../mocks/handlers';
import { MOCK_REDIS_KEY_COUNT } from '../../../mocks/m2/redis';

function setup(readOnly = false) {
  const engine = new MockEngine({ frameDelay: 0 });
  if (readOnly) engine.connections.find((c) => c.id === 'c_redis')!.readOnly = true;
  const handlers = createHandlers(engine) as RequestHandler[];
  return async (method: string, path: string, body?: unknown) => {
    const res = await getResponse(handlers, new Request(`http://engine.test/api/v1${path}`, {
      method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    if (!res) throw new Error(`no route for ${method} ${path}`);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

const enc = encodeURIComponent;

describe('redis mock', () => {
  it('serves the server facts and a 5k-key db0', async () => {
    const call = setup();
    const s = await call('GET', '/redis/c_redis/server');
    expect(s.status).toBe(200);
    expect(s.json.keyspace[0]).toMatchObject({ db: 0, keys: MOCK_REDIS_KEY_COUNT });
    expect(s.json.modules).toContain('ReJSON');
  });

  it('scans the whole keyspace with cursors and filters by type', async () => {
    const call = setup();
    let cursor = '0';
    const seen = new Set<string>();
    do {
      const r = await call('POST', '/redis/c_redis/keys/scan', { db: 0, pattern: '*', cursor, count: 1000 });
      for (const k of r.json.keys) seen.add(k.key);
      cursor = r.json.cursor;
    } while (cursor !== '0');
    expect(seen.size).toBe(MOCK_REDIS_KEY_COUNT);
    const streams = await call('POST', '/redis/c_redis/keys/scan', { db: 0, pattern: '*', type: 'stream', cursor: '0', count: 5000 });
    expect(streams.json.keys.map((k: { key: string }) => k.key).sort()).toEqual(['events:logins', 'events:orders']);
  });

  it('reads every type; keys with colons and slashes decode once', async () => {
    const call = setup();
    for (const [key, type] of [['greeting', 'string'], ['user:1001:profile', 'hash'], ['queue:jobs', 'list'], ['tags:all', 'set'], ['leaderboard:daily', 'zset'], ['events:orders', 'stream'], ['doc:product:1', 'rejson']]) {
      const r = await call('GET', `/redis/c_redis/keys/${enc(key)}?db=0`);
      expect(r.json.type, key).toBe(type);
    }
    await call('POST', '/redis/c_redis/keys', { key: 'a/b%c', db: 0, type: 'string', value: 'x' });
    expect((await call('GET', `/redis/c_redis/keys/${enc('a/b%c')}?db=0`)).json.value).toBe('x');
    expect((await call('GET', '/redis/c_redis/keys/nope?db=0')).status).toBe(404);
  });

  it('runs commands with SELECT tracking, errors and blocked commands', async () => {
    const call = setup();
    const r = await call('POST', '/redis/c_redis/commands', { db: 0, raw: ['SET k "a b"', 'GET k', 'SELECT 1', 'GET k', 'BOGUS'] });
    expect(r.json.results.map((x: { type: string }) => x.type)).toEqual(['simple', 'bulk', 'simple', 'null', 'error']);
    expect(r.json.results[1].value).toBe('a b');
    expect(r.json.db).toBe(1);
    const blocked = await call('POST', '/redis/c_redis/commands', { db: 0, raw: ['MONITOR'] });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.message).toMatch(/Monitor/);
  });

  it('refuses writes on a read-only connection but allows reads', async () => {
    const call = setup(true);
    expect((await call('DELETE', '/redis/c_redis/keys/greeting?db=0')).status).toBe(403);
    expect((await call('POST', '/redis/c_redis/commands', { db: 0, raw: ['SET a 1'] })).json.error.code).toBe('READ_ONLY');
    expect((await call('POST', '/redis/c_redis/commands', { db: 0, raw: ['GET greeting'] })).status).toBe(200);
    expect((await call('POST', '/redis/c_redis/slowlog/reset')).status).toBe(403);
  });

  it('validates like the engine', async () => {
    const call = setup();
    expect((await call('POST', '/redis/c_redis/keys', { key: 'greeting', db: 0, type: 'string', value: 'x' })).json.error.message).toMatch(/already exists/);
    expect((await call('PUT', '/redis/c_redis/keys/greeting/ttl?db=0', { seconds: 0 })).status).toBe(400);
    expect((await call('POST', '/redis/c_redis/keys/greeting/rename?db=0', { newKey: 'tags:all', overwrite: false })).status).toBe(400);
    expect((await call('POST', '/redis/c_redis/keys/delete-pattern', { db: 0 })).status).toBe(400);
    expect((await call('POST', '/redis/c_redis/keys/scan', { db: 99, cursor: '0' })).status).toBe(400);
  });

  it('answers info, slowlog, clients, config and channels', async () => {
    const call = setup();
    const info = await call('GET', '/redis/c_redis/info');
    expect(info.json.sections.server.redis_version).toBe('7.4.1');
    expect((await call('GET', '/redis/c_redis/slowlog?count=5')).json).toHaveLength(5);
    expect((await call('GET', '/redis/c_redis/clients')).json.length).toBeGreaterThan(3);
    expect((await call('GET', '/redis/c_redis/config?pattern=slowlog-*')).json.values['slowlog-log-slower-than']).toBe('10000');
    expect((await call('GET', '/redis/c_redis/pubsub/channels')).json.channels.length).toBeGreaterThan(0);
    const g = await call('GET', `/redis/c_redis/keys/${enc('events:orders')}/stream/groups/billing?db=0`);
    expect(g.json.consumers.map((c: { name: string }) => c.name)).toEqual(['billing-1', 'billing-2']);
    expect(g.json.pending).toHaveLength(10);
  });
});

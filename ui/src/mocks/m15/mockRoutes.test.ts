// logic-15: `npm run dev:mock` is the QA harness, so every REST endpoint of api/client.ts needs a mock route.
// Endpoints are read from the client source itself, so a new client method without a mock fails here.
import { getResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import clientSrc from '../../api/client.ts?raw';
import clientM2Src from '../../api/client.m2.ts?raw';
import { MockEngine } from '../engine';
import { createHandlers } from '../handlers';
import { createGridHandlers, FilterStoreMock } from './grid';

/** [method, path] of every request the client makes; `${…}` path segments become a placeholder id. */
export function clientEndpoints(src: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /(?:json<[\s\S]*?>|send)\(\s*'(GET|POST|PUT|DELETE)',\s*(`[^`]*`|'[^']*')/g;
  for (const m of src.matchAll(re)) {
    const path = m[2].slice(1, -1).replace(/\$\{[^}]+\}/g, 'x1');
    if (!out.some(([a, b]) => a === m[1] && b === path)) out.push([m[1], path]);
  }
  return out;
}

/**
 * M2: feature namespaces of api/client.m2.ts whose mock module (mocks/m2/*.ts) is not written yet. Each feature package
 * removes its prefix when its mock routes land, so from then on every api.<ns>.* call needs a route.
 */
const PENDING_M2_PREFIXES = ['/redis/', '/mongo/', '/kafka/', '/logs/', '/connections/x1/er/'];
const pending = (path: string) => PENDING_M2_PREFIXES.some((p) => path.startsWith(p));

describe('mock engine routes', () => {
  const engine = new MockEngine({ frameDelay: 0 });
  const handlers = [...createGridHandlers(new FilterStoreMock()), ...createHandlers(engine)] as RequestHandler[];

  it('reads the endpoints from api/client.ts', () => {
    const eps = clientEndpoints(clientSrc);
    expect(eps.length).toBeGreaterThan(40);
    expect(eps).toContainEqual(['POST', '/sessions/x1/explain']);
    expect(eps).toContainEqual(['POST', '/connections/x1/designer/apply']);
    // M2 framework (client.ts) and feature namespaces (client.m2.ts)
    expect(eps).toContainEqual(['POST', '/streams']);
    expect(eps).toContainEqual(['GET', '/sources/x1/client']);
    expect(clientEndpoints(clientM2Src).length).toBeGreaterThan(60);
  });

  it('every client endpoint has a mock route', async () => {
    const missing: string[] = [];
    for (const [method, path] of [...clientEndpoints(clientSrc), ...clientEndpoints(clientM2Src).filter(([, p]) => !pending(p))]) {
      const req = new Request(`http://engine.test/api/v1${path}`, {
        method,
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      let handled = true;
      try {
        handled = (await getResponse(handlers, req)) !== undefined;
      } catch {
        // A handler that throws on the empty body still exists.
      }
      if (!handled) missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
    // …and the check does detect a route that does not exist.
    expect(await getResponse(handlers, new Request('http://engine.test/api/v1/no-such-route', { headers: { Authorization: 'Bearer t' } }))).toBeUndefined();
  });

  it('streams exec.plan for explain from the plan fixtures', async () => {
    const conn = engine.connections.find((c) => c.providerId === 'sqlite') ?? engine.connections[0];
    const s = engine.createSession(conn.id, null, 'auto')!;
    const events: { type: string }[] = [];
    const off = engine.subscribe((ev) => events.push(ev));
    const res = await getResponse(handlers, new Request(`http://engine.test/api/v1/sessions/${s.sessionId}/explain`, {
      method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT 1', mode: 'estimated' }),
    }));
    expect(res?.status).toBe(202);
    const { executionId } = (await res!.json()) as { executionId: string };
    await new Promise((r) => setTimeout(r, 10));
    off();
    const plan = events.find((e) => e.type === 'exec.plan') as { executionId: string; root: unknown } | undefined;
    expect(plan?.executionId).toBe(executionId);
    expect(plan?.root).toBeTruthy();
    expect(events.map((e) => e.type)).toContain('exec.done');
  });

  it('refuses an actual explain that writes on a read-only connection unless confirmed', async () => {
    const conn = engine.createConnection({ name: 'RO', providerId: 'sqlite', color: null, folder: null, readOnly: true, props: { path: 'x.db' }, savePassword: false, password: null });
    const s = engine.createSession(conn.id, null, 'auto')!;
    const send = (confirmed: boolean) => getResponse(handlers, new Request(`http://engine.test/api/v1/sessions/${s.sessionId}/explain`, {
      method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'WITH x AS (SELECT 1 AS id) DELETE FROM Products WHERE Id IN (SELECT id FROM x)', mode: 'actual', confirmedDestructive: confirmed }),
    }));
    expect((await send(false))?.status).toBe(403);
    expect((await send(true))?.status).toBe(202);
  });
});

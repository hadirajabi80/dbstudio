import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { configureClient } from '../api/client';
import { MockEngine, type MockEngineOptions } from '../mocks/engine';
import { createHandlers } from '../mocks/handlers';

export const TEST_ENGINE_URL = 'http://engine.test';

/** Start an MSW node server backed by a fresh MockEngine for the current test file. */
export function installMockEngine(opts: MockEngineOptions = { frameDelay: 0 }) {
  const ctx = { engine: new MockEngine(opts), requests: [] as { method: string; url: URL }[] };
  const server = setupServer(...createHandlers(ctx.engine));
  server.events.on('request:start', ({ request }) => {
    ctx.requests.push({ method: request.method, url: new URL(request.url) });
  });
  beforeAll(() => {
    configureClient({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
    server.listen({ onUnhandledFrame: 'error' });
  });
  afterEach(() => {
    ctx.requests.length = 0;
  });
  afterAll(() => server.close());
  return {
    ctx,
    server,
    reset(o: MockEngineOptions = opts) {
      ctx.engine = new MockEngine(o);
      server.resetHandlers(...createHandlers(ctx.engine));
    },
    /** Requests whose path ends with `suffix` (e.g. '/catalog/databases'). */
    hits(suffix: string, method = 'GET') {
      return ctx.requests.filter((r) => r.method === method && r.url.pathname.endsWith(suffix));
    },
  };
}

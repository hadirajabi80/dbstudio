// Test helper: MSW node server with the grid mocks (saved filters + DML-aware engine) and the fake WebSocket.
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { configureClient } from '../../api/client';
import { engineSocket } from '../../api/ws';
import { wireSocket } from '../../app/boot';
import { FakeSocket } from '../fakeSocket';
import type { MockEngineOptions } from '../engine';
import { createHandlers } from '../handlers';
import { createGridHandlers, FilterStoreMock, GridMockEngine } from './grid';

export const GRID_ENGINE_URL = 'http://engine.test';

export function installGridMockEngine(opts: MockEngineOptions = { frameDelay: 0 }, withSocket = false) {
  const ctx = { engine: new GridMockEngine(opts), filters: new FilterStoreMock(), requests: [] as { method: string; url: URL; body?: unknown }[] };
  const server = setupServer(...createGridHandlers(ctx.filters), ...createHandlers(ctx.engine));
  server.events.on('request:start', ({ request }) => {
    ctx.requests.push({ method: request.method, url: new URL(request.url) });
  });
  beforeAll(async () => {
    configureClient({ baseUrl: GRID_ENGINE_URL, token: 'test-token' });
    server.listen({ onUnhandledFrame: 'error' });
    if (withSocket) {
      wireSocket();
      engineSocket.setSocketFactory(() => new FakeSocket(ctx.engine, 'test-token'));
      engineSocket.connect({ baseUrl: GRID_ENGINE_URL, token: 'test-token' });
      const t0 = Date.now();
      while (engineSocket.status !== 'open' && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5));
    }
  });
  afterEach(() => {
    ctx.requests.length = 0;
  });
  afterAll(() => {
    if (withSocket) engineSocket.disconnect();
    server.close();
  });
  return {
    ctx,
    server,
    hits(suffix: string, method = 'GET') {
      return ctx.requests.filter((r) => r.method === method && r.url.pathname.endsWith(suffix));
    },
  };
}

export async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

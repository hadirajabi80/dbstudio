// `npm run dev:mock`: the MSW request handlers serve the engine REST API in-page and a FakeSocket stands in
// for the engine WebSocket. Requests are resolved with msw's `getResponse` from a thin fetch wrapper rather
// than a Service Worker, so the mock also works where service workers are unavailable (embedded browsers,
// custom schemes such as dbstudio://).
import { getResponse, type RequestHandler } from 'msw';
import { engineSocket } from '../api/ws';
import { MockEngine } from './engine';
import { FakeSocket } from './fakeSocket';
import { createHandlers } from './handlers';

export const MOCK_PREFIX = '/__mock/';

export async function startBrowserMocks(): Promise<MockEngine> {
  const engine = new MockEngine({ latency: 60, frameRows: 500, frameDelay: 4 });
  const handlers = createHandlers(engine) as RequestHandler[];
  engineSocket.setSocketFactory(() => new FakeSocket(engine, 'mock-token'));

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!new URL(request.url, location.href).pathname.startsWith(MOCK_PREFIX)) return realFetch(input, init);
    const res = await getResponse(handlers, request);
    return res ?? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${request.method} ${request.url}` } }), { status: 404 });
  };

  (window as unknown as { __mockEngine?: MockEngine }).__mockEngine = engine;
  console.info('[DbStudio] running against the in-browser mock engine');
  return engine;
}

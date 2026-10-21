// Test helpers for the Redis views: MSW over a MockEngine (with the Redis mock), the fake WebSocket, and a host that
// renders a Redis tab from the tabs store plus the dialog host and the shared confirmation dialog.
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { configureClient } from '../../../api/client';
import { engineSocket } from '../../../api/ws';
import { FakeSocket } from '../../../mocks/fakeSocket';
import { MockEngine } from '../../../mocks/engine';
import { createHandlers } from '../../../mocks/handlers';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { useUi } from '../../../store/ui';
import { ConfirmDialog } from '../../common/ConfirmDialog';
import { BrowserView } from '../BrowserView';
import { CliView } from '../CliView';
import { closeRedisDialog, RedisDialogHost, enableManualDialogHost } from '../dialogHost';
import { AnalysisView } from '../AnalysisView';
import { InfoView } from '../InfoView';
import { PubSubView } from '../PubSubView';
import { SlowlogView } from '../SlowlogView';
import { useRedis } from '../store';
import { WorkbenchView } from '../WorkbenchView';

export const ENGINE_URL = 'http://engine.test';

// Async queries wait asyncUtilTimeout (5 s, src/test/setup.ts): the Redis views chain several requests (server → scan → memory).

export interface RecordedRequest { method: string; path: string; body: unknown }

export async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function installRedisEngine() {
  const env = { engine: new MockEngine({ frameDelay: 0 }) };
  const server = setupServer(...createHandlers(env.engine));
  const requests: RecordedRequest[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    const rec: RecordedRequest = { method: request.method, path: url.pathname.replace(/^\/api\/v1/, '') + url.search, body: null };
    requests.push(rec);
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      void request.clone().json().then((b) => {
        rec.body = b;
      }, () => {});
    }
  });
  enableManualDialogHost();
  beforeAll(async () => {
    configureClient({ baseUrl: ENGINE_URL, token: 'test-token' });
    server.listen({ onUnhandledFrame: 'error' } as never);
    engineSocket.setSocketFactory(() => new FakeSocket(env.engine, 'test-token'));
    engineSocket.connect({ baseUrl: ENGINE_URL, token: 'test-token' });
    await until(() => engineSocket.status === 'open');
    await useConnections.getState().load();
  });
  afterEach(() => {
    requests.length = 0;
  });
  afterAll(() => {
    engineSocket.disconnect();
    server.close();
  });
  return {
    get engine() {
      return env.engine;
    },
    server,
    requests,
    /** Fresh Redis mock data (new handlers over the same engine, so the fake socket keeps working). */
    reset() {
      server.resetHandlers(...createHandlers(env.engine));
      useRedis.setState({ conns: {} });
      closeRedisDialog();
    },
    hits: (fragment: string, method?: string) => requests.filter((r) => (!method || r.method === method) && r.path.includes(fragment)),
  };
}

const VIEWS = {
  'redis.browser': BrowserView, 'redis.workbench': WorkbenchView, 'redis.cli': CliView, 'redis.pubsub': PubSubView,
  'redis.slowlog': SlowlogView, 'redis.info': InfoView, 'redis.analysis': AnalysisView,
} as const;

/** Renders one Redis tab (kept in sync with the tabs store) with the dialog hosts. */
export function RedisHost({ tabId, visible = true }: { tabId: string; visible?: boolean }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId)) as ViewTab | undefined;
  const View = tab ? VIEWS[tab.view as keyof typeof VIEWS] : null;
  return (
    <div data-testid="redis-host" style={{ height: 800 }}>
      {tab && View && <View tab={tab} theme="light" visible={visible} />}
      <RedisDialogHost />
      <ConfirmDialog />
    </div>
  );
}

export function resetTabs(): void {
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
  useUi.setState({ toasts: [], confirm: null } as never);
}

export function stubClipboard(): string[] {
  const texts: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { texts.push(t); } }, configurable: true });
  return texts;
}

export const tabState = <T,>(id: string) => (useTabs.getState().tabs.find((t) => t.id === id) as ViewTab).state as T;

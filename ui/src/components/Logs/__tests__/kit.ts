// Test helpers for the logs view: MSW server over a MockEngine (with the M2 logs mocks), the fake WebSocket, and a
// host component that re-renders the logs tab from the tabs store.
import { setupServer } from 'msw/node';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { configureClient } from '../../../api/client';
import { engineSocket } from '../../../api/ws';
import { FakeSocket } from '../../../mocks/fakeSocket';
import { MockEngine } from '../../../mocks/engine';
import { createHandlers } from '../../../mocks/handlers';
import { setPlatform, type Platform } from '../../../platform';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { LogsView } from '../LogsView';

export const LOGS_ENGINE_URL = 'http://engine.test';

export interface RecordedRequest { method: string; path: string; search: string; body: unknown }

export async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function installLogsEngine() {
  const engine = new MockEngine({ frameDelay: 0 });
  const server = setupServer(...createHandlers(engine));
  const requests: RecordedRequest[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    const rec: RecordedRequest = { method: request.method, path: url.pathname.replace(/^\/api\/v1/, ''), search: url.search, body: null };
    requests.push(rec);
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      void request.clone().json().then((b) => {
        rec.body = b;
      }, () => {});
    }
  });
  beforeAll(async () => {
    configureClient({ baseUrl: LOGS_ENGINE_URL, token: 'test-token' });
    server.listen({ onUnhandledFrame: 'error' } as never);
    engineSocket.setSocketFactory(() => new FakeSocket(engine, 'test-token'));
    engineSocket.connect({ baseUrl: LOGS_ENGINE_URL, token: 'test-token' });
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
    engine,
    server,
    requests,
    hits: (suffix: string, method = 'POST') => requests.filter((r) => r.method === method && r.path.endsWith(suffix)),
  };
}

/** Renders the logs tab `tabId` and keeps it in sync with the tabs store. */
export function LogsHost({ tabId, visible = true }: { tabId: string; visible?: boolean }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId)) as ViewTab | undefined;
  return tab ? createElement(LogsView, { tab, theme: 'light', visible }) : null;
}

export function resetTabs(): void {
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
}

/** A platform stub that records saved files (browser mode unless `fs`). */
export function stubPlatform(fs = false) {
  const saved: { suggestedName: string; content: Blob | string; mime?: string }[] = [];
  const p = {
    kind: fs ? 'electron' : 'browser', appVersion: 'test', hasFileSystem: fs,
    getEngineInfo: async () => ({ baseUrl: LOGS_ENGINE_URL, token: 'test-token' }),
    showSaveDialog: async (o: { defaultPath?: string }) => (fs ? `C:\\exports\\${o.defaultPath ?? 'log.txt'}` : null),
    showOpenDialog: async () => null,
    saveFile: async (o: { suggestedName: string; content: Blob | string; mime?: string }) => {
      saved.push(o);
      return o.suggestedName;
    },
    openTextFile: async () => null,
    writeTextFile: async () => {},
    openExternal: async () => {},
    onMenuCommand: () => () => {},
    onEngineRestarted: () => () => {},
    loadWorkspace: async () => null,
    saveWorkspace: async () => {},
    setTitle: () => {},
  } as unknown as Platform;
  setPlatform(p);
  return { saved, restore: () => setPlatform(null) };
}

/** navigator.clipboard stub; returns the written texts. */
export function stubClipboard(): string[] {
  const texts: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { texts.push(t); } }, configurable: true });
  return texts;
}

// The Redis source module: explorer subtree (dbs, delimiter folders, keys with TTL, tool nodes), lazy loads, context
// menu ids, row activation, Ctrl+P `k:` entries, default workspace, registered commands and read-only enablement.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SourceTarget } from '../../../commands/types';
import { getCommand, isEnabled, runCommand } from '../../../commands/registry';
import { CONTEXT_MENUS } from '../../../commands/menuModel';
import { getSourceModule, sourceNodeId } from '../../../lib/sources';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { registerRedisCommands } from '../commands';
import { cacheOf, loadServer, rememberKeys, useRedis } from '../store';
import { installRedisEngine, RedisHost, resetTabs, until } from './kit';

const env = installRedisEngine();

beforeAll(() => registerRedisCommands());
beforeEach(() => {
  env.reset();
  resetTabs();
});

const conn = () => useConnections.getState().connections.find((c) => c.id === 'c_redis')!;
const mod = () => getSourceModule('redis')!;
const rows = (expanded: string[] = [], filter = '') => mod().tree({ connection: conn(), depth: 1, expanded: new Set([`c:c_redis`, ...expanded]), filter });
const target = (nodeType: string, path: string[], meta?: unknown): SourceTarget => ({ kind: 'source', connectionId: 'c_redis', providerId: 'redis', nodeType, path, meta });

describe('explorer subtree', () => {
  it('shows connecting, then databases with key counts and the tool nodes', async () => {
    expect(rows()[0]).toMatchObject({ kind: 'status', status: 'loading' });
    mod().ensureLoaded!(conn(), new Set(['c:c_redis']));
    await until(() => !!useRedis.getState().conns.c_redis?.server.data);
    const r = rows();
    expect(r.map((x) => x.label)).toEqual(['db0', 'db1', 'Workbench', 'CLI', 'Pub/Sub', 'Slowlog', 'Info', 'Analysis']);
    expect(r[0]).toMatchObject({ expandable: true, detail: '5,000' });
    expect(mod().contextMenuId(r[0])).toBe('explorer.redis.db');
    expect(mod().contextMenuId(r[2])).toBeNull();
  });

  it('expanding a db scans its first keys into delimiter folders; truncation shows a hint', async () => {
    await loadServer('c_redis');
    const db0 = sourceNodeId('c_redis', ['0']);
    mod().ensureLoaded!(conn(), new Set(['c:c_redis', db0]));
    await until(() => (cacheOf('c_redis', 0)?.keys.size ?? 0) >= 1000);
    const r = rows([db0]);
    const folder = r.find((x) => x.label === 'user')!;
    expect(folder).toMatchObject({ source: { nodeType: 'folder' }, expandable: true });
    expect(mod().contextMenuId(folder)).toBe('explorer.redis.folder');
    expect(r.some((x) => x.kind === 'status' && /open the browser/.test(x.label))).toBe(true);
    const inner = rows([db0, folder.id]).filter((x) => x.depth === 3);
    expect(inner.length).toBeGreaterThan(0);
  });

  it('key rows carry type and TTL and open the browser on activation', async () => {
    await loadServer('c_redis');
    rememberKeys('c_redis', 0, [{ key: 'session:abc', type: 'string', ttl: 125 }]);
    const db0 = sourceNodeId('c_redis', ['0']);
    useRedis.setState((s) => ({ conns: { ...s.conns, c_redis: { ...s.conns.c_redis, dbs: { 0: { ...s.conns.c_redis.dbs[0], scanned: new Set(['']) } } } } }));
    const folder = sourceNodeId('c_redis', ['0', 'session:']);
    const key = rows([db0, folder]).find((x) => x.source?.nodeType === 'key')!;
    expect(key).toMatchObject({ label: 'abc', detail: '2m 5s', source: { path: ['0', 'session:abc'] } });
    expect(mod().contextMenuId(key)).toBe('explorer.redis.key');
    mod().activate(key);
    const tab = useTabs.getState().tabs[0] as ViewTab;
    expect(tab).toMatchObject({ view: 'redis.browser', state: { db: 0, selected: 'session:abc' } });
  });

  it('filter mode lists matching cached keys under their db', async () => {
    await loadServer('c_redis');
    rememberKeys('c_redis', 0, [{ key: 'user:1:x', type: 'hash', ttl: -1 }, { key: 'other', type: 'string', ttl: -1 }]);
    const r = rows([], 'user:1');
    expect(r.map((x) => x.label)).toEqual(['db0', 'user:1:x']);
    expect(r[1].match).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('tool nodes open their views; Ctrl+P lists cached keys with k: entries', async () => {
    await loadServer('c_redis');
    const info = rows().find((x) => x.label === 'Info')!;
    mod().activate(info);
    expect((useTabs.getState().tabs[0] as ViewTab).view).toBe('redis.info');
    rememberKeys('c_redis', 0, [{ key: 'greeting', type: 'string', ttl: -1 }]);
    const entries = mod().paletteEntries();
    const e = entries.find((x) => x.name === 'greeting')!;
    expect(e).toMatchObject({ type: 'redis.key', connectionId: 'c_redis', detail: 'Redis Cache · db0' });
    e.open();
    expect(useTabs.getState().tabs.some((t) => t.kind === 'view' && t.view === 'redis.browser')).toBe(true);
  });

  it('the default workspace opens the browser on the profile database', async () => {
    mod().defaultWorkspace('c_redis');
    await until(() => useTabs.getState().tabs.length > 0);
    expect(useTabs.getState().tabs[0]).toMatchObject({ view: 'redis.browser', key: 'c_redis:redis.browser:0' });
  });
});

describe('commands', () => {
  it('registers every reserved menu id with an icon', () => {
    for (const id of ['explorer.redis.db', 'explorer.redis.folder', 'explorer.redis.key'] as const) {
      for (const e of CONTEXT_MENUS[id]) {
        if (e === 'separator' || 'submenu' in e) continue;
        expect(getCommand(e.command), e.command).toBeDefined();
        expect(getCommand(e.command)!.icon, e.command).toBeTruthy();
      }
    }
    for (const id of ['redis.workbench', 'redis.cli', 'redis.pubsub', 'redis.slowlog', 'redis.info', 'redis.analysis', 'redis.monitor']) expect(getCommand(id), id).toBeDefined();
  });

  it('writes are disabled on read-only connections; reads stay enabled', () => {
    const t = target('key', ['0', 'greeting'], { db: 0, key: 'greeting', type: 'string', ttl: -1 });
    expect(isEnabled('redis.deleteKey', t)).toBe(true);
    const before = useConnections.getState().connections;
    useConnections.setState({ connections: before.map((c) => (c.id === 'c_redis' ? { ...c, readOnly: true } : c)) });
    try {
      for (const id of ['redis.deleteKey', 'redis.renameKey', 'redis.setTtl']) expect(isEnabled(id, t), id).toBe(false);
      expect(isEnabled('redis.flushDb', target('db', ['0']))).toBe(false);
      expect(isEnabled('redis.openKey', t)).toBe(true);
      expect(isEnabled('redis.copyValueJson', t)).toBe(true);
    } finally {
      useConnections.setState({ connections: before });
    }
  });

  it('folder → Open in browser with this pattern escapes glob characters', () => {
    runCommand('redis.openPattern', target('folder', ['0', 'cache:page:[1]:'], { db: 0, prefix: 'cache:page:[1]:' }));
    expect((useTabs.getState().tabs[0] as ViewTab).state).toMatchObject({ db: 0, pattern: 'cache:page:\\[1\\]:*' });
  });

  it('Flush database requires typing the database name', async () => {
    const id = useTabs.getState().openView({ view: 'redis.slowlog', title: 'x', connectionId: 'c_redis', state: {} });
    render(<RedisHost tabId={id} />);
    runCommand('redis.flushDb', target('db', ['1']));
    const dlg = await screen.findByRole('dialog', { name: 'Flush db1' });
    const go = within(dlg).getByRole('button', { name: 'Flush database' });
    expect(go).toBeDisabled();
    const input = within(dlg).getByLabelText('Type the database name to confirm');
    fireEvent.change(input, { target: { value: 'db1' } });
    fireEvent.click(go);
    await waitFor(() => expect(env.hits('/commands', 'POST')[0]?.body).toEqual({ db: 1, raw: ['FLUSHDB'] }));
  });
});

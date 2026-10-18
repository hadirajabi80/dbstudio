// M2-0 (docs/PLAN-M2.md 1.3, 9 "Acceptance M2-0"): the explorer renders a non-relational connection through its
// registered source module (tree, context menu id, activation, lazy loads) and never loads a SQL catalog for it.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectAndOpen } from '../../app/actions';
import { collectEntries, searchObjects } from '../CommandPalette/objectIndex';
import { notifySourceTreeChanged, registerSourceModule, sourceRow, type SourceModule } from '../../lib/sources';
import { useCatalog } from '../../store/catalog';
import { hasDatabaseLevel, kindOf, providerKind, useConnections } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import { contextMenuIdOf, Explorer, targetOfRow, useExplorer } from './Explorer';
import type { TreeRow } from './tree';

const mock = installMockEngine();

function row(label: string) {
  return screen.getAllByRole('treeitem').find((el) => el.querySelector('.tree-label')?.textContent === label);
}

async function expand(label: string) {
  const r = await waitFor(() => {
    const el = row(label);
    if (!el) throw new Error(`row ${label} not found`);
    return el;
  });
  fireEvent.click(r.querySelector('.tree-twisty')!);
}

/** A minimal Redis-like module: db 0 → folder "user:" → keys; keys arrive after ensureLoaded. */
function fakeRedisModule() {
  const keys: string[] = [];
  const activated: TreeRow[] = [];
  const workspaces: string[] = [];
  const ensureLoaded = vi.fn((_c: unknown, expanded: ReadonlySet<string>) => {
    void expanded;
    if (keys.length) return;
    setTimeout(() => {
      keys.push('user:1', 'user:2');
      notifySourceTreeChanged();
    }, 0);
  });
  const mod: SourceModule = {
    providerId: 'redis',
    kind: 'keyvalue',
    tree: ({ connection, depth, expanded, filter }) => {
      const base = { connectionId: connection.id, providerId: 'redis' as const, expanded };
      const db = sourceRow({ ...base, nodeType: 'db', path: ['0'], depth, label: 'db0', expandable: true, count: keys.length, forceOpen: !!filter });
      const rows: TreeRow[] = [db];
      if (!db.expanded) return rows;
      const folder = sourceRow({ ...base, nodeType: 'folder', path: ['0', 'user:'], depth: depth + 1, label: 'user:', expandable: true, forceOpen: !!filter });
      rows.push(folder);
      if (folder.expanded) {
        for (const k of keys.filter((x) => !filter || x.includes(filter))) {
          rows.push(sourceRow({ ...base, nodeType: 'key', path: ['0', 'user:', k], depth: depth + 2, label: k, detail: 'HASH', meta: { type: 'hash' } }));
        }
      }
      return filter && !rows.some((r) => r.source?.nodeType === 'key') ? [] : rows;
    },
    contextMenuId: (r) => (r.source?.nodeType === 'key' ? 'explorer.redis.key' : r.source?.nodeType === 'folder' ? 'explorer.redis.folder' : 'explorer.redis.db'),
    activate: (r) => activated.push(r),
    defaultWorkspace: (cid) => workspaces.push(cid),
    paletteEntries: () => keys.map((k) => ({ name: k, type: 'redis.key' as const, connectionId: 'c_redis', detail: 'db 0', open: () => workspaces.push(`open:${k}`) })),
    ensureLoaded,
  };
  return { mod, keys, activated, workspaces, ensureLoaded };
}

describe('Explorer source modules', () => {
  let unregister: (() => void) | null = null;

  beforeEach(async () => {
    mock.reset();
    localStorage.clear();
    useExplorer.setState({ expanded: new Set(), collapsedFolders: new Set(), filter: '', selected: null });
    useCatalog.setState({ conns: {}, dbs: {} });
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    useTabs.setState({ tabs: [], activeId: null, seq: 0 });
    await useConnections.getState().load();
  });
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it('knows provider kinds and the database level', () => {
    expect(providerKind('redis')).toBe('keyvalue');
    expect(providerKind('postgresql')).toBe('relational');
    expect(kindOf('c_kafka')).toBe('stream');
    expect(kindOf('c_mongo')).toBe('document');
    expect(kindOf('c_shop')).toBe('relational');
    expect(hasDatabaseLevel('sqlserver')).toBe(true);
    expect(hasDatabaseLevel('postgresql')).toBe(true);
    expect(hasDatabaseLevel('oracle')).toBe(false);
  });

  it('renders a source connection through its module and never loads a SQL catalog', async () => {
    const fake = fakeRedisModule();
    unregister = registerSourceModule(fake.mod);
    render(<Explorer />);
    await expand('Redis Cache');

    await waitFor(() => expect(row('db0')).toBeDefined());
    expect(fake.ensureLoaded).toHaveBeenCalled();
    await expand('db0');
    await expand('user:');
    await waitFor(() => expect(row('user:1')).toBeDefined());
    expect(row('user:2')?.querySelector('.tree-detail')?.textContent).toBe('HASH');
    expect(row('user:1')?.getAttribute('aria-level')).toBe('5'); // folder M2 → connection → db0 → user: → key (1-based)

    // Context menu id, command target and activation are delegated.
    const keyRow = sourceRow({ connectionId: 'c_redis', providerId: 'redis', nodeType: 'key', path: ['0', 'user:', 'user:1'], depth: 3, label: 'user:1', expanded: new Set() });
    expect(contextMenuIdOf(keyRow)).toBe('explorer.redis.key');
    expect(targetOfRow(keyRow)).toEqual({ kind: 'source', connectionId: 'c_redis', providerId: 'redis', nodeType: 'key', path: ['0', 'user:', 'user:1'], meta: undefined });
    fireEvent.doubleClick(row('user:1')!);
    expect(fake.activated.map((r) => r.label)).toEqual(['user:1']);

    // The connection row offers the source menu and no SQL catalog request was made.
    const connRow = { id: 'c:c_redis', kind: 'connection', depth: 1, label: 'Redis Cache', expandable: true, expanded: true, connectionId: 'c_redis' } as TreeRow;
    expect(contextMenuIdOf(connRow)).toBe('explorer.sourceConnection');
    expect(mock.ctx.requests.filter((r) => r.url.pathname.includes('/catalog'))).toHaveLength(0);
  });

  it('filters source rows and feeds the Ctrl+P index', async () => {
    const fake = fakeRedisModule();
    fake.keys.push('user:1', 'user:2');
    unregister = registerSourceModule(fake.mod);
    render(<Explorer />);
    act(() => useExplorer.getState().setFilter('user:2'));
    await waitFor(() => expect(row('user:2')).toBeDefined());
    expect(row('user:1')).toBeUndefined();

    const hits = searchObjects(collectEntries({}, false), 'k:user', 10);
    expect(hits.map((h) => h.entry.name)).toEqual(['user:1', 'user:2']);
    hits[0].entry.source!.open();
    expect(fake.workspaces).toContain('open:user:1');
  });

  it('shows a hint when no module is registered, and Connect opens the default workspace', async () => {
    render(<Explorer />);
    await expand('Kafka Dev');
    await waitFor(() => expect(screen.getByText('Support for this source is not available in this build')).toBeDefined());

    const fake = fakeRedisModule();
    unregister = registerSourceModule(fake.mod);
    expect(connectAndOpen('c_redis')).toBe('');
    expect(fake.workspaces).toEqual(['c_redis']);
    expect(useTabs.getState().tabs).toHaveLength(0); // no console for a key-value source
  });
});

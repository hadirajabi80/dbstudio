// Explorer subtree, source module, commands and dialogs of MongoDB connections (docs/PLAN-M2.md 6.2).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { getCommand, isEnabled, runCommand } from '../../../commands/registry';
import type { SourceTarget } from '../../../commands/types';
import { getSourceModule, sourceNodeId } from '../../../lib/sources';
import { getConnection } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { useExplorer } from '../../Explorer/explorerStore';
import { registerMongoCommands } from '../commands';
import { splitPipeline } from '../CollectionDialogs';
import { collectionKey, tabState } from '../open';
import { loadCollections, loadDatabases, useMongo } from '../store';
import { formatBytes, formatCount, mongoTree } from '../tree';
import { CID, setupMongo } from './helpers';

const { reset } = setupMongo();
beforeAll(() => registerMongoCommands());
beforeEach(async () => {
  await reset();
  useExplorer.setState({ expanded: new Set(), filter: '' });
});

const target = (path: string[], nodeType = path.length === 1 ? 'database' : 'collection'): SourceTarget =>
  ({ kind: 'source', connectionId: CID, providerId: 'mongodb', nodeType, path });

function tree(expanded: string[] = [], filter = '') {
  return mongoTree({ connection: getConnection(CID)!, depth: 1, expanded: new Set(expanded), filter });
}

describe('explorer tree', () => {
  it('shows a loading row, then the configured database only', async () => {
    expect(tree()[0]).toMatchObject({ kind: 'status', status: 'loading' });
    await loadDatabases(CID);
    const rows = tree();
    expect(rows.map((r) => r.label)).toEqual(['shop']); // c_mongo has database: shop
    expect(rows[0].source?.nodeType).toBe('database');
  });

  it('lists collections as leaves with counts and types', async () => {
    await loadDatabases(CID);
    await loadCollections(CID, 'shop');
    const db = sourceNodeId(CID, ['shop']);
    const orders = sourceNodeId(CID, ['shop', 'orders']);
    const rows = tree([db, orders]);
    expect(rows.map((r) => r.label)).toEqual(['shop', 'customers', 'orders', 'paid_orders', 'products']);
    expect(rows.find((r) => r.label === 'orders')?.expandable).toBe(false);
    expect(rows.find((r) => r.label === 'orders')?.detail).toBe('240');
    expect(rows.find((r) => r.label === 'paid_orders')?.detail).toBe('view');
  });

  it('filters collections by name', async () => {
    await loadDatabases(CID);
    await loadCollections(CID, 'shop');
    expect(tree([], 'prod').map((r) => r.label)).toEqual(['shop', 'products']);
  });

  it('maps rows to context menus and activates collections', async () => {
    await loadDatabases(CID);
    await loadCollections(CID, 'shop');
    const mod = getSourceModule('mongodb')!;
    const rows = tree([sourceNodeId(CID, ['shop']), sourceNodeId(CID, ['shop', 'orders'])]);
    expect(mod.contextMenuId(rows[0])).toBe('explorer.mongo.db');
    expect(mod.contextMenuId(rows.find((r) => r.label === 'orders')!)).toBe('explorer.mongo.collection');
    mod.activate(rows.find((r) => r.label === 'orders')!);
    const tab = useTabs.getState().tabs[0] as ViewTab;
    expect(tab.key).toBe(collectionKey(CID, 'shop', 'orders'));
    expect(tabState(tab).sub).toBe('documents');
  });

  it('offers collections in Ctrl+P with the coll: type', async () => {
    await loadCollections(CID, 'shop');
    const entries = getSourceModule('mongodb')!.paletteEntries();
    expect(entries.map((e) => e.name)).toContain('shop.orders');
    expect(entries[0].type).toBe('mongo.collection');
  });

  it('default workspace opens the first collection', async () => {
    getSourceModule('mongodb')!.defaultWorkspace(CID);
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect((useTabs.getState().tabs[0] as ViewTab).title).toBe('shop.customers');
    expect(useExplorer.getState().expanded.has(`c:${CID}`)).toBe(true);
  });

  it('formats sizes and counts', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatCount(12480)).toBe('12.5K');
    expect(formatCount(999)).toBe('999');
  });
});

describe('commands', () => {
  it('registers every reserved menu command', () => {
    for (const id of ['mongo.openDocuments', 'mongo.aggregate', 'mongo.schema', 'mongo.indexes', 'mongo.explain', 'mongo.validation', 'mongo.import',
      'mongo.export', 'mongo.renameCollection', 'mongo.dropCollection', 'mongo.newCollection', 'mongo.importInto', 'mongo.dropDatabase']) {
      expect(getCommand(id), id).toBeDefined();
    }
  });

  it('opens sub-views of the same collection tab', () => {
    runCommand('mongo.aggregate', target(['shop', 'orders']));
    runCommand('mongo.schema', target(['shop', 'orders']));
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(tabState(useTabs.getState().tabs[0] as ViewTab).sub).toBe('schema');
  });

  it('disables writes on views and read-only connections', () => {
    const view = { ...target(['shop', 'paid_orders']), meta: { type: 'view', count: null } };
    expect(isEnabled('mongo.renameCollection', view)).toBe(false);
    expect(isEnabled('mongo.indexes', view)).toBe(false);
    expect(isEnabled('mongo.renameCollection', target(['shop', 'orders']))).toBe(true);
  });

  it('creates a collection from the dialog', async () => {
    runCommand('mongo.newCollection', target(['shop']));
    const dlg = await screen.findByRole('dialog', { name: 'New collection in shop' });
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'audit' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(useMongo.getState().conns[CID]?.collections.shop?.data?.map((c) => c.name)).toContain('audit'));
  });

  it('drop collection requires typing the name', async () => {
    runCommand('mongo.dropCollection', target(['shop', 'products']));
    const dlg = await screen.findByRole('dialog', { name: 'Drop collection' });
    const drop = within(dlg).getByRole('button', { name: 'Drop collection' });
    expect(drop).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(/Type/), { target: { value: 'product' } });
    expect(drop).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(/Type/), { target: { value: 'products' } });
    fireEvent.click(drop);
    await waitFor(async () => expect((await api.mongo.collections(CID, 'shop')).map((c) => c.name)).not.toContain('products'));
  });

  it('renames a collection', async () => {
    runCommand('mongo.renameCollection', target(['shop', 'customers']));
    const dlg = await screen.findByRole('dialog', { name: 'Rename shop.customers' });
    fireEvent.change(within(dlg).getByLabelText('New name'), { target: { value: 'clients' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Rename' }));
    await waitFor(async () => expect((await api.mongo.collections(CID, 'shop')).map((c) => c.name)).toContain('clients'));
  });

  it('splits view pipelines into stage texts', () => {
    expect(splitPipeline('[ { $match: { a: [1, 2] } }, { $project: { "x,y": 1 } } ]')).toEqual(['{ $match: { a: [1, 2] } }', '{ $project: { "x,y": 1 } }']);
  });
});

// logic-06: catalog.changed for SQLite carries database: null while the UI caches the catalog under "main".
import { beforeEach, describe, expect, it } from 'vitest';
import type { WsEventOf } from '../api/types';
import { dbKey, useCatalog } from '../store/catalog';
import { useConnections } from '../store/connections';
import { installMockEngine } from '../test/mockServer';

const mock = installMockEngine({ frameDelay: 0 });

async function until(pred: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const changed = (database: string | null, connectionId = 'c_shop'): WsEventOf<'catalog.changed'> =>
  ({ type: 'catalog.changed', ts: new Date().toISOString(), connectionId, database, schemas: ['main'], version: 9 }) as WsEventOf<'catalog.changed'>;

const schemaFetches = (db: string) =>
  mock.hits('/catalog').filter((r) => r.url.searchParams.get('schemas') === 'main' && r.url.searchParams.get('database') === db);

describe('catalog.changed → catalog store', () => {
  beforeEach(async () => {
    useCatalog.setState({ conns: {}, dbs: {} });
    await useConnections.getState().load();
    await useCatalog.getState().loadDatabases('c_shop');
    await useCatalog.getState().ensureDefault('c_shop', 'main');
    await useCatalog.getState().loadSchemas('c_shop', 'main');
    expect(useCatalog.getState().dbs[dbKey('c_shop', 'main')]?.loaded.main).toBeDefined();
    mock.ctx.requests.length = 0;
  });

  it('a null database refreshes the "main" entry (SQLite)', async () => {
    useCatalog.getState().applyChanged(changed(null));
    await until(() => schemaFetches('main').length > 0);
    expect(mock.hits('/catalog/schemas').some((r) => r.url.searchParams.get('database') === 'main')).toBe(true);
  });

  it('a database without a cache key falls back to the default entry', async () => {
    useCatalog.getState().applyChanged(changed('MAIN_ALIAS_UNKNOWN'));
    await until(() => schemaFetches('main').length > 0);
  });

  it('ignores other connections', async () => {
    useCatalog.getState().applyChanged(changed(null, 'c_prod'));
    await new Promise((r) => setTimeout(r, 30));
    expect(schemaFetches('main')).toHaveLength(0);
  });
});

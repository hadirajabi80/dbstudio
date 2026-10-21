// Forced reloads of catalog data that is already shown (refresh, save of an edited object, catalog.changed) keep the
// entry 'ready' with its old data until the response swaps in: the explorer never collapses into "Loading…" rows.
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { catalogDatabase, preloadCatalog } from '../app/actions';
import { createIntel } from '../intel';
import { installMockEngine } from '../test/mockServer';
import { dbKey, useCatalog } from './catalog';
import { useConnections } from './connections';

const mock = installMockEngine({ frameDelay: 0 });
const KEY = dbKey('c_shop', 'main');

async function until(pred: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every status the store passes through while `fn` runs. */
async function statuses(fn: () => Promise<unknown>) {
  const seen = { databases: new Set<string>(), schemas: new Set<string>(), main: new Set<string>(), revalidating: false };
  const unsub = useCatalog.subscribe((s) => {
    const d = s.dbs[KEY];
    seen.databases.add(s.conns.c_shop?.status ?? 'none');
    seen.schemas.add(d?.schemasStatus ?? 'none');
    seen.main.add(d?.schemaStatus.main ?? 'none');
    if (d?.revalidating?.main || d?.schemasRevalidating || s.conns.c_shop?.revalidating) seen.revalidating = true;
  });
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
}

describe('catalog store: revalidating keeps loaded data ready', () => {
  beforeEach(async () => {
    useCatalog.setState({ conns: {}, dbs: {} });
    await useConnections.getState().load();
  });

  it('a first load still shows "loading"', async () => {
    const seen = await statuses(async () => {
      await useCatalog.getState().loadDatabases('c_shop');
      await useCatalog.getState().loadSchemas('c_shop', 'main');
      await useCatalog.getState().loadSchema('c_shop', 'main', 'main');
    });
    expect(seen.databases.has('loading')).toBe(true);
    expect(seen.schemas.has('loading')).toBe(true);
    expect(seen.main.has('loading')).toBe(true);
    expect(useCatalog.getState().dbs[KEY].schemaStatus.main).toBe('ready');
  });

  it('forced reloads of shown data never leave "ready" and keep the old data meanwhile', async () => {
    const cat = useCatalog.getState();
    await cat.loadDatabases('c_shop');
    await cat.loadSchemas('c_shop', 'main');
    await cat.loadSchema('c_shop', 'main', 'main');
    const before = useCatalog.getState().dbs[KEY];
    const objects = before.loaded.main.objects.length;
    let dataWhileLoading = true;
    const unsub = useCatalog.subscribe((s) => {
      const d = s.dbs[KEY];
      if (!d?.loaded.main || !d.schemasResp || !s.conns.c_shop?.databases) dataWhileLoading = false;
    });
    const seen = await statuses(async () => {
      await Promise.all([
        useCatalog.getState().loadDatabases('c_shop', true),
        useCatalog.getState().loadSchemas('c_shop', 'main', true),
        useCatalog.getState().loadSchema('c_shop', 'main', 'main', true),
      ]);
    });
    unsub();
    expect([...seen.databases]).toEqual(['ready']);
    expect([...seen.schemas]).toEqual(['ready']);
    expect([...seen.main]).toEqual(['ready']);
    expect(seen.revalidating).toBe(true);
    expect(dataWhileLoading).toBe(true);
    const after = useCatalog.getState().dbs[KEY];
    expect(after.loaded.main.objects.length).toBe(objects);
    expect(after.revalidating?.main).toBeFalsy();
    expect(after.schemasRevalidating).toBe(false);
    expect(useCatalog.getState().conns.c_shop.revalidating).toBe(false);
  });

  it('refresh() of a whole connection is flash-free too', async () => {
    const cat = useCatalog.getState();
    await cat.loadDatabases('c_shop');
    await cat.ensureDefault('c_shop', 'main');
    await cat.loadSchemas('c_shop', 'main');
    const seen = await statuses(() => useCatalog.getState().refresh('c_shop'));
    expect(seen.databases.has('loading')).toBe(false);
    expect(seen.schemas.has('loading')).toBe(false);
    expect(seen.main.has('loading')).toBe(false);
  });

  it('a failed revalidation keeps the shown data (no error row replacing the children)', async () => {
    const cat = useCatalog.getState();
    await cat.loadSchemas('c_shop', 'main');
    await cat.loadSchema('c_shop', 'main', 'main');
    mock.server.use(
      http.get('*/api/v1/connections/:id/catalog', () => HttpResponse.json({ error: { code: 'PROVIDER_ERROR', message: 'boom' } }, { status: 500 })),
      http.get('*/api/v1/connections/:id/catalog/schemas', () => HttpResponse.json({ error: { code: 'PROVIDER_ERROR', message: 'boom' } }, { status: 500 })),
    );
    try {
      await useCatalog.getState().loadSchema('c_shop', 'main', 'main', true);
      await useCatalog.getState().loadSchemas('c_shop', 'main', true);
    } finally {
      mock.server.resetHandlers();
    }
    const d = useCatalog.getState().dbs[KEY];
    expect(d.schemaStatus.main).toBe('ready');
    expect(d.loaded.main).toBeDefined();
    expect(d.schemasStatus).toBe('ready');
    expect(d.revalidating?.main).toBeFalsy();
  });

  it.each([
    ['c_prod', 'tsql', 'dbo', ['master', 'Shop', 'Staging']],
    ['c_pg', 'pgsql', 'public', []],
    ['c_ora', 'plsql', 'SHOP', []],
    ['c_shop', 'sqlite', 'main', []],
  ] as const)('%s: the console path (preload → snapshot → IntelliSense) offers the schemas and databases', async (cid, dialect, def, dbs) => {
    await preloadCatalog(cid, null);
    const db = catalogDatabase(cid, null); // the console's key (the current database once the list is known)
    await until(() => !!useCatalog.getState().dbs[dbKey(cid, db)]?.snapshot?.schemaNames?.length);
    const snap = useCatalog.getState().dbs[dbKey(cid, db)].snapshot!;
    expect(snap.schemaNames).toContain(def);
    const intel = createIntel(dialect);
    intel.setCatalog(snap);
    intel.setDocument('u', 'SELECT * FROM ');
    const items = intel.complete('u', 'SELECT * FROM '.length).items;
    expect(items.find((x) => x.kind === 'schema' && x.label === def), `${def} offered`).toBeTruthy();
    expect(items.filter((x) => x.kind === 'database').map((x) => x.label).sort()).toEqual([...dbs].sort());
  });

  it('a database loaded by another path (no schema list yet) still gets the schema list for IntelliSense', async () => {
    await useCatalog.getState().loadSchema('c_prod', 'Shop', 'dbo');
    expect(useCatalog.getState().dbs[dbKey('c_prod', 'Shop')].schemasStatus).toBe('idle');
    await useCatalog.getState().ensureDefault('c_prod', 'Shop');
    await until(() => !!useCatalog.getState().dbs[dbKey('c_prod', 'Shop')]?.snapshot?.schemaNames?.length);
  });

  it('revalidate() reloads only the named schema of the cached database', async () => {
    const cat = useCatalog.getState();
    await cat.loadDatabases('c_shop');
    await cat.ensureDefault('c_shop', 'main');
    await cat.loadSchemas('c_shop', 'main');
    mock.ctx.requests.length = 0;
    const seen = await statuses(() => useCatalog.getState().revalidate('c_shop', 'main', ['MAIN']));
    expect(mock.hits('/catalog/refresh', 'POST')).toHaveLength(1);
    expect(mock.hits('/catalog').map((r) => r.url.searchParams.get('schemas'))).toEqual(['main']);
    expect(mock.hits('/catalog/databases')).toHaveLength(0);
    expect(seen.main.has('loading')).toBe(false);
  });
});

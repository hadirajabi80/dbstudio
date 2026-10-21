// 1.1.2 explorer filter: type chips, column search, "load schema X" hints, 20k objects < 50 ms.
import { describe, expect, it } from 'vitest';
import type { CatalogObject, CatalogObjectType, ConnectionProfile } from '../../api/types';
import { dbKey, type ConnCatalog, type DbCatalog } from '../../store/catalog';
import { buildTree, nodeId, typesOfChips, type TreeInput } from './tree';

const conn = (id: string, name: string): ConnectionProfile => ({
  id, name, providerId: 'sqlserver', color: null, folder: null, readOnly: false, props: {}, hasPassword: false, savePassword: false,
  createdAt: '', lastUsedAt: null,
});

function objects(n: number): CatalogObject[] {
  const types: CatalogObjectType[] = ['table', 'view', 'proc', 'func', 'sequence'];
  return Array.from({ length: n }, (_, i) => ({
    t: types[i % types.length], n: `${['Customer', 'Order', 'Invoice', 'Audit'][i % 4]}Item${i}`,
    c: [['Id', 'int', 0, 1, 0, null], ['Email', 'nvarchar(200)', 1, 0, 0, null]],
  }));
}

function input(over: Partial<TreeInput> = {}, count = 50): TreeInput {
  const d: DbCatalog = {
    connectionId: 'c1', database: 'Shop', schemasResp: { database: 'Shop', defaultSchema: 'dbo', schemas: [{ name: 'dbo', loaded: true }, { name: 'sales', loaded: false }] },
    schemasStatus: 'ready', schemasError: null, loaded: { dbo: { name: 'dbo', version: 1, objects: objects(count) } }, schemaStatus: { dbo: 'ready' },
    schemaError: {}, etags: {}, dialect: 'tsql', defaultSchema: 'dbo', databasesList: ['Shop'], snapshot: null,
  };
  const conns: Record<string, ConnCatalog> = { c1: { databases: { databases: ['Shop'], current: 'Shop' }, status: 'ready', error: null } };
  return {
    connections: [conn('c1', 'Prod')], conns, dbs: { k: d }, expanded: new Set(['c:c1']), collapsedFolders: new Set(), filter: '', ...over,
  };
}

describe('explorer tree filter', () => {
  it('filters by type chips', () => {
    const types = typesOfChips(['views']);
    const rows = buildTree(input({ filter: 'item', typesFor: () => types }));
    const objs = rows.filter((r) => r.kind === 'object');
    expect(objs.length).toBeGreaterThan(0);
    expect(objs.every((r) => r.objectType === 'view')).toBe(true);
  });

  it('searches columns too: shows the table expanded with the matching column', () => {
    const plain = buildTree(input({ filter: 'email' }));
    expect(plain.some((r) => r.kind === 'column')).toBe(false);
    const rows = buildTree(input({ filter: 'email', searchColumns: true }));
    const cols = rows.filter((r) => r.kind === 'column');
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.every((r) => r.label === 'Email')).toBe(true);
  });

  it('offers to load schemas that are not loaded yet', () => {
    const rows = buildTree(input({ filter: 'order' }));
    const hint = rows.find((r) => r.status === 'load');
    expect(hint?.label).toBe('Load schema Shop.sales to search it');
    expect(hint?.loadSchema).toBe('sales');
  });

  it('filters 20k objects in < 50 ms', () => {
    const big = input({}, 20_000);
    buildTree({ ...big, filter: 'cu' }); // warm up
    // The best of 5 runs per filter is the cost of the code itself; a loaded CI runner (GC pause, another worker on the
    // same core) only ever adds to single samples, which made a median of single samples flaky (logic-r2-03).
    const RUNS = 5;
    const best: Record<string, number> = {};
    for (const f of ['cu', 'ord', 'invit', 'audititem19', 'zz']) {
      best[f] = Infinity;
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        buildTree({ ...big, filter: f });
        best[f] = Math.min(best[f], performance.now() - t0);
      }
    }
    const times = Object.values(best).sort((a, b) => a - b);
    const summary = Object.entries(best).map(([f, ms]) => `${f}: ${ms.toFixed(1)} ms`).join(', ');
    expect(times[Math.floor(times.length / 2)], `best of ${RUNS} runs per filter: ${summary}`).toBeLessThan(50);
  });
});

describe('explorer tree while the catalog revalidates (no collapse / flash after a save or refresh)', () => {
  /** Connection, database, schema and the Tables folder expanded. */
  function expandedInput(patch: (d: DbCatalog, c: ConnCatalog) => void): TreeInput {
    const base = input();
    const d = { ...base.dbs.k };
    const c = { ...base.conns.c1 };
    patch(d, c);
    return {
      ...base,
      conns: { c1: c },
      dbs: { [dbKey('c1', 'Shop')]: d },
      expanded: new Set([nodeId.conn('c1'), nodeId.db('c1', 'Shop'), nodeId.schema('c1', 'Shop', 'dbo'), nodeId.folder('c1', 'Shop', 'dbo', 'table')]),
    };
  }
  const shape = (rows: ReturnType<typeof buildTree>) => rows.map((r) => `${r.kind}:${r.label}`);

  it('a ready schema with a force reload in flight keeps its children', () => {
    const ready = buildTree(expandedInput(() => undefined));
    expect(ready.some((r) => r.kind === 'object')).toBe(true);
    const reloading = buildTree(expandedInput((d) => { d.revalidating = { dbo: true }; d.schemasRevalidating = true; }));
    expect(shape(reloading)).toEqual(shape(ready));
    expect(reloading.some((r) => r.kind === 'status')).toBe(false);
  });

  it('never replaces shown data with "Loading…" rows, even if a status says loading', () => {
    const ready = buildTree(expandedInput(() => undefined));
    const rows = buildTree(expandedInput((d, c) => {
      c.status = 'loading';
      d.schemasStatus = 'loading';
      d.schemaStatus = { dbo: 'loading' };
    }));
    expect(rows.filter((r) => r.kind === 'status')).toEqual([]);
    expect(shape(rows)).toEqual(shape(ready));
  });

  it('a first load still shows the loading rows', () => {
    const rows = buildTree(expandedInput((d) => {
      d.schemasResp = null;
      d.schemasStatus = 'loading';
    }));
    expect(rows.find((r) => r.kind === 'status')?.label).toBe('Loading schemas…');
    const objs = buildTree(expandedInput((d) => {
      d.loaded = {};
      d.schemaStatus = { dbo: 'loading' };
    }));
    expect(objs.find((r) => r.kind === 'status')?.label).toBe('Loading objects…');
  });

  it('spins the connection root while an explicit refresh reloads the database list, not for quiet revalidations', () => {
    const rows = buildTree(expandedInput((_d, c) => { c.revalidating = true; }));
    expect(rows.find((r) => r.kind === 'connection')?.busy).toBe(true);
    const quiet = buildTree(expandedInput((d) => { d.revalidating = { dbo: true }; }));
    expect(quiet.find((r) => r.kind === 'connection')?.busy).toBe(false);
  });
});

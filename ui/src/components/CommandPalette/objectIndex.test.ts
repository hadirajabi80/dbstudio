// A3: go-to-object over all loaded schemas of all connections; < 30 ms for 50k objects.
import { describe, expect, it } from 'vitest';
import type { CatalogObject, CatalogObjectType, CatalogSchema } from '../../api/types';
import type { DbCatalog } from '../../store/catalog';
import { collectEntries, parseObjectQuery, searchObjects } from './objectIndex';

const WORDS = ['Customer', 'Order', 'Invoice', 'Product', 'Payment', 'Shipment', 'Account', 'Ledger', 'Audit', 'Event', 'Stock', 'Price', 'Region', 'User', 'Role'];
const TYPES: CatalogObjectType[] = ['table', 'table', 'table', 'view', 'proc', 'func', 'sequence'];

function db(cid: string, database: string, schemas: number, perSchema: number): DbCatalog {
  const loaded: Record<string, CatalogSchema> = {};
  let n = 0;
  for (let s = 0; s < schemas; s++) {
    const objects: CatalogObject[] = [];
    for (let i = 0; i < perSchema; i++, n++) {
      const name = `${WORDS[n % WORDS.length]}${WORDS[(n * 7) % WORDS.length]}_${n}`;
      objects.push({ t: TYPES[n % TYPES.length], n: name, c: [['Id', 'int', 0, 1, 0, null], ['Name', 'nvarchar(100)', 1, 0, 0, null]] });
    }
    loaded[`s${s}`] = { name: `s${s}`, version: 1, objects };
  }
  return {
    connectionId: cid, database, schemasResp: null, schemasStatus: 'ready', schemasError: null, loaded, schemaStatus: {}, schemaError: {},
    etags: {}, dialect: 'tsql', defaultSchema: 's0', databasesList: [], snapshot: null,
  };
}

const dbs: Record<string, DbCatalog> = {
  a: db('c_a', 'Sales', 10, 2500), // 25k
  b: db('c_b', 'Ops', 10, 2500), // 25k
};

describe('object index', () => {
  it('parses type prefixes', () => {
    expect(parseObjectQuery('t:ord')).toEqual({ prefix: 't', pattern: 'ord' });
    expect(parseObjectQuery('  ord ')).toEqual({ prefix: null, pattern: 'ord' });
  });

  it('finds objects across connections, best match first, filtered by prefix', () => {
    const groups = collectEntries(dbs, false);
    expect(groups.reduce((n, g) => n + g.length, 0)).toBe(50_000);
    const hits = searchObjects(groups, 'OrderLedger_1', 20);
    expect(hits[0].entry.name).toBe('OrderLedger_1');
    const tables = searchObjects(groups, 't:inv', 200);
    expect(tables.length).toBe(200);
    expect(tables.every((h) => h.entry.type === 'table')).toBe(true);
    expect(new Set(searchObjects(groups, 'ledger', 200).map((h) => h.entry.connectionId)).size).toBe(2);
  });

  it('indexes columns only for c:', () => {
    const groups = collectEntries(dbs, true);
    const cols = searchObjects(groups, 'c:audit.name', 10);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.every((h) => h.entry.type === 'column')).toBe(true);
    expect(searchObjects(groups, 'Name', 50).every((h) => h.entry.type !== 'column')).toBe(true);
  });

  it('searches 50k objects in < 30 ms', () => {
    const groups = collectEntries(dbs, false);
    for (const q of ['cu', 'ord', 'xyz']) searchObjects(groups, q); // warm up (JIT)
    const times: number[] = [];
    for (const q of ['c', 'cu', 'cust', 'custord', 'invoicepay', 'v:aud', 'p:st', 'zz', 'ledger_12', 'rol']) {
      const t0 = performance.now();
      searchObjects(groups, q, 200);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)];
    expect(median).toBeLessThan(30);
  });

  it('re-uses entries of unchanged schemas (incremental)', () => {
    const g1 = collectEntries(dbs, false);
    const g2 = collectEntries(dbs, false);
    expect(g2[0]).toBe(g1[0]);
  });
});

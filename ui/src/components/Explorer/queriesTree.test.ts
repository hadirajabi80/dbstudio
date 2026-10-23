// Saved queries in the explorer tree: a "Queries" folder after the object folders of every schema (with its count),
// the queries by name inside it, the type chips (Queries chip), and the filter matching query names.
import { describe, expect, it } from 'vitest';
import type { CatalogObject, ConnectionProfile } from '../../api/types';
import type { SavedQuery } from '../../api/savedQueries';
import { dbKey, type ConnCatalog, type DbCatalog } from '../../store/catalog';
import type { ConnQueries } from '../../store/savedQueries';
import { buildTree, nodeId, queriesShown, typesOfChips, type TreeInput } from './tree';

const conn = (id: string, providerId: ConnectionProfile['providerId'] = 'sqlserver'): ConnectionProfile => ({
  id, name: id === 'c1' ? 'Prod' : id, providerId, color: null, folder: null, readOnly: false, props: {}, hasPassword: false, savePassword: false,
  createdAt: '', lastUsedAt: null,
});

const objects: CatalogObject[] = [{ t: 'table', n: 'Orders' }, { t: 'view', n: 'OrderTotals' }, { t: 'proc', n: 'GetOrder' }];

const q = (id: string, name: string, schema: string, database: string | null = 'Shop'): SavedQuery => ({
  id, connectionId: 'c1', database, schema, name, sql: `SELECT '${name}'`, description: null, createdAt: '', updatedAt: '',
});

function input(over: Partial<TreeInput> = {}, queries: ConnQueries | undefined = { status: 'ready', items: [q('q1', 'Revenue', 'dbo'), q('q2', 'Audit', 'dbo'), q('q3', 'Other schema', 'sales')] }): TreeInput {
  const d: DbCatalog = {
    connectionId: 'c1', database: 'Shop', schemasResp: { database: 'Shop', defaultSchema: 'dbo', schemas: [{ name: 'dbo', loaded: true }, { name: 'sales', loaded: true }] },
    schemasStatus: 'ready', schemasError: null, loaded: { dbo: { name: 'dbo', version: 1, objects }, sales: { name: 'sales', version: 1, objects: [] } },
    schemaStatus: { dbo: 'ready', sales: 'ready' }, schemaError: {}, etags: {}, dialect: 'tsql', defaultSchema: 'dbo', databasesList: ['Shop'], snapshot: null,
  };
  const conns: Record<string, ConnCatalog> = { c1: { databases: { databases: ['Shop'], current: 'Shop' }, status: 'ready', error: null } };
  return {
    connections: [conn('c1')], conns, dbs: { [dbKey('c1', 'Shop')]: d }, collapsedFolders: new Set(), filter: '',
    expanded: new Set([nodeId.conn('c1'), nodeId.db('c1', 'Shop'), nodeId.schema('c1', 'Shop', 'dbo'), nodeId.schema('c1', 'Shop', 'sales')]),
    savedQueries: { c1: queries }, ...over,
  };
}

const shape = (rows: ReturnType<typeof buildTree>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.kind}:${r.label}${r.count !== undefined ? ` (${r.count})` : ''}`);

describe('explorer: saved queries', () => {
  it('adds a Queries folder after the object folders of every schema, with its count', () => {
    const rows = buildTree(input());
    const dbo = rows.findIndex((r) => r.kind === 'schema' && r.label === 'dbo');
    const sales = rows.findIndex((r) => r.kind === 'schema' && r.label === 'sales');
    expect(shape(rows.slice(dbo, sales))).toEqual([
      '    schema:dbo (3)', '      folder:Tables (1)', '      folder:Views (1)', '      folder:Procedures (1)', '      qfolder:Queries (2)',
    ]);
    // an empty schema shows its Queries folder instead of "No objects"
    expect(shape(rows.slice(sales))).toEqual(['    schema:sales (0)', '      qfolder:Queries (1)']);
    const folder = rows.find((r) => r.kind === 'qfolder')!;
    expect(folder.id).toBe(nodeId.queries('c1', 'Shop', 'dbo'));
    expect(folder).toMatchObject({ connectionId: 'c1', database: 'Shop', schema: 'dbo', expanded: false });
  });

  it('lists the queries of the schema by name when the folder is open; an empty folder says so', () => {
    const base = input();
    const open = new Set([...base.expanded, nodeId.queries('c1', 'Shop', 'dbo')]);
    const rows = buildTree({ ...base, expanded: open });
    const queries = rows.filter((r) => r.kind === 'query');
    expect(queries.map((r) => r.label)).toEqual(['Revenue', 'Audit']); // the store keeps them sorted; the tree keeps its order
    expect(queries[0]).toMatchObject({ id: nodeId.savedQuery('c1', 'q1'), schema: 'dbo', database: 'Shop', expandable: false });
    expect(queries[0].savedQuery?.sql).toBe("SELECT 'Revenue'");

    const empty = buildTree({ ...input({}, { status: 'ready', items: [] }), expanded: open });
    expect(empty.find((r) => r.kind === 'qfolder')?.count).toBeUndefined();
    expect(empty.find((r) => r.id.startsWith(`${nodeId.queries('c1', 'Shop', 'dbo')}#`))?.label).toBe('No saved queries');
    const loading = buildTree({ ...input({ savedQueries: { c1: undefined } }), expanded: open });
    expect(loading.find((r) => r.id.startsWith(`${nodeId.queries('c1', 'Shop', 'dbo')}#`))?.label).toBe('Loading queries…');
  });

  it('has no Queries folders when the tree is built without saved queries (other callers)', () => {
    const rows = buildTree({ ...input(), savedQueries: undefined });
    expect(rows.some((r) => r.kind === 'qfolder')).toBe(false);
    expect(rows.some((r) => r.label === 'No objects')).toBe(true);
  });

  it('follows the type chips: hidden by an object-type chip, shown with the Other chip', () => {
    expect(queriesShown([])).toBe(true);
    expect(queriesShown(['tables'])).toBe(false);
    expect(queriesShown(['tables', 'other'])).toBe(true);

    const tables = buildTree(input({ typesFor: () => typesOfChips(['tables']), queriesFor: () => queriesShown(['tables']) }));
    expect(tables.some((r) => r.kind === 'qfolder')).toBe(false);
    // "Other" on a schema without other objects: only its Queries folders
    const other = buildTree(input({ typesFor: () => typesOfChips(['other']), queriesFor: () => queriesShown(['other']) }));
    expect(other.filter((r) => r.kind === 'folder')).toEqual([]);
    expect(other.filter((r) => r.kind === 'qfolder').map((r) => r.schema)).toEqual(['dbo', 'sales']);
  });

  it('the filter matches saved query names, shown under their schema after the objects', () => {
    const rows = buildTree(input({ filter: 'rev' }));
    expect(shape(rows)).toEqual(['connection:Prod (1)', '  schema:Shop · dbo (1)', '    query:Revenue']);
    expect(rows[2].match?.length).toBeGreaterThan(0);

    const mixed = buildTree(input({ filter: 'or' }));
    const kinds = mixed.filter((r) => r.kind === 'object' || r.kind === 'query').map((r) => `${r.kind}:${r.label}`);
    expect(kinds).toContain('query:Other schema');
    expect(kinds).toContain('object:Orders');
    // the Queries chip off: no query hits
    const off = buildTree(input({ filter: 'rev', queriesFor: () => false }));
    expect(off.some((r) => r.kind === 'query')).toBe(false);
  });

  it('Oracle-style schemas without a database level key the folder by the schema alone', () => {
    const base = input();
    const d: DbCatalog = { ...base.dbs[dbKey('c1', 'Shop')], database: null, schemasResp: { database: null, defaultSchema: 'SHOP', schemas: [{ name: 'SHOP', loaded: true }] }, loaded: { SHOP: { name: 'SHOP', version: 1, objects } }, schemaStatus: { SHOP: 'ready' } };
    const rows = buildTree({
      ...base, connections: [conn('c1', 'oracle')], conns: { c1: { databases: { databases: [], current: 'SHOP' }, status: 'ready', error: null } },
      dbs: { [dbKey('c1', null)]: d }, expanded: new Set([nodeId.conn('c1'), nodeId.queries('c1', null, 'SHOP')]),
      savedQueries: { c1: { status: 'ready', items: [q('q9', 'Open invoices', 'SHOP', null)] } },
    });
    expect(rows.find((r) => r.kind === 'qfolder')?.id).toBe('q:c1::SHOP');
    expect(rows.find((r) => r.kind === 'query')?.label).toBe('Open invoices');
  });
});

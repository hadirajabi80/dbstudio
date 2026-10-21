// Schemas and databases in IntelliSense: schema / database items in table-source contexts (loaded or not), the
// schema-first object detail (`dbo · table`), qualifier chains per dialect (`db.`, `schema.`, `db.schema.`), and the
// "Loading <schema>…" row while a schema's objects are lazy-loaded (never an empty list).
import { describe, expect, it, vi } from 'vitest';
import type { CatalogSnapshot } from '../../api/types';
import { TOP_CONTAINERS } from '../complete/completer';
import { createIntel } from '../index';
import type { CompletionItem, Dialect } from '../types';
import { complete, find, fixtures } from './helpers';

function intelWith(dialect: Dialect, patch: Partial<CatalogSnapshot>, requester?: (s: string) => void) {
  const intel = createIntel(dialect);
  if (requester) intel.setSchemaRequester(requester);
  intel.setCatalog({ ...(JSON.parse(JSON.stringify(fixtures[dialect])) as CatalogSnapshot), ...patch });
  return intel;
}
const schemas = (items: CompletionItem[]) => items.filter((x) => x.kind === 'schema' && !x.loading).map((x) => x.label);
const databases = (items: CompletionItem[]) => items.filter((x) => x.kind === 'database').map((x) => x.label);
const loading = (items: CompletionItem[]) => items.filter((x) => x.loading);

describe('object detail shows the schema first', () => {
  it.each([
    ['tsql', 'SELECT * FROM |', 'Customers', 'dbo · table'],
    ['pgsql', 'SELECT * FROM |', 'customers', 'public · table'],
    ['plsql', 'SELECT * FROM |', 'CUSTOMERS', 'SHOP · table'],
    ['sqlite', 'SELECT * FROM |', 'customers', 'main · table'],
  ] as const)('%s', (dialect, sql, label, detail) => {
    expect(find(complete(dialect, sql).items, label)?.detail).toBe(detail);
  });

  it('labels routines with their parameters after the name and `schema · kind` on the right', () => {
    const r = complete('tsql', 'EXEC |');
    const proc = r.items.find((x) => x.kind === 'procedure' && x.description);
    expect(proc, 'a catalog procedure').toBeTruthy();
    expect(proc!.description).toMatch(/^dbo · procedure$/);
    expect(proc!.labelDetail).toMatch(/^\(.*\)$/);
  });
});

describe('SQL Server: databases and schemas', () => {
  const intel = intelWith('tsql', { schemaNames: ['dbo', 'Sales', 'Billing'] });
  const at = (sql: string) => complete('tsql', sql, undefined, intel);

  it('offers every schema (the default one too, loaded or not) and every database (the current one too) in FROM, above the tables', () => {
    const r = at('SELECT * FROM |');
    expect(schemas(r.items).sort()).toEqual(['Billing', 'Sales', 'dbo']);
    expect(databases(r.items).sort()).toEqual(['master', 'shop', 'tempdb']);
    expect(find(r.items, 'dbo', (x) => x.kind === 'schema')?.detail).toBe('default schema');
    expect(find(r.items, 'shop', (x) => x.kind === 'database')?.detail).toBe('current database');
    const lastContainer = r.items.map((x) => x.kind === 'schema' || x.kind === 'database').lastIndexOf(true);
    expect(r.items.findIndex((x) => x.label === 'Customers')).toBeGreaterThan(lastContainer);
    for (const x of r.items.filter((i) => i.kind === 'schema' || i.kind === 'database')) {
      expect(x.insertText.endsWith('.'), x.label).toBe(true);
      expect(x.command, x.label).toBe('retrigger');
    }
    // the other schemas rank a little above the default schema, the databases after the schemas
    const pos = (label: string) => r.items.findIndex((x) => x.label === label && (x.kind === 'schema' || x.kind === 'database'));
    expect(pos('Sales')).toBeLessThan(pos('dbo'));
    expect(pos('dbo')).toBeLessThan(pos('shop'));
    expect(pos('shop')).toBeLessThan(pos('master'));
    expect(find(r.items, 'dbo', (x) => x.kind === 'schema')?.usageKey).toBe('schema:dbo');
  });

  it('`dbo.` and the current database `shop.` resolve: the default schema\'s objects / the schemas', () => {
    expect(at('SELECT * FROM dbo.|').items.map((x) => x.label)).toContain('Customers');
    expect(schemas(at('SELECT * FROM shop.|').items)).toEqual(expect.arrayContaining(['dbo', 'Sales']));
  });

  it('EXEC | offers the databases too (`db.schema.proc`), below the procedures', () => {
    const r = at('EXEC |');
    expect(r.items[0].kind).toBe('procedure');
    expect(databases(r.items).sort()).toEqual(['master', 'shop', 'tempdb']);
    expect(schemas(r.items)).toEqual(expect.arrayContaining(['dbo', 'Sales', 'Billing']));
    expect(find(r.items, 'shop', (x) => x.kind === 'database')?.insertText).toBe('shop.');
  });

  it('DDL object names offer the schemas (default included) but no databases', () => {
    const r = at('DROP TABLE |');
    expect(schemas(r.items)).toEqual(expect.arrayContaining(['dbo', 'Sales']));
    expect(databases(r.items)).toEqual([]);
  });

  it('keeps schema items for a typed prefix (not only fuzzy matches)', () => {
    expect(schemas(at('SELECT * FROM Bil|').items)).toEqual(['Billing']);
  });

  it('`db.` → that database\'s schemas; `db.schema.` → its objects; `db..obj` → the default schema', () => {
    expect(schemas(at('SELECT * FROM shop.|').items)).toEqual(expect.arrayContaining(['dbo', 'Sales', 'Billing']));
    expect(at('SELECT * FROM shop.Sales.|').items.map((x) => x.label)).toContain('Invoices');
    expect(at('SELECT * FROM shop..|').items.map((x) => x.label)).toContain('Customers');
  });

  it('shows nothing (no empty box, no placeholder) for another database whose catalog is not loaded', () => {
    const r = at('SELECT * FROM master.|');
    expect(r.items).toEqual([]);
  });

  it('`schema.` of an unloaded schema → one "Loading <schema>…" row, an incomplete result, and a load request', () => {
    const req = vi.fn();
    const i2 = intelWith('tsql', { schemaNames: ['dbo', 'Sales', 'Billing'] }, req);
    const r = complete('tsql', 'SELECT * FROM Billing.|', undefined, i2);
    expect(r.items.map((x) => x.label)).toEqual(['Loading Billing…']);
    expect(r.isIncomplete).toBe(true);
    expect(req).toHaveBeenCalledWith('Billing');
    // typed on: still the one row, and accepting it changes nothing
    const r2 = complete('tsql', 'SELECT * FROM Billing.inv|', undefined, i2);
    expect(loading(r2.items)).toHaveLength(1);
    expect(loading(r2.items)[0].insertText).toBe('inv');
    expect(loading(r2.items)[0].filterText).toBe('inv');
  });
});

describe('the default schema is offered in every dialect (a database with only dbo / public / main / the own schema)', () => {
  it.each([
    ['tsql', { schemaNames: ['dbo'] }, 'dbo', 'default schema'],
    ['pgsql', { schemaNames: ['public'] }, 'public', 'default schema'],
    ['plsql', { schemaNames: ['SHOP'] }, 'SHOP', 'default schema'],
    ['sqlite', {}, 'main', 'default database'],
  ] as const)('%s', (dialect, patch, name, detail) => {
    const base = JSON.parse(JSON.stringify(fixtures[dialect])) as CatalogSnapshot;
    const def = base.schemas.filter((s) => s.name === base.defaultSchema);
    const names = 'schemaNames' in patch ? { schemaNames: [...patch.schemaNames] } : {};
    const intel = intelWith(dialect, { ...names, schemas: def });
    const r = complete(dialect, 'SELECT * FROM |', undefined, intel);
    const item = find(r.items, name, (x) => x.kind === 'schema');
    expect(item, `${name} offered`).toBeTruthy();
    expect(item!.detail).toBe(detail);
    expect(item!.insertText).toBe(name + '.');
    expect(item!.command).toBe('retrigger');
    // typed: still there
    expect(find(complete(dialect, `SELECT * FROM ${name.slice(0, 2)}|`, undefined, intel).items, name, (x) => x.kind === 'schema')).toBeTruthy();
  });
});

describe('T-SQL `USE |`', () => {
  const intel = intelWith('tsql', { schemaNames: ['dbo', 'Sales'] });
  const at = (sql: string) => complete('tsql', sql, undefined, intel);

  it('lists the databases (the name only: no dot, no retrigger), the current one last', () => {
    const r = at('USE |');
    expect(databases(r.items).sort()).toEqual(['master', 'shop', 'tempdb']);
    expect(r.items.every((x) => x.kind === 'database')).toBe(true);
    for (const x of r.items) {
      expect(x.insertText, x.label).toBe(x.label);
      expect(x.command, x.label).toBeUndefined();
    }
    expect(r.items.at(-1)?.label).toBe('shop');
    expect(find(r.items, 'shop')?.detail).toBe('current database');
  });

  it('filters by the typed prefix and quotes when needed', () => {
    expect(databases(at('USE ma|').items)).toEqual(['master']);
    const odd = intelWith('tsql', { databases: ['my db', 'shop'] });
    expect(find(complete('tsql', 'USE |', undefined, odd).items, 'my db')?.insertText).toBe('[my db]');
  });

  it('after the name (and in a later statement) databases are no longer offered', () => {
    expect(databases(at('USE shop |').items)).toEqual([]);
    expect(databases(at('USE shop;\nSELECT 1 |').items)).toEqual([]);
  });

  it('PostgreSQL has no USE: no database items', () => {
    expect(databases(complete('pgsql', 'USE |').items)).toEqual([]);
  });
});

describe('ranking with a big catalog (300 tables)', () => {
  function big(dialect: Dialect, schemaNames: string[]) {
    const base = JSON.parse(JSON.stringify(fixtures[dialect])) as CatalogSnapshot;
    const def = base.schemas.find((s) => s.name === base.defaultSchema)!;
    const objects = Array.from({ length: 300 }, (_, i) => ({ n: `T${String(i).padStart(3, '0')}_${['Order', 'Customer', 'Item'][i % 3]}`, t: 'table', c: [['Id', 'int', 0, 1, 0, null]] }));
    def.objects = [...def.objects, ...objects] as typeof def.objects;
    return intelWith(dialect, { schemaNames, schemas: [def] });
  }
  const FIRST_SCREEN = 12;

  it.each([
    ['tsql', ['dbo', 'Sales', 'Billing'], ['dbo', 'Sales', 'Billing', 'shop', 'master', 'tempdb']],
    ['pgsql', ['public', 'sales', 'audit'], ['public', 'sales', 'audit']],
    ['plsql', ['SHOP', 'HR', 'FINANCE'], ['SHOP', 'HR', 'FINANCE']],
  ] as const)('%s: the schemas and databases are on the first screen of `FROM |`, followed by tables', (dialect, names, want) => {
    const r = complete(dialect, 'SELECT * FROM |', undefined, big(dialect, [...names]));
    const first = r.items.slice(0, FIRST_SCREEN);
    expect(first.filter((x) => x.kind === 'schema' || x.kind === 'database').map((x) => x.label).sort()).toEqual([...want].sort());
    expect(first.some((x) => x.kind === 'table')).toBe(true);
  });

  it('many schemas: only the budget ranks above the tables (the default schema and the current database first)', () => {
    const many = ['dbo', ...Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, '0')}`)];
    const r = complete('tsql', 'SELECT * FROM |', undefined, big('tsql', many));
    const first = r.items.slice(0, FIRST_SCREEN);
    const containers = first.filter((x) => x.kind === 'schema' || x.kind === 'database');
    expect(containers.length).toBeLessThanOrEqual(TOP_CONTAINERS);
    expect(containers.map((x) => x.label)).toEqual(expect.arrayContaining(['dbo', 'shop']));
    expect(first.filter((x) => x.kind === 'table').length).toBeGreaterThanOrEqual(FIRST_SCREEN - TOP_CONTAINERS);
    // the rest are still offered (below the tables) and come up by prefix
    expect(schemas(r.items)).toHaveLength(many.length);
    const typed = complete('tsql', 'SELECT * FROM s39|', undefined, big('tsql', many));
    expect(typed.items[0].label).toBe('s39');
  });

  it('a typed prefix decides: `sa` puts the Sales schema first', () => {
    const r = complete('tsql', 'SELECT * FROM Sal|', undefined, big('tsql', ['dbo', 'Sales']));
    expect(r.items[0].label).toBe('Sales');
  });
});

describe('PostgreSQL: schemas only', () => {
  const intel = intelWith('pgsql', { schemaNames: ['public', 'sales', 'audit'] });
  const at = (sql: string) => complete('pgsql', sql, undefined, intel);

  it('lists the other schemas in FROM, never databases (no cross-database queries)', () => {
    const r = at('SELECT * FROM |');
    expect(schemas(r.items)).toEqual(expect.arrayContaining(['sales', 'audit']));
    expect(databases(r.items)).toEqual([]);
  });

  it('`schema.` → its objects, or "Loading audit…" while they load', () => {
    expect(at('SELECT * FROM sales.|').items.map((x) => x.label)).toContain('invoices');
    expect(at('SELECT * FROM audit.|').items.map((x) => x.label)).toEqual(['Loading audit…']);
  });
});

describe('Oracle: schemas (users)', () => {
  const intel = intelWith('plsql', { schemaNames: ['SHOP', 'HR', 'FINANCE'] });
  const at = (sql: string) => complete('plsql', sql, undefined, intel);

  it('lists the other schemas in FROM and `schema.` → its objects / a loading row', () => {
    expect(schemas(at('SELECT * FROM |').items)).toEqual(expect.arrayContaining(['HR', 'FINANCE']));
    expect(at('SELECT * FROM HR.|').items.map((x) => x.label)).toContain('EMPLOYEES');
    // unquoted `finance` folds to FINANCE, the placeholder names it as typed
    expect(at('SELECT * FROM finance.|').items.map((x) => x.label)).toEqual(['Loading finance…']);
  });
});

describe('SQLite: attached databases', () => {
  it('lists the attached databases (schemas) in FROM as databases, and `db.` → their tables', () => {
    const r = complete('sqlite', 'SELECT * FROM |');
    const archive = find(r.items, 'archive', (x) => x.kind === 'schema');
    expect(archive?.detail).toBe('database');
    expect(complete('sqlite', 'SELECT * FROM archive.|').items.map((x) => x.label)).toContain('orders_2020');
  });
});

describe('lazy schema loading', () => {
  it('requests a schema again once the schema list arrives (the first request only fetched the list)', () => {
    const req = vi.fn();
    const intel = createIntel('pgsql');
    intel.setSchemaRequester(req);
    const base = JSON.parse(JSON.stringify(fixtures.pgsql)) as CatalogSnapshot;
    intel.setCatalog(base);
    complete('pgsql', 'SELECT * FROM audit.|', undefined, intel);
    complete('pgsql', 'SELECT * FROM audit.|', undefined, intel);
    expect(req).toHaveBeenCalledTimes(1);
    // no list yet: nothing is known about `audit`, so no placeholder either
    expect(complete('pgsql', 'SELECT * FROM audit.|', undefined, intel).items).toEqual([]);
    intel.setCatalog({ ...base, schemaNames: ['public', 'sales', 'audit'] });
    const r = complete('pgsql', 'SELECT * FROM audit.|', undefined, intel);
    expect(req).toHaveBeenCalledTimes(2);
    expect(r.items.map((x) => x.label)).toEqual(['Loading audit…']);
    // loaded: the objects replace the placeholder
    intel.setCatalog({ ...base, schemaNames: ['public', 'sales', 'audit'], schemas: [...base.schemas, { name: 'audit', version: 1, objects: [{ n: 'events', t: 'table', c: [['id', 'int', 0]] }] } as unknown as CatalogSnapshot['schemas'][number]] });
    expect(complete('pgsql', 'SELECT * FROM audit.|', undefined, intel).items.map((x) => x.label)).toEqual(['events']);
  });
});

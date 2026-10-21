// Schemas and databases in IntelliSense: schema / database items in table-source contexts (loaded or not), the
// schema-first object detail (`dbo · table`), qualifier chains per dialect (`db.`, `schema.`, `db.schema.`), and the
// "Loading <schema>…" row while a schema's objects are lazy-loaded (never an empty list).
import { describe, expect, it, vi } from 'vitest';
import type { CatalogSnapshot } from '../../api/types';
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

  it('offers the other schemas (loaded or not) and the other databases in FROM, below the default schema objects', () => {
    const r = at('SELECT * FROM |');
    expect(schemas(r.items)).toEqual(expect.arrayContaining(['Sales', 'Billing']));
    expect(schemas(r.items)).not.toContain('dbo');
    expect(databases(r.items).sort()).toEqual(['master', 'tempdb']);
    const firstContainer = r.items.findIndex((x) => x.kind === 'schema' || x.kind === 'database');
    expect(r.items.findIndex((x) => x.label === 'Customers')).toBeLessThan(firstContainer);
    for (const x of r.items.filter((i) => i.kind === 'schema' || i.kind === 'database')) {
      expect(x.insertText.endsWith('.'), x.label).toBe(true);
      expect(x.command, x.label).toBe('retrigger');
    }
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

// Relationship robustness of the ER model on "old database" catalogs (SQL Server): disabled / untrusted keys,
// cross-schema keys in both directions, keys to unique constraints, composite keys, keys the login cannot resolve, and
// the one-hop schema loading that makes incoming keys from other schemas visible.
import { describe, expect, it } from 'vitest';
import type { CatalogForeignKey, CatalogObject, CatalogSchema } from '../../../api/types';
import { buildModel, oneHopSchemas, relationshipSummary, type ErSchemaExtras } from '../model';
import { populatedSchema } from '../open';

const table = (n: string, cols: [string, 0 | 1][], pk: string[], fk: CatalogForeignKey[] = []): CatalogObject => ({
  t: 'table', n, c: cols.map(([c, nullable]) => [c, 'int', nullable, pk.includes(c) ? 1 : 0, 0, null]), pk, fk,
});

type Schema = CatalogSchema & ErSchemaExtras;

/** The engine's view of the fk_legacy integration database (SqlServerIntegrationTests.Catalog_ForeignKeys_OnAnOldStyleDatabase). */
const dbo: Schema = {
  name: 'dbo', version: 1, refBy: ['Sales', 'hr'], objects: [
    table('Countries', [['Id', 0], ['Code', 0]], ['Id']),
    table('مشتری', [['Id', 0], ['CountryCode', 1], ['Name', 1]], ['Id'], [
      { n: 'FK_Customer_Country', cols: ['CountryCode'], rs: 'dbo', rt: 'Countries', rcols: ['Code'] }, // → unique constraint
    ]),
    table('Orders', [['Id', 0], ['Rev', 0], ['CustomerId', 0]], ['Id', 'Rev'], [
      { n: 'FK_Orders_Customer', cols: ['CustomerId'], rs: 'dbo', rt: 'مشتری', rcols: ['Id'], dis: true, nt: true },
    ]),
  ],
};
const sales: Schema = {
  name: 'Sales', version: 1, objects: [
    table('Invoices', [['Id', 0], ['OrderId', 0], ['OrderRev', 0], ['CustName', 1]], ['Id'], [
      { n: 'FK_Invoices_Orders', cols: ['OrderId', 'OrderRev'], rs: 'dbo', rt: 'Orders', rcols: ['Id', 'Rev'] },
      { n: 'FK_Invoices_CustName', cols: ['CustName'], rs: 'dbo', rt: 'مشتری', rcols: ['Name'] },
    ]),
  ],
};
const hr: Schema = {
  name: 'hr', version: 1, objects: [
    table('Staff', [['Id', 0], ['CountryId', 1]], ['Id'], [{ n: 'FK_Staff_Countries', cols: ['CountryId'], rs: 'DBO', rt: 'countries', rcols: ['Id'], nt: true }]),
  ],
};

describe('ER relationships on an old SQL Server database', () => {
  it('draws same-schema keys, keys to unique constraints and disabled keys (flagged)', () => {
    const m = buildModel({ schemas: [dbo], defaultSchema: 'dbo', scope: { database: 'fk_legacy', schema: 'dbo' } });
    expect(m.memberCount).toBe(3);
    const byName = new Map(m.edges.map((e) => [e.name, e]));
    expect(byName.get('FK_Customer_Country')).toMatchObject({ from: 'dbo.مشتری', to: 'dbo.Countries', rcols: ['Code'], ghost: false });
    expect(byName.get('FK_Customer_Country')!.disabled).toBeUndefined();
    expect(byName.get('FK_Orders_Customer')).toMatchObject({ from: 'dbo.Orders', to: 'dbo.مشتری', disabled: true, notTrusted: true });
    expect(m.stats.disabled).toBe(1);
  });

  it('incoming keys from the other schemas appear once those schemas are loaded (as cards of the next hop)', () => {
    const only = buildModel({ schemas: [dbo], defaultSchema: 'dbo', scope: { database: null, schema: 'dbo' } });
    expect(only.edges).toHaveLength(2);

    const all = buildModel({ schemas: [dbo, sales, hr], defaultSchema: 'dbo', scope: { database: null, schema: 'dbo' } });
    expect(all.memberCount).toBe(3);
    const names = all.edges.map((e) => e.name).sort();
    expect(names).toEqual(['FK_Customer_Country', 'FK_Invoices_CustName', 'FK_Invoices_Orders', 'FK_Orders_Customer', 'FK_Staff_Countries']);
    const composite = all.edges.find((e) => e.name === 'FK_Invoices_Orders')!;
    expect(composite).toMatchObject({ from: 'Sales.Invoices', to: 'dbo.Orders', cols: ['OrderId', 'OrderRev'], rcols: ['Id', 'Rev'], ghost: true });
    // case-insensitive reference (old scripts wrote DBO.countries)
    expect(all.edges.find((e) => e.name === 'FK_Staff_Countries')).toMatchObject({ from: 'hr.Staff', to: 'dbo.Countries', notTrusted: true });
    const ghosts = all.nodes.filter((n) => n.ghost).map((n) => n.key).sort();
    expect(ghosts).toEqual(['Sales.Invoices', 'hr.Staff']);
    expect(all.nodes.find((n) => n.key === 'Sales.Invoices')!.unresolved).toBeUndefined();
  });

  it('a diagram of the referencing schema resolves its cross-schema targets once dbo is loaded', () => {
    const before = buildModel({ schemas: [sales], defaultSchema: 'dbo', scope: { database: null, schema: 'Sales' } });
    expect(before.edges).toHaveLength(2);
    expect(before.nodes.filter((n) => n.unresolved)).toHaveLength(2);
    expect(before.stats.unresolved).toBe(2);
    const after = buildModel({ schemas: [sales, dbo], defaultSchema: 'dbo', scope: { database: null, schema: 'Sales' } });
    expect(after.nodes.filter((n) => n.unresolved)).toHaveLength(0);
    expect(after.stats.unresolved).toBe(0);
    expect(after.nodes.find((n) => n.key === 'dbo.Orders')!.columns.map((c) => c.name)).toEqual(['Id', 'Rev', 'CustomerId']);
  });

  it('oneHopSchemas: referenced schemas (fk.rs) and referencing schemas (refBy), not the needed ones', () => {
    expect(oneHopSchemas([dbo], ['dbo'])).toEqual(['Sales', 'hr']);
    expect(oneHopSchemas([sales], ['Sales'])).toEqual(['dbo']);
    expect(oneHopSchemas([hr, dbo], ['hr'])).toEqual(['DBO']);
    expect(oneHopSchemas([hr, dbo], ['hr', 'dbo'])).toEqual(['Sales']);
    expect(oneHopSchemas([], ['dbo'])).toEqual([]); // not loaded yet
    const many: Schema = { name: 'x', version: 1, refBy: Array.from({ length: 50 }, (_, i) => `s${i}`), objects: [] };
    expect(oneHopSchemas([many], ['x'], 5)).toHaveLength(5);
  });

  it('keys whose target the login cannot see are counted, never drawn as empty ghost cards', () => {
    const limited: Schema = {
      name: 'dbo', version: 1, fkHidden: 2, objects: [
        // an older engine sent rt "" for an invisible target
        table('Customers', [['Id', 0], ['CountryCode', 1]], ['Id'], [{ n: 'FK_Customers_Countries', cols: ['CountryCode'], rs: null, rt: '', rcols: [''] }]),
      ],
    };
    const m = buildModel({ schemas: [limited], defaultSchema: 'dbo', scope: { database: null, schema: 'dbo' } });
    expect(m.edges).toHaveLength(0);
    expect(m.nodes.map((n) => n.key)).toEqual(['dbo.Customers']);
    expect(m.nodes[0].columns.find((c) => c.name === 'CountryCode')!.fk).toBe(false);
    expect(m.stats.notVisible).toBe(3);
    const s = relationshipSummary(m);
    expect(s.text).toBe('1 table · 0 relationships · 3 hidden');
    expect(s.warn).toBe(true);
    expect(s.title).toMatch(/not visible to this login/);
  });

  it('summary line: counts, disabled keys and keys to removed tables', () => {
    const m = buildModel({ schemas: [dbo, sales, hr], defaultSchema: 'dbo', scope: { database: null, schema: 'dbo' }, hidden: ['hr.Staff'] });
    const s = relationshipSummary(m);
    expect(s.text).toBe('3 tables · 4 relationships · 1 disabled · 1 hidden');
    expect(s.warn).toBe(false);
    expect(s.title).toMatch(/disabled \(NOCHECK\)/);
    expect(s.title).toMatch(/removed from or filtered out/);
    expect(relationshipSummary({ memberCount: 1, edges: [], stats: { disabled: 0, notVisible: 0, unresolved: 0, filtered: 0 } })).toEqual({ text: '1 table · 0 relationships', title: null, warn: false });
  });
});

describe('default schema of a new diagram', () => {
  const list = [
    { name: 'hadi', objectCount: 0 },
    { name: 'dbo', objectCount: 12 },
    { name: 'Sales', objectCount: 40 },
  ];
  it('keeps a populated or unknown default schema', () => {
    expect(populatedSchema('Sales', list)).toBe('Sales');
    expect(populatedSchema('dbo', [{ name: 'dbo' }])).toBe('dbo');
    expect(populatedSchema(null, list)).toBeNull();
  });
  it("skips the login's empty own schema (SQL Server 2000 upgrade) for dbo, else the fullest schema", () => {
    expect(populatedSchema('hadi', list)).toBe('dbo');
    expect(populatedSchema('hadi', list.filter((s) => s.name !== 'dbo'))).toBe('Sales');
    expect(populatedSchema('hadi', [{ name: 'hadi', objectCount: 0 }])).toBe('hadi');
  });
});

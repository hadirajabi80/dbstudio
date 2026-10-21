import { describe, expect, it } from 'vitest';
import type { CatalogObject, CatalogSchema } from '../../../api/types';
import { catalogObject, SHOP_TABLES } from '../../../mocks/fixtures';
import { buildModel, CARD, cardGeom, readingOrder, relatedTables, rowAnchorY, schemasOfScope, splitKey, type ErNode } from '../model';

const shop = (name = 'main', upper = false): CatalogSchema => ({ name, version: 1, objects: SHOP_TABLES.map((t) => catalogObject(t, name, upper)) });

const table = (n: string, cols: [string, 0 | 1][], pk: string[], fk: CatalogObject['fk'] = []): CatalogObject => ({
  t: 'table', n, c: cols.map(([c, nullable]) => [c, 'int', nullable, pk.includes(c) ? 1 : 0, 0, null]), pk, fk,
});

/** dbo.Customers ← Sales.Orders (cross-schema), Sales.Orders.parent_id → Sales.Orders (self), Sales.Notes unrelated. */
const multi: CatalogSchema[] = [
  { name: 'dbo', version: 1, objects: [table('Customers', [['Id', 0], ['Name', 0]], ['Id'])] },
  {
    name: 'Sales', version: 1, objects: [
      table('Orders', [['Id', 0], ['CustomerId', 0], ['ParentId', 1]], ['Id'], [
        { n: 'FK_Orders_Customers', cols: ['CustomerId'], rs: 'dbo', rt: 'Customers', rcols: ['Id'] },
        { n: 'FK_Orders_Parent', cols: ['ParentId'], rs: 'Sales', rt: 'Orders', rcols: ['Id'] },
      ]),
      table('Lines', [['OrderId', 0], ['No', 0]], ['OrderId', 'No'], [{ n: 'FK_Lines_Orders', cols: ['OrderId'], rs: 'Sales', rt: 'Orders', rcols: ['Id'] }]),
      table('Notes', [['Id', 0]], ['Id']),
      { t: 'view', n: 'vOrders', c: [['Id', 'int', 0, 0, 0, null]] },
      { t: 'proc', n: 'GetOrder' },
    ],
  },
];

describe('ER model from catalog snapshots', () => {
  it('builds the SQLite shop: tables, views, FK edges, PK/FK/nullable flags', () => {
    const m = buildModel({ schemas: [shop()], defaultSchema: 'main', scope: { database: null, schema: 'main' } });
    expect(m.nodes.map((n) => n.key).sort()).toEqual(SHOP_TABLES.map((t) => `main.${t.name}`).sort());
    expect(m.memberCount).toBe(SHOP_TABLES.length);
    expect(m.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      'main.customers->main.countries', 'main.events->main.customers', 'main.order_lines->main.orders', 'main.order_lines->main.products', 'main.orders->main.customers',
    ]);
    const customers = m.byKey.get('main.customers')!;
    expect(customers.label).toBe('customers');
    expect(customers.columns.find((c) => c.name === 'country_id')).toMatchObject({ fk: true, nullable: true, pk: false });
    expect(customers.columns.find((c) => c.name === 'id')).toMatchObject({ pk: true });
    // nullable FK column → optional relationship (dashed); NOT NULL → mandatory
    expect(m.edges.find((e) => e.from === 'main.customers')!.optional).toBe(true);
    expect(m.edges.find((e) => e.from === 'main.orders')!.optional).toBe(false);
    expect(m.byKey.get('main.v_customer_orders')!.type).toBe('view');
  });

  it('resolves upper-case Oracle names and case-insensitive references', () => {
    const s = shop('SHOP', true);
    // a reference written in another case still resolves
    s.objects.find((o) => o.n === 'ORDERS')!.fk![0].rt = 'Customers';
    const m = buildModel({ schemas: [s], defaultSchema: 'SHOP', scope: { database: null, schema: 'SHOP' } });
    expect(m.edges.find((e) => e.from === 'SHOP.ORDERS')!.to).toBe('SHOP.CUSTOMERS');
    expect(m.nodes.some((n) => n.ghost)).toBe(false);
  });

  it('draws cross-schema references as ghosts and self references as loops', () => {
    const m = buildModel({ schemas: multi, defaultSchema: 'dbo', scope: { database: 'Shop', schema: 'Sales' } });
    const ghost = m.byKey.get('dbo.Customers')!;
    expect(ghost.ghost).toBe(true);
    expect(ghost.label).toBe('dbo.Customers');
    expect(m.byKey.get('Sales.Orders')!.label).toBe('Orders');
    expect(m.memberCount).toBe(4); // Orders, Lines, Notes, vOrders (no procs)
    const self = m.edges.find((e) => e.name === 'FK_Orders_Parent')!;
    expect(self).toMatchObject({ self: true, from: 'Sales.Orders', to: 'Sales.Orders', optional: true, ghost: false });
    expect(m.edges.find((e) => e.name === 'FK_Orders_Customers')!.ghost).toBe(true);
  });

  it('adds incoming references from other loaded schemas as ghosts', () => {
    const m = buildModel({ schemas: multi, defaultSchema: 'dbo', scope: { database: 'Shop', schema: 'dbo' } });
    expect(m.byKey.get('Sales.Orders')!.ghost).toBe(true);
    expect(m.edges.map((e) => e.name)).toEqual(['FK_Orders_Customers']);
    expect(m.byKey.has('Sales.Lines')).toBe(false); // two hops away
  });

  it('keeps an unresolved ghost when the referenced schema is not loaded', () => {
    const m = buildModel({ schemas: [multi[1]], defaultSchema: 'Sales', scope: { database: null, schema: 'Sales' } });
    expect(m.byKey.get('dbo.Customers')).toMatchObject({ ghost: true, unresolved: true, columns: [] });
  });

  it('applies hidden, added and the filters', () => {
    const base = { schemas: multi, defaultSchema: 'dbo', scope: { database: null, schema: 'Sales' } } as const;
    const hidden = buildModel({ ...base, hidden: ['Sales.Lines', 'dbo.Customers'] });
    expect(hidden.byKey.has('Sales.Lines')).toBe(false);
    expect(hidden.byKey.has('dbo.Customers')).toBe(false); // hidden tables never come back as ghosts
    const added = buildModel({ ...base, added: ['dbo.Customers'] });
    expect(added.byKey.get('dbo.Customers')!.ghost).toBe(false);
    expect(added.memberCount).toBe(5);
    const noViews = buildModel({ ...base, hideViews: true });
    expect(noViews.byKey.has('Sales.vOrders')).toBe(false);
    const connected = buildModel({ ...base, onlyConnected: true });
    expect(connected.byKey.has('Sales.Notes')).toBe(false);
    expect(connected.byKey.has('Sales.Orders')).toBe(true);
  });

  it('builds a table-set scope and the related set of a table', () => {
    const related = relatedTables(multi, 'Sales.Orders');
    expect(related.sort()).toEqual(['Sales.Lines', 'Sales.Orders', 'dbo.Customers']);
    const m = buildModel({ schemas: multi, defaultSchema: 'dbo', scope: { database: null, tables: related } });
    expect(m.memberCount).toBe(3);
    expect(m.nodes.every((n) => !n.ghost)).toBe(true);
    expect(m.mainSchema).toBe('Sales');
    expect(schemasOfScope({ database: null, tables: related }, ['x.y']).sort()).toEqual(['Sales', 'dbo', 'x']);
    expect(splitKey('main.my.table')).toEqual({ schema: 'main', name: 'my.table' });
  });
});

describe('card geometry', () => {
  const wide: ErNode = {
    key: 'm.wide', schema: 'm', name: 'wide', type: 'table', label: 'wide', pk: ['c0'], fks: [], comment: null, ghost: false,
    columns: Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, type: 'int', nullable: false, pk: i === 0, fk: i === 7 })),
  };

  it('truncates at 25 rows with a "+N more" row and expands', () => {
    const g = cardGeom(wide, { columns: 'all', types: true });
    expect(g.rows).toHaveLength(25);
    expect(g.moreRow).toBe(true);
    expect(g.more).toBe(15);
    expect(g.h).toBe(CARD.headerH + CARD.padY * 2 + 26 * CARD.rowH);
    const e = cardGeom(wide, { columns: 'all', types: true, expanded: new Set(['m.wide']) });
    expect(e.rows).toHaveLength(40);
    expect(e.moreRow).toBe(true); // "Show fewer"
    expect(e.more).toBe(0);
  });

  it('keys-only mode keeps PK/FK rows; names-only is a header', () => {
    const k = cardGeom(wide, { columns: 'keys', types: false });
    expect(k.rows.map((r) => r.col.name)).toEqual(['c0', 'c7']);
    expect(k.more).toBe(38);
    expect(cardGeom(wide, { columns: 'none', types: false }).h).toBe(CARD.headerH);
  });

  it('anchors rows at their centre, hidden rows at "+N more", else the header', () => {
    const g = cardGeom(wide, { columns: 'all', types: true });
    expect(rowAnchorY(g, 'c0')).toBe(CARD.headerH + CARD.padY + CARD.rowH / 2);
    expect(rowAnchorY(g, 'c3')).toBe(CARD.headerH + CARD.padY + 3 * CARD.rowH + CARD.rowH / 2);
    expect(rowAnchorY(g, 'c30')).toBe(CARD.headerH + CARD.padY + 25 * CARD.rowH + CARD.rowH / 2);
    expect(rowAnchorY(cardGeom(wide, { columns: 'none', types: true }), 'c3')).toBe(CARD.headerH / 2);
    expect(g.w).toBeGreaterThanOrEqual(CARD.minW);
    expect(g.w).toBeLessThanOrEqual(CARD.maxW);
  });

  it('orders cards for Tab in reading order (rows, then left to right)', () => {
    const geom = new Map(['a', 'b', 'c', 'd'].map((k) => [k, { w: 100, h: 100, rows: [], more: 0, moreRow: false }]));
    const order = readingOrder(['a', 'b', 'c', 'd'], { a: [300, 10], b: [0, 0], c: [0, 400], d: [150, 30] }, geom);
    expect(order).toEqual(['b', 'd', 'a', 'c']);
  });
});

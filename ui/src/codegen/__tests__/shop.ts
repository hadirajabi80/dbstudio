// The "shop" fixture for codegen snapshot tests: the intel shop catalogs (one per dialect) plus a few objects
// that exercise identity columns, OUT parameters, REF CURSORs, reserved words and wide type coverage.
import type { CatalogObject, CatalogSnapshot, Dialect } from '../../api/types';
import plsqlShop from '../../intel/__tests__/fixtures/shop-plsql.json';
import sqliteShop from '../../intel/__tests__/fixtures/shop-sqlite.json';
import tsqlShop from '../../intel/__tests__/fixtures/shop-tsql.json';
import { fromCatalogObject, queryObject } from '../fromCatalog';
import type { CgColumn, CgInput, CgObject } from '../model';

/** M2-0: the M1 dialects; PG-C adds pgsql (shop-pgsql.json) and widens these maps to Dialect. */
export type ShopDialect = Exclude<Dialect, 'pgsql'>;

const SNAPSHOTS: Record<ShopDialect, CatalogSnapshot> = {
  tsql: tsqlShop as unknown as CatalogSnapshot,
  plsql: plsqlShop as unknown as CatalogSnapshot,
  sqlite: sqliteShop as unknown as CatalogSnapshot,
};

const EXTRA: Record<ShopDialect, { schema: string; objects: CatalogObject[] }> = {
  tsql: {
    schema: 'dbo',
    objects: [
      {
        t: 'table', n: 'Events', cm: 'Audit trail of things that happened',
        c: [
          ['EventId', 'uniqueidentifier', 0, 1, 0, null],
          ['OccurredAt', 'datetimeoffset(7)', 0, 0, 0, 'When it happened (with offset)'],
          ['Day', 'date', 0, 0, 0, null],
          ['At', 'time(0)', 1, 0, 0, null],
          ['Kind', 'varchar(20)', 0, 0, 0, null],
          ['Payload', 'nvarchar(max)', 1, 0, 0, 'JSON document'],
          ['Snapshot', 'varbinary(max)', 1, 0, 0, null],
          ['Spec', 'xml', 1, 0, 0, null],
          ['Score', 'float', 1, 0, 0, null],
          ['Ratio', 'real', 1, 0, 0, null],
          ['Flags', 'tinyint', 0, 0, 0, null],
          ['Big', 'bigint', 1, 0, 0, null],
          ['Price', 'money', 1, 0, 0, null],
          ['IsActive', 'bit', 0, 0, 0, null],
          ['RowVer', 'rowversion', 0, 0, 0, null],
          ['Location', 'geography', 1, 0, 0, null],
        ],
        pk: ['EventId'],
      },
      {
        t: 'table', n: 'Keywords',
        c: [
          ['Id', 'int', 0, 1, 1, null],
          ['class', 'nvarchar(20)', 0, 0, 0, null],
          ['type', 'int', 1, 0, 0, null],
          ['select', 'bit', 1, 0, 0, null],
          ['Keyword', 'nvarchar(50)', 1, 0, 0, 'Same name as the singular type'],
        ],
        pk: ['Id'],
      },
      {
        t: 'proc', n: 'GetOrderTotals',
        p: [['@CustomerId', 'int', 'in', 0], ['@Since', 'datetime2', 'in', 1], ['@Total', 'decimal(18,2)', 'out', 0], ['@OrderCount', 'int', 'out', 0]],
      },
    ],
  },
  plsql: {
    schema: 'SHOP',
    objects: [
      { t: 'proc', n: 'GET_CUSTOMER_ORDERS', p: [['P_CUSTOMER_ID', 'NUMBER', 'in', 0], ['P_ORDERS', 'SYS_REFCURSOR', 'out', 0]] },
      { t: 'proc', n: 'NEXT_INVOICE_NO', p: [['P_PREFIX', 'VARCHAR2', 'in', 0], ['P_NUMBER', 'VARCHAR2', 'out', 0], ['P_SEQ', 'NUMBER', 'inout', 0]] },
      {
        t: 'package', n: 'BILLING',
        members: [
          { n: 'LIST_OPEN_INVOICES', k: 'proc', ov: 1, p: [['P_CUSTOMER_ID', 'NUMBER', 'in', 0], ['P_RESULT', 'SYS_REFCURSOR', 'out', 0]] },
          { n: 'INVOICE_TOTAL', k: 'func', ov: 1, p: [['', 'NUMBER', 'return', 0], ['P_INVOICE_ID', 'NUMBER', 'in', 0]] },
        ],
      },
      {
        t: 'table', n: 'INVOICES', cm: 'Issued invoices',
        c: [
          ['INVOICE_ID', 'NUMBER(10)', 0, 1, 1, null],
          ['CUSTOMER_ID', 'NUMBER(9)', 0, 0, 0, null],
          ['ISSUED_AT', 'TIMESTAMP(6) WITH TIME ZONE', 0, 0, 0, null],
          ['AMOUNT', 'NUMBER(12,2)', 0, 0, 0, null],
          ['PAID', 'NUMBER(1)', 0, 0, 0, null],
          ['NOTES', 'CLOB', 1, 0, 0, null],
          ['PDF', 'BLOB', 1, 0, 0, null],
          ['DUE_IN', 'INTERVAL DAY(2) TO SECOND(0)', 1, 0, 0, null],
        ],
        pk: ['INVOICE_ID'],
        fk: [{ n: 'FK_INVOICES_CUSTOMERS', cols: ['CUSTOMER_ID'], rs: 'SHOP', rt: 'CUSTOMERS', rcols: ['ID'] }],
      },
    ],
  },
  sqlite: {
    schema: 'main',
    objects: [],
  },
};

const QUERY: Record<ShopDialect, { sql: string; columns: CgColumn[] }> = {
  tsql: {
    sql: 'SELECT c.Id, c.Name, o.Total, o.OrderDate\nFROM dbo.Customers c\nJOIN dbo.Orders o ON o.CustomerId = c.Id\nWHERE c.Id = @customerId AND o.Total > @minTotal\nORDER BY o.OrderDate DESC;',
    columns: [
      { name: 'Id', dbType: 'int', nullable: false, pk: false, identity: false, computed: false, kind: 'int' },
      { name: 'Name', dbType: 'nvarchar(100)', nullable: false, pk: false, identity: false, computed: false, kind: 'string' },
      { name: 'Total', dbType: 'decimal(18,2)', nullable: false, pk: false, identity: false, computed: false, kind: 'decimal' },
      { name: 'OrderDate', dbType: 'datetime2', nullable: true, pk: false, identity: false, computed: false, kind: 'datetime' },
    ],
  },
  plsql: {
    sql: 'SELECT c.ID, c.NAME, o.TOTAL, o.ORDER_DATE\nFROM SHOP.CUSTOMERS c\nJOIN SHOP.ORDERS o ON o.CUSTOMER_ID = c.ID\nWHERE c.ID = :customer_id AND o.TOTAL > :min_total\nORDER BY o.ORDER_DATE DESC',
    columns: [
      { name: 'ID', dbType: 'NUMBER', nullable: false, pk: false, identity: false, computed: false, kind: 'decimal' },
      { name: 'NAME', dbType: 'VARCHAR2(100)', nullable: false, pk: false, identity: false, computed: false, kind: 'string' },
      { name: 'TOTAL', dbType: 'NUMBER(12,2)', nullable: false, pk: false, identity: false, computed: false, kind: 'decimal' },
      { name: 'ORDER_DATE', dbType: 'DATE', nullable: true, pk: false, identity: false, computed: false, kind: 'datetime' },
    ],
  },
  sqlite: {
    sql: 'SELECT c.id, c.name, o.total, o.order_date\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE c.id = ? AND o.total > ?\nORDER BY o.order_date DESC;',
    columns: [
      { name: 'id', dbType: 'INTEGER', nullable: false, pk: false, identity: false, computed: false, kind: 'int' },
      { name: 'name', dbType: 'TEXT', nullable: false, pk: false, identity: false, computed: false, kind: 'string' },
      { name: 'total', dbType: 'REAL', nullable: false, pk: false, identity: false, computed: false, kind: 'float' },
      { name: 'order_date', dbType: 'TEXT', nullable: true, pk: false, identity: false, computed: false, kind: 'string' },
    ],
  },
};

const PARAM_TYPES = { customerId: 'int', minTotal: 'decimal', customer_id: 'int', min_total: 'decimal', p1: 'int', p2: 'float' } as const;

/** Every object of the shop fixture for one dialect (tables, views, routines, packages and one query). */
export function shopInput(dialect: ShopDialect, opts: { query?: boolean } = {}): CgInput {
  const snap = SNAPSHOTS[dialect];
  const objects: CgObject[] = [];
  for (const s of snap.schemas) {
    if (dialect === 'sqlite' && s.name !== 'main') continue;
    if (dialect === 'plsql' && s.name !== 'SHOP') continue;
    for (const o of s.objects) {
      // SQLite: INTEGER PRIMARY KEY is a rowid alias (auto-increment).
      const obj = dialect === 'sqlite' && o.t === 'table' && o.n === 'customers'
        ? { ...o, c: o.c!.map((c) => (c[0] === 'id' ? ([c[0], c[1], c[2], 1, 1, c[5]] as typeof c) : c)), pk: ['id'] }
        : o;
      const cg = fromCatalogObject(obj, s.name);
      if (cg) objects.push(cg);
    }
  }
  const extra = EXTRA[dialect];
  for (const o of extra.objects) {
    const cg = fromCatalogObject(o, extra.schema);
    if (!cg) continue;
    // Server defaults (GET /catalog/object details in the app): left out of generated INSERTs.
    if (cg.kind === 'table' && cg.name === 'Events') cg.columns = cg.columns.map((c) => (c.name === 'OccurredAt' || c.name === 'IsActive' ? { ...c, hasDefault: true } : c));
    objects.push(cg);
  }
  if (opts.query !== false) {
    const q = QUERY[dialect];
    objects.push(queryObject('CustomerOrders', q.sql, dialect, q.columns, PARAM_TYPES));
  }
  return { dialect, objects };
}

export const DIALECTS: ShopDialect[] = ['tsql', 'plsql', 'sqlite'];

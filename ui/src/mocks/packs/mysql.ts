// MySQL + MariaDB mock pack (plan-batch3 WP-MY): provider entries (form spec identical to the engine's MySqlProviderBase),
// the two sample connections (folder "Batch 3") and the MySQL-specific objects of the shop seed
// (engine/tests/docker/seed-mysql.sql / seed-mariadb.sql) on top of the shop tables the mock engine serves every pack.
// No module routes: WP-MY has no /mysql endpoints. Dev-only (mocks are never part of the production bundle).
// `shop` (MockProviderPack.shop) makes the mock engine present the shop as schema `shop` with MySQL column types.
import type { CatalogObject, ConnectionProfile, FormField, ProviderInfo } from '../../api/types';
import { PACK_NOW, type MockProviderPack } from './types';

/** The engine's MySQL / MariaDB connection form (MySqlProviderBase.FormSpec). */
const FIELDS: FormField[] = [
  { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
  { key: 'port', label: 'Port', type: 'number', default: 3306 },
  { key: 'database', label: 'Database', type: 'text', placeholder: 'shop' },
  { key: 'user', label: 'User', type: 'text', required: true },
  { key: 'password', label: 'Password', type: 'password' },
  {
    key: 'sslMode', label: 'SSL mode', type: 'select', default: 'preferred',
    options: [
      { value: 'none', label: 'None' }, { value: 'preferred', label: 'Preferred' }, { value: 'required', label: 'Required' },
      { value: 'verifyca', label: 'Verify CA' }, { value: 'verifyfull', label: 'Verify full' },
    ],
  },
  { key: 'sslCa', label: 'CA certificate', type: 'file' },
  { key: 'allowPublicKeyRetrieval', label: 'Allow public key retrieval', type: 'bool', default: false },
  { key: 'charset', label: 'Character set', type: 'text', default: 'utf8mb4' },
  { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 15 },
  { key: 'compress', label: 'Compress', type: 'bool', default: false },
  { key: 'serverVariables', label: 'Session variables', type: 'text', placeholder: "sql_mode='ANSI_QUOTES',time_zone='+00:00'" },
];

export const mysqlProviders: ProviderInfo[] = [
  { id: 'mysql', displayName: 'MySQL', dialect: 'mysql', kind: 'relational', formSpec: { fields: FIELDS } },
  { id: 'mariadb', displayName: 'MariaDB', dialect: 'mysql', kind: 'relational', formSpec: { fields: FIELDS } },
];

/** The pack's sample connections (folder "Batch 3"). */
export const mysqlConnections: ConnectionProfile[] = [
  { id: 'c_mysql', name: 'MySQL Shop', providerId: 'mysql', color: null, folder: 'Batch 3', readOnly: false,
      props: { host: 'mysql-dev', port: 3306, database: 'shop', user: 'shop' },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
  { id: 'c_mariadb', name: 'MariaDB Shop', providerId: 'mariadb', color: null, folder: 'Batch 3', readOnly: false,
      props: { host: 'mariadb-dev', port: 3306, database: 'shop', user: 'shop' },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
];

/** Routines, the second view, the trigger and the event of the MySQL shop (both servers). */
const SHOP_EXTRAS: CatalogObject[] = [
  {
    t: 'view', n: 'customer_totals', cm: 'Orders and revenue per customer',
    c: [['customer_id', 'int', 0, 0, 0, null], ['name', 'varchar(100)', 0, 0, 0, null], ['orders', 'bigint', 0, 0, 0, null], ['revenue', 'decimal(34,2)', 1, 0, 0, null]],
  },
  { t: 'func', n: 'fn_tax', cm: 'Tax on an amount (default rate)', p: [['amount', 'decimal(12,2)', 'in', 0], ['', 'decimal(12,2)', 'return', 0]] },
  { t: 'proc', n: 'get_customer', p: [['p_id', 'int', 'in', 0]] },
  { t: 'proc', n: 'get_customer_report', cm: 'Two result sets and a warning', p: [['p_id', 'int', 'in', 0]] },
  { t: 'proc', n: 'add_order_line', p: [['p_order', 'int', 'in', 0], ['p_product', 'int', 'in', 0], ['p_qty', 'int', 'in', 0], ['inserted', 'int', 'out', 0]] },
  // events are listed as procedures with the comment "event" (engine MySqlCatalog)
  { t: 'proc', n: 'ev_purge_notes', cm: 'event', p: [] },
  { t: 'trigger', n: 'trg_orders_check', cm: 'on orders' },
];

/** SQLite fixture type → MySQL type. */
function mysqlType(t: string): string {
  const m = /^([A-Z]+)(\(.*\))?$/.exec(t);
  if (!m) return t.toLowerCase();
  switch (m[1]) {
    case 'INTEGER': return 'int';
    case 'TEXT': return 'varchar(255)';
    case 'REAL': return 'double';
    case 'DECIMAL': return `decimal${m[2] ?? '(10,2)'}`;
    case 'BOOLEAN': return 'tinyint(1)';
    default: return m[1].toLowerCase();
  }
}

export const mysqlPack: MockProviderPack = {
  providers: mysqlProviders,
  connections: mysqlConnections,
  shop: {
    mysql: { schema: 'shop', type: mysqlType, serverInfo: { version: '8.4.3', productVersion: '8.4.3' } },
    mariadb: { schema: 'shop', type: mysqlType, serverInfo: { version: '11.4.4-MariaDB', productVersion: '11.4.4' } },
  },
  extraObjects: {
    mysql: SHOP_EXTRAS,
    // MariaDB 10.3+ sequences (seed-mariadb.sql)
    mariadb: [...SHOP_EXTRAS, { t: 'sequence', n: 'order_numbers', cm: null }],
  },
  handlers: () => [],
};

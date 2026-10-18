// Fixture "shop" database for the mock engine (dev:mock and component tests).
import type {
  CatalogColumnTuple, CatalogObject, CellValue, ColumnInfo, ColumnKind, ConnectionProfile, ProviderInfo,
} from '../api/types';

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'sqlserver',
    displayName: 'Microsoft SQL Server',
    dialect: 'tsql',
    kind: 'relational',
    formSpec: {
      fields: [
        { key: 'server', label: 'Server', type: 'text', required: true, placeholder: 'localhost\\SQLEXPRESS or host,1433' },
        { key: 'auth', label: 'Authentication', type: 'select', options: [{ value: 'sql', label: 'SQL Login' }, { value: 'windows', label: 'Windows Authentication' }], default: 'sql' },
        { key: 'user', label: 'User', type: 'text', visibleWhen: { auth: 'sql' } },
        { key: 'password', label: 'Password', type: 'password', visibleWhen: { auth: 'sql' } },
        { key: 'database', label: 'Database', type: 'text', placeholder: 'default database' },
        { key: 'encrypt', label: 'Encrypt', type: 'select', options: [{ value: 'optional', label: 'Optional' }, { value: 'mandatory', label: 'Mandatory' }, { value: 'strict', label: 'Strict' }], default: 'optional' },
        { key: 'trustServerCertificate', label: 'Trust server certificate', type: 'bool', default: true },
        { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 15 },
      ],
    },
  },
  {
    id: 'oracle',
    displayName: 'Oracle Database',
    dialect: 'plsql',
    kind: 'relational',
    formSpec: {
      fields: [
        { key: 'connectionType', label: 'Connection type', type: 'select', options: [{ value: 'basic', label: 'Basic' }, { value: 'tns', label: 'TNS alias' }, { value: 'descriptor', label: 'Connect descriptor' }], default: 'basic' },
        { key: 'host', label: 'Host', type: 'text', required: true, visibleWhen: { connectionType: 'basic' }, placeholder: 'localhost' },
        { key: 'port', label: 'Port', type: 'number', default: 1521, visibleWhen: { connectionType: 'basic' } },
        { key: 'serviceName', label: 'Service name', type: 'text', visibleWhen: { connectionType: 'basic' }, placeholder: 'FREEPDB1' },
        { key: 'tnsAlias', label: 'TNS alias', type: 'text', required: true, visibleWhen: { connectionType: 'tns' } },
        { key: 'descriptor', label: 'Descriptor', type: 'text', required: true, visibleWhen: { connectionType: 'descriptor' } },
        { key: 'user', label: 'User', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'password' },
        { key: 'role', label: 'Role', type: 'select', options: [{ value: 'normal', label: 'Normal' }, { value: 'sysdba', label: 'SYSDBA' }, { value: 'sysoper', label: 'SYSOPER' }], default: 'normal' },
        { key: 'extraSchemas', label: 'Extra schemas', type: 'list', placeholder: 'HR, SALES' },
      ],
    },
  },
  {
    id: 'sqlite',
    displayName: 'SQLite',
    dialect: 'sqlite',
    kind: 'relational',
    formSpec: {
      fields: [
        { key: 'path', label: 'Database file', type: 'file', required: true, fileFilter: '*.db;*.sqlite;*.sqlite3', placeholder: 'C:\\data\\shop.db' },
        { key: 'readOnly', label: 'Open read-only (Mode=ReadOnly)', type: 'bool', default: false },
        { key: 'createIfMissing', label: 'Create the file if it does not exist', type: 'bool', default: false },
      ],
    },
  },
  // ---- M2 (docs/PLAN-M2.md 1.3; specs mirror the engine: PgConnectionStrings, RedisProvider, MongoProvider, KafkaProvider)
  {
    id: 'postgresql',
    displayName: 'PostgreSQL',
    dialect: 'pgsql',
    kind: 'relational',
    formSpec: {
      fields: [
        { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
        { key: 'port', label: 'Port', type: 'number', default: 5432 },
        { key: 'database', label: 'Database', type: 'text', placeholder: 'postgres' },
        { key: 'user', label: 'User', type: 'text', required: true },
        { key: 'password', label: 'Password', type: 'password' },
        { key: 'sslMode', label: 'SSL mode', type: 'select', default: 'prefer', options: [{ value: 'disable', label: 'Disable' }, { value: 'allow', label: 'Allow' }, { value: 'prefer', label: 'Prefer' }, { value: 'require', label: 'Require' }, { value: 'verify-ca', label: 'Verify CA' }, { value: 'verify-full', label: 'Verify full' }] },
        { key: 'trustServerCertificate', label: 'Trust server certificate', type: 'bool', default: false, help: 'Accept self-signed certificates with require.' },
        { key: 'searchPath', label: 'Search path', type: 'text', placeholder: '"$user", public', help: 'Session search_path (leave empty for the server/role default).' },
        { key: 'applicationName', label: 'Application name', type: 'text', default: 'DbStudio' },
        { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 15 },
        { key: 'options', label: 'Server options', type: 'text', placeholder: '-c statement_timeout=0', help: 'Extra -c name=value server options (advanced).' },
      ],
    },
  },
  {
    id: 'redis',
    displayName: 'Redis',
    dialect: null,
    kind: 'keyvalue',
    formSpec: {
      fields: [
        { key: 'mode', label: 'Mode', type: 'select', default: 'standalone', options: [{ value: 'standalone', label: 'Standalone' }, { value: 'cluster', label: 'Cluster' }, { value: 'sentinel', label: 'Sentinel' }] },
        { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost', visibleWhen: { mode: 'standalone' } },
        { key: 'port', label: 'Port', type: 'number', default: 6379, visibleWhen: { mode: 'standalone' } },
        { key: 'nodes', label: 'Cluster nodes', type: 'list', placeholder: 'host1:6379,host2:6379', visibleWhen: { mode: 'cluster' } },
        { key: 'sentinels', label: 'Sentinels', type: 'list', placeholder: 'host1:26379,host2:26379', visibleWhen: { mode: 'sentinel' } },
        { key: 'serviceName', label: 'Service name', type: 'text', default: 'mymaster', visibleWhen: { mode: 'sentinel' } },
        { key: 'user', label: 'User', type: 'text', help: 'ACL user (empty = default user).' },
        { key: 'password', label: 'Password', type: 'password' },
        { key: 'db', label: 'Database', type: 'number', default: 0, help: 'Standalone and sentinel only.' },
        { key: 'tls', label: 'Use TLS', type: 'bool', default: false },
        { key: 'tlsSkipVerify', label: 'Skip certificate verification', type: 'bool', default: false },
        { key: 'keyDelimiter', label: 'Key delimiter', type: 'text', default: ':' },
        { key: 'scanCount', label: 'SCAN count', type: 'number', default: 500 },
        { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 5 },
      ],
    },
  },
  {
    id: 'mongodb',
    displayName: 'MongoDB',
    dialect: null,
    kind: 'document',
    formSpec: {
      fields: [
        { key: 'uri', label: 'Connection string', type: 'text', required: true, placeholder: 'mongodb://localhost:27017 or mongodb+srv://cluster.example.net' },
        { key: 'user', label: 'User', type: 'text', help: 'Merged into the URI only when it has no credentials.' },
        { key: 'password', label: 'Password', type: 'password' },
        { key: 'authSource', label: 'Auth database', type: 'text', placeholder: 'admin' },
        { key: 'authMechanism', label: 'Auth mechanism', type: 'select', default: 'default', options: [{ value: 'default', label: 'Default' }, { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' }, { value: 'SCRAM-SHA-1', label: 'SCRAM-SHA-1' }, { value: 'MONGODB-X509', label: 'X.509' }, { value: 'PLAIN', label: 'PLAIN (LDAP)' }] },
        { key: 'database', label: 'Database', type: 'text', help: 'Default database for the explorer (empty = list all).' },
        { key: 'tls', label: 'Use TLS', type: 'bool', default: false },
        { key: 'tlsCaFile', label: 'CA file', type: 'file', fileFilter: '*.pem;*.crt;*.cer' },
        { key: 'tlsAllowInvalid', label: 'Allow invalid certificates', type: 'bool', default: false },
        { key: 'readPreference', label: 'Read preference', type: 'select', default: 'primary', options: [{ value: 'primary', label: 'Primary' }, { value: 'primaryPreferred', label: 'Primary preferred' }, { value: 'secondary', label: 'Secondary' }, { value: 'secondaryPreferred', label: 'Secondary preferred' }, { value: 'nearest', label: 'Nearest' }] },
        { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 10 },
        { key: 'appName', label: 'App name', type: 'text', default: 'DbStudio' },
      ],
    },
  },
  {
    id: 'kafka',
    displayName: 'Apache Kafka',
    dialect: null,
    kind: 'stream',
    formSpec: {
      fields: [
        { key: 'bootstrapServers', label: 'Bootstrap servers', type: 'text', required: true, placeholder: 'host:9092,host2:9092' },
        { key: 'securityProtocol', label: 'Security protocol', type: 'select', default: 'PLAINTEXT', options: [{ value: 'PLAINTEXT', label: 'PLAINTEXT' }, { value: 'SSL', label: 'SSL' }, { value: 'SASL_PLAINTEXT', label: 'SASL_PLAINTEXT' }, { value: 'SASL_SSL', label: 'SASL_SSL' }] },
        { key: 'saslMechanism', label: 'SASL mechanism', type: 'select', default: 'PLAIN', options: [{ value: 'PLAIN', label: 'PLAIN' }, { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' }, { value: 'SCRAM-SHA-512', label: 'SCRAM-SHA-512' }, { value: 'OAUTHBEARER', label: 'OAUTHBEARER' }], help: 'SASL_PLAINTEXT and SASL_SSL only.' },
        { key: 'user', label: 'SASL user', type: 'text' },
        { key: 'password', label: 'SASL password', type: 'password' },
        { key: 'sslCaLocation', label: 'CA certificate', type: 'file', fileFilter: '*.pem;*.crt;*.cer' },
        { key: 'sslCertLocation', label: 'Client certificate', type: 'file', fileFilter: '*.pem;*.crt;*.cer' },
        { key: 'sslKeyLocation', label: 'Client key', type: 'file', fileFilter: '*.pem;*.key' },
        { key: 'sslKeyPassword', label: 'Client key password', type: 'password' },
        { key: 'schemaRegistryUrl', label: 'Schema Registry URL', type: 'text', placeholder: 'http://localhost:8081' },
        { key: 'schemaRegistryUser', label: 'Schema Registry user', type: 'text' },
        { key: 'schemaRegistrySecret', label: 'Schema Registry secret', type: 'password' },
        { key: 'clientId', label: 'Client id', type: 'text', default: 'DbStudio' },
        { key: 'requestTimeoutMs', label: 'Request timeout (ms)', type: 'number', default: 15000 },
        { key: 'extra', label: 'Extra librdkafka settings', type: 'text', placeholder: 'key=value;key2=value2', help: 'Passed to librdkafka as is (advanced).' },
      ],
    },
  },
];

const now = '2026-10-14T09:00:00Z';

export function initialConnections(): ConnectionProfile[] {
  return [
    {
      id: 'c_shop', name: 'Shop (SQLite)', providerId: 'sqlite', color: '#46a758', folder: null, readOnly: false,
      props: { path: 'C:\\data\\shop.db', readOnly: false }, hasPassword: false, savePassword: false, createdAt: now, lastUsedAt: now,
    },
    {
      id: 'c_prod', name: 'Prod SQL', providerId: 'sqlserver', color: '#e5484d', folder: 'Work', readOnly: false,
      props: { server: 'sql-prod-01', auth: 'sql', user: 'app_reader', database: 'Shop', encrypt: 'mandatory', trustServerCertificate: false, connectTimeout: 15 },
      hasPassword: true, savePassword: true, createdAt: now, lastUsedAt: null,
    },
    {
      id: 'c_ora', name: 'Oracle Shop', providerId: 'oracle', color: '#f76b15', folder: 'Work', readOnly: true,
      props: { connectionType: 'basic', host: 'ora-dev', port: 1521, serviceName: 'FREEPDB1', user: 'SHOP', role: 'normal' },
      hasPassword: true, savePassword: true, createdAt: now, lastUsedAt: null,
    },
    ...m2Connections(),
  ];
}

/** M2 (docs/PLAN-M2.md 1.3): one connection per new provider, in the "M2" folder. */
export function m2Connections(): ConnectionProfile[] {
  return [
    {
      id: 'c_pg', name: 'Postgres Shop', providerId: 'postgresql', color: '#3e63dd', folder: 'M2', readOnly: false,
      props: { host: 'pg-dev', port: 5432, database: 'shop', user: 'shop', sslMode: 'prefer' },
      hasPassword: true, savePassword: true, createdAt: now, lastUsedAt: null,
    },
    {
      id: 'c_redis', name: 'Redis Cache', providerId: 'redis', color: '#e5484d', folder: 'M2', readOnly: false,
      props: { mode: 'standalone', host: 'redis-dev', port: 6379, db: 0, keyDelimiter: ':' },
      hasPassword: false, savePassword: false, createdAt: now, lastUsedAt: null,
    },
    {
      id: 'c_mongo', name: 'Mongo Shop', providerId: 'mongodb', color: '#46a758', folder: 'M2', readOnly: false,
      props: { uri: 'mongodb://mongo-dev:27017', database: 'shop' },
      hasPassword: false, savePassword: false, createdAt: now, lastUsedAt: null,
    },
    {
      id: 'c_kafka', name: 'Kafka Dev', providerId: 'kafka', color: null, folder: 'M2', readOnly: false,
      props: { bootstrapServers: 'kafka-dev:9092', securityProtocol: 'PLAINTEXT' },
      hasPassword: false, savePassword: false, createdAt: now, lastUsedAt: null,
    },
  ];
}

// ---------- deterministic data ----------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureColumn {
  name: string;
  type: string;
  kind: ColumnKind;
  nullable: boolean;
  pk?: boolean;
  identity?: boolean;
  fk?: { table: string; column: string };
  comment?: string;
}

export interface FixtureTable {
  name: string;
  kind: 'table' | 'view';
  columns: FixtureColumn[];
  comment?: string;
  rowCount: number;
  gen: (i: number, rnd: () => number) => CellValue[];
  /** Stored DDL. */
  ddl: string;
}

const FIRST = ['Ada', 'Grace', 'Linus', 'Ken', 'Barbara', 'Edsger', 'Donald', 'Margaret', 'Alan', 'Tim', 'Frances', 'John', 'Sophie', 'Niklaus', 'Radia', 'Anders', 'Bjarne', 'Guido', 'Hedy', 'Katherine'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Thompson', 'Liskov', 'Dijkstra', 'Knuth', 'Hamilton', 'Turing', 'Berners-Lee', 'Allen', 'Backus', 'Wilson', 'Wirth', 'Perlman', 'Hejlsberg', 'Stroustrup', 'van Rossum', 'Lamarr', 'Johnson'];
const COUNTRIES = [
  ['Netherlands', 'NL'], ['Germany', 'DE'], ['France', 'FR'], ['United States', 'US'], ['Canada', 'CA'], ['Brazil', 'BR'], ['Japan', 'JP'],
  ['India', 'IN'], ['Iran', 'IR'], ['Australia', 'AU'], ['Spain', 'ES'], ['Italy', 'IT'], ['Sweden', 'SE'], ['Norway', 'NO'], ['Kenya', 'KE'],
  ['Mexico', 'MX'], ['Poland', 'PL'], ['Ireland', 'IE'], ['Portugal', 'PT'], ['Singapore', 'SG'],
];
const CATEGORIES = ['Keyboards', 'Monitors', 'Cables', 'Storage', 'Audio', 'Laptops', 'Chairs', 'Lamps'];
const PRODUCTS = ['Mechanical Keyboard', 'Ultrawide Monitor', 'USB-C Cable', 'NVMe SSD 2TB', 'Studio Headphones', '14" Laptop', 'Ergonomic Chair', 'Desk Lamp', 'Webcam 4K', 'Trackball'];
const STATUSES = ['new', 'paid', 'shipped', 'delivered', 'cancelled'];

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}
function isoDate(rnd: () => number, year = 2025): string {
  const m = 1 + Math.floor(rnd() * 12);
  const d = 1 + Math.floor(rnd() * 28);
  return `${year}-${pad(m)}-${pad(d)}T${pad(Math.floor(rnd() * 24))}:${pad(Math.floor(rnd() * 60))}:${pad(Math.floor(rnd() * 60))}.${pad(Math.floor(rnd() * 1000), 3)}0000`;
}

const LONG_NOTE = `Customer asked for a detailed delivery log.\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(700)}`;

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

export const SHOP_TABLES: FixtureTable[] = [
  {
    name: 'countries', kind: 'table', rowCount: COUNTRIES.length, comment: 'ISO countries',
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'int', nullable: false, pk: true, identity: true },
      { name: 'name', type: 'TEXT', kind: 'string', nullable: false },
      { name: 'iso_code', type: 'TEXT', kind: 'string', nullable: false },
    ],
    gen: (i) => [i + 1, COUNTRIES[i][0], COUNTRIES[i][1]],
    ddl: 'CREATE TABLE countries (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  iso_code TEXT NOT NULL UNIQUE\n);',
  },
  {
    name: 'customers', kind: 'table', rowCount: 500, comment: 'People who buy things',
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'int', nullable: false, pk: true, identity: true },
      { name: 'name', type: 'TEXT', kind: 'string', nullable: false, comment: 'Display name' },
      { name: 'email', type: 'TEXT', kind: 'string', nullable: true },
      { name: 'country_id', type: 'INTEGER', kind: 'int', nullable: true, fk: { table: 'countries', column: 'id' } },
      { name: 'is_active', type: 'BOOLEAN', kind: 'bool', nullable: false },
      { name: 'created_at', type: 'DATETIME', kind: 'datetime', nullable: false },
      { name: 'profile', type: 'JSON', kind: 'json', nullable: true },
      { name: 'notes', type: 'TEXT', kind: 'string', nullable: true },
    ],
    gen: (i, rnd) => {
      const f = FIRST[Math.floor(rnd() * FIRST.length)];
      const l = LAST[Math.floor(rnd() * LAST.length)];
      const name = `${f} ${l}`;
      const email = rnd() < 0.08 ? null : `${f}.${l}`.toLowerCase().replace(/[^a-z.]/g, '') + `${i}@example.com`;
      const profile = rnd() < 0.3 ? null : JSON.stringify({ tier: ['bronze', 'silver', 'gold'][i % 3], newsletter: rnd() < 0.5, tags: ['vip', 'b2b', 'early'].slice(0, i % 4) });
      let notes: CellValue = rnd() < 0.6 ? null : rnd() < 0.5 ? 'Prefers e-mail\nCall after 5pm' : 'Regular';
      if (i === 6) notes = { $trunc: LONG_NOTE.slice(0, 32768), len: LONG_NOTE.length };
      return [i + 1, name, email, rnd() < 0.05 ? null : 1 + Math.floor(rnd() * COUNTRIES.length), rnd() < 0.85, isoDate(rnd, 2024), profile, notes];
    },
    ddl: 'CREATE TABLE customers (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  email TEXT,\n  country_id INTEGER REFERENCES countries(id),\n  is_active BOOLEAN NOT NULL DEFAULT 1,\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  profile JSON,\n  notes TEXT\n);',
  },
  {
    name: 'products', kind: 'table', rowCount: 120,
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'int', nullable: false, pk: true, identity: true },
      { name: 'name', type: 'TEXT', kind: 'string', nullable: false },
      { name: 'category', type: 'TEXT', kind: 'string', nullable: false },
      { name: 'price', type: 'DECIMAL(10,2)', kind: 'decimal', nullable: false },
      { name: 'stock', type: 'INTEGER', kind: 'int', nullable: false },
      { name: 'spec', type: 'XML', kind: 'xml', nullable: true },
      { name: 'thumbnail', type: 'BLOB', kind: 'binary', nullable: true },
    ],
    gen: (i, rnd) => [
      i + 1,
      `${PRODUCTS[i % PRODUCTS.length]} ${['Pro', 'Lite', 'Max', 'Mini', 'S'][i % 5]}`,
      CATEGORIES[i % CATEGORIES.length],
      (5 + rnd() * 1500).toFixed(2),
      Math.floor(rnd() * 400),
      rnd() < 0.5 ? null : `<spec><weight unit="g">${Math.floor(rnd() * 3000)}</weight><color>${['black', 'white', 'silver'][i % 3]}</color></spec>`,
      rnd() < 0.4 ? null : { $bin: b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, i & 255, 1, 2, 3, 4, 5, 6, 7]), len: 2048 + i * 13 },
    ],
    ddl: 'CREATE TABLE products (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  category TEXT NOT NULL,\n  price DECIMAL(10,2) NOT NULL,\n  stock INTEGER NOT NULL DEFAULT 0,\n  spec XML,\n  thumbnail BLOB\n);',
  },
  {
    name: 'orders', kind: 'table', rowCount: 5000,
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'int', nullable: false, pk: true, identity: true },
      { name: 'customer_id', type: 'INTEGER', kind: 'int', nullable: false, fk: { table: 'customers', column: 'id' } },
      { name: 'order_date', type: 'DATETIME', kind: 'datetime', nullable: false },
      { name: 'status', type: 'TEXT', kind: 'string', nullable: false },
      { name: 'total', type: 'DECIMAL(12,2)', kind: 'decimal', nullable: false },
    ],
    gen: (i, rnd) => [i + 1, 1 + Math.floor(rnd() * 500), isoDate(rnd, 2025), STATUSES[Math.floor(rnd() * STATUSES.length)], (10 + rnd() * 3000).toFixed(2)],
    ddl: 'CREATE TABLE orders (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  customer_id INTEGER NOT NULL REFERENCES customers(id),\n  order_date DATETIME NOT NULL,\n  status TEXT NOT NULL,\n  total DECIMAL(12,2) NOT NULL\n);',
  },
  {
    name: 'order_lines', kind: 'table', rowCount: 12000,
    columns: [
      { name: 'order_id', type: 'INTEGER', kind: 'int', nullable: false, pk: true, fk: { table: 'orders', column: 'id' } },
      { name: 'line_no', type: 'INTEGER', kind: 'int', nullable: false, pk: true },
      { name: 'product_id', type: 'INTEGER', kind: 'int', nullable: false, fk: { table: 'products', column: 'id' } },
      { name: 'qty', type: 'INTEGER', kind: 'int', nullable: false },
      { name: 'unit_price', type: 'DECIMAL(10,2)', kind: 'decimal', nullable: false },
    ],
    gen: (i, rnd) => [1 + Math.floor(i / 2.4), (i % 3) + 1, 1 + Math.floor(rnd() * 120), 1 + Math.floor(rnd() * 5), (5 + rnd() * 900).toFixed(2)],
    ddl: 'CREATE TABLE order_lines (\n  order_id INTEGER NOT NULL REFERENCES orders(id),\n  line_no INTEGER NOT NULL,\n  product_id INTEGER NOT NULL REFERENCES products(id),\n  qty INTEGER NOT NULL,\n  unit_price DECIMAL(10,2) NOT NULL,\n  PRIMARY KEY (order_id, line_no)\n);',
  },
  {
    name: 'events', kind: 'table', rowCount: 150_000, comment: 'Click stream (large table for grid performance)',
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'int', nullable: false, pk: true },
      { name: 'ts', type: 'DATETIME', kind: 'datetime', nullable: false },
      { name: 'customer_id', type: 'INTEGER', kind: 'int', nullable: true, fk: { table: 'customers', column: 'id' } },
      { name: 'kind', type: 'TEXT', kind: 'string', nullable: false },
      { name: 'duration_ms', type: 'REAL', kind: 'float', nullable: true },
      { name: 'session', type: 'TEXT', kind: 'guid', nullable: false },
    ],
    gen: (i, rnd) => [
      i + 1, isoDate(rnd, 2026), rnd() < 0.2 ? null : 1 + Math.floor(rnd() * 500), ['view', 'click', 'add_to_cart', 'checkout', 'search'][Math.floor(rnd() * 5)],
      rnd() < 0.1 ? null : Math.round(rnd() * 500000) / 100, `${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0')}-4a1b-9c2d-${pad(i % 10000, 4)}-${Math.floor(rnd() * 0xffffff).toString(16).padStart(12, '0')}`,
    ],
    ddl: 'CREATE TABLE events (\n  id INTEGER PRIMARY KEY,\n  ts DATETIME NOT NULL,\n  customer_id INTEGER REFERENCES customers(id),\n  kind TEXT NOT NULL,\n  duration_ms REAL,\n  session TEXT NOT NULL\n);',
  },
  {
    name: 'v_customer_orders', kind: 'view', rowCount: 500,
    columns: [
      { name: 'customer_id', type: 'INTEGER', kind: 'int', nullable: false },
      { name: 'name', type: 'TEXT', kind: 'string', nullable: false },
      { name: 'orders', type: 'INTEGER', kind: 'int', nullable: false },
      { name: 'revenue', type: 'DECIMAL', kind: 'decimal', nullable: true },
    ],
    gen: (i, rnd) => [i + 1, `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, Math.floor(rnd() * 25), rnd() < 0.1 ? null : (rnd() * 25000).toFixed(2)],
    ddl: 'CREATE VIEW v_customer_orders AS\nSELECT c.id AS customer_id, c.name, COUNT(o.id) AS orders, SUM(o.total) AS revenue\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.id, c.name;',
  },
];

export function generateRows(t: FixtureTable): CellValue[][] {
  const rnd = mulberry32(t.name.length * 7919 + t.rowCount);
  const out: CellValue[][] = new Array(t.rowCount);
  for (let i = 0; i < t.rowCount; i++) out[i] = t.gen(i, rnd);
  return out;
}

export function columnInfos(t: FixtureTable, schema: string | null): ColumnInfo[] {
  return t.columns.map((c, i) => ({
    name: c.name, ordinal: i, dbType: c.type, kind: c.kind, nullable: c.nullable, size: null, precision: null, scale: null,
    table: t.kind === 'table' ? t.name : null, schema, isKey: !!c.pk,
  }));
}

export function catalogObject(t: FixtureTable, schema: string, upper = false): CatalogObject {
  const n = (s: string) => (upper ? s.toUpperCase() : s);
  const cols: CatalogColumnTuple[] = t.columns.map((c) => [n(c.name), c.type, c.nullable ? 1 : 0, c.pk ? 1 : 0, c.identity ? 1 : 0, c.comment ?? null]);
  const fks = t.columns.filter((c) => c.fk).map((c) => ({
    n: n(`fk_${t.name}_${c.fk!.table}`), cols: [n(c.name)], rs: schema, rt: n(c.fk!.table), rcols: [n(c.fk!.column)],
  }));
  return {
    t: t.kind, n: n(t.name), cm: t.comment ?? null, c: cols, pk: t.columns.filter((c) => c.pk).map((c) => n(c.name)), fk: fks.length ? fks : undefined,
  };
}

export const EXTRA_OBJECTS: Record<'sqlite' | 'sqlserver' | 'oracle', CatalogObject[]> = {
  sqlite: [{ t: 'trigger', n: 'trg_orders_audit', cm: null }],
  sqlserver: [
    { t: 'proc', n: 'GetCustomer', p: [['@Id', 'int', 'in', 0]] },
    { t: 'proc', n: 'MonthlyReport', p: [['@Year', 'int', 'in', 0], ['@Month', 'int', 'in', 1]] },
    { t: 'func', n: 'fnTax', p: [['@amount', 'decimal(12,2)', 'in', 0], ['', 'decimal(12,2)', 'return', 0]] },
    { t: 'synonym', n: 'Cust', target: { s: 'dbo', n: 'customers', t: 'table' } },
    { t: 'sequence', n: 'InvoiceNumbers' },
  ],
  oracle: [
    { t: 'package', n: 'ORDER_API', members: [{ n: 'CREATE_ORDER', k: 'proc', ov: 1, p: [['P_CUST', 'NUMBER', 'in', 0], ['P_TOTAL', 'NUMBER', 'in', 0]] }, { n: 'GET_TOTAL', k: 'func', ov: 1, p: [['', 'NUMBER', 'return', 0], ['P_ID', 'NUMBER', 'in', 0]] }] },
    { t: 'sequence', n: 'ORDERS_SEQ' },
    { t: 'synonym', n: 'CUST', target: { s: 'SHOP', n: 'CUSTOMERS', t: 'table' } },
    { t: 'proc', n: 'RECALC_STOCK', p: [], st: 'INVALID' },
  ],
};

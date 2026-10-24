// Cassandra / ScyllaDB mock pack (plan-batch3 WP-CS): provider entry, sample connection, catalog extras and the
// `/cassandra/...` module routes (api/m3/cassandra.ts) for `npm run dev:mock` and the component tests.
//
// - The provider entry mirrors the engine's form spec (engine/src/DbStudio.Providers.Cassandra/CqlConnectionSettings.cs).
// - The catalog is the mock engine's SQLite shop plus the Cassandra-only objects of the docker seed
//   (engine/tests/docker/seed-cassandra.cql): query tables, the counter table, the MV, the UDT and the UDF.
// - Session settings are stateful per session id. Statements of a Cassandra session go through a hook on the mock
//   engine's interpreter (`engine.interpret`, the extension point mocks/m15/grid.ts overrides too): the cqlsh shell
//   commands (CONSISTENCY, SERIAL CONSISTENCY, TRACING, PAGING, SHOW VERSION|HOST|SESSION, DESCRIBE) answer with an
//   info message or a result set and change the settings, `USE ks` updates the keyspace, and every other statement
//   run with tracing on gets a trace (events across the coordinator and 1-3 replicas), returned as an extra result set
//   plus a "Tracing session: <id>" message. The first fetch of a new trace answers "incomplete" (durationMicros null,
//   the first events only), like the coordinator still writing system_traces; the next fetch is complete.
// - The cluster is two datacenters (3 + 2 nodes, one down). `cassandraMockState(engine).releaseVersion = '3.11.17'`
//   makes `/clients` answer 400 NOT_SUPPORTED (system_views needs 4.0+).
import { http, HttpResponse, type RequestHandler } from 'msw';
import type { CatalogColumnTuple, CatalogObject, CellValue, ColumnInfo, ConnectionProfile, FormField, ProviderInfo } from '../../api/types';
import {
  CQL_CONSISTENCY_LEVELS, type CqlClientConnection, type CqlClusterInfo, type CqlColumnDef, type CqlConsistency, type CqlIndexDef, type CqlNode,
  type CqlSerialConsistency, type CqlSessionSettings, type CqlTableInfo, type CqlTrace, type CqlTraceEvent, type CqlTraceSummary,
} from '../../api/types.cassandra';
import type { MockEngine } from '../engine';
import { M2_PREFIX, type M2MockContext } from '../m2';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"). */
export const cassandraConnections: ConnectionProfile[] = [
  { id: 'c_cassandra', name: 'Cassandra Shop', providerId: 'cassandra', color: null, folder: 'Batch 3', readOnly: false,
      props: { contactPoints: 'cassandra-dev', port: 9042, localDc: 'datacenter1', keyspace: 'shop' },
      hasPassword: false, savePassword: false, createdAt: PACK_NOW, lastUsedAt: null },
];

// ---------------------------------------------------------------- provider (CqlConnectionSettings.FormSpec)

const opt = (v: string) => ({ value: v, label: v });
const SSL_ON = { ssl: 'true' };

export const CASSANDRA_FORM_FIELDS: FormField[] = [
  { key: 'contactPoints', label: 'Contact points', type: 'text', required: true, placeholder: 'localhost, 10.0.0.2',
    help: 'Hosts or IP addresses of one or more nodes, separated by commas (host:port is accepted).', visibleWhen: null },
  { key: 'port', label: 'Port', type: 'number', default: 9042 },
  { key: 'localDc', label: 'Local datacenter', type: 'text', placeholder: 'datacenter1',
    help: "Queries go to this datacenter's nodes first. Empty: the datacenter of the first contact point." },
  { key: 'keyspace', label: 'Keyspace', type: 'text', placeholder: 'shop', help: 'Keyspace a new console starts in (USE).' },
  { key: 'user', label: 'User', type: 'text', help: 'Empty for clusters without authentication.' },
  { key: 'password', label: 'Password', type: 'password' },
  { key: 'ssl', label: 'Use SSL/TLS', type: 'bool', default: false },
  { key: 'sslSkipVerify', label: 'Skip certificate verification', type: 'bool', default: false, visibleWhen: SSL_ON, help: 'Accept self-signed certificates.' },
  { key: 'caFile', label: 'CA certificate', type: 'file', visibleWhen: SSL_ON, fileFilter: 'Certificates|*.pem;*.crt;*.cer', help: 'Trust this certificate authority (PEM).' },
  { key: 'consistency', label: 'Consistency', type: 'select', default: 'LOCAL_QUORUM',
    options: ['ONE', 'TWO', 'THREE', 'QUORUM', 'ALL', 'LOCAL_ONE', 'LOCAL_QUORUM', 'EACH_QUORUM', 'ANY'].map(opt),
    help: 'Default consistency level of the consoles (CONSISTENCY in cqlsh).' },
  { key: 'serialConsistency', label: 'Serial consistency', type: 'select', default: 'SERIAL', options: [opt('SERIAL'), opt('LOCAL_SERIAL')],
    help: 'Consistency of the Paxos phase of lightweight transactions (IF …).' },
  { key: 'pageSize', label: 'Page size', type: 'number', default: 1000, help: 'Rows fetched per round trip (PAGING in cqlsh).' },
  { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 10 },
  { key: 'requestTimeout', label: 'Request timeout (s)', type: 'number', default: 30,
    help: 'Client-side timeout of one request (the server has its own read/write timeouts).' },
  { key: 'cloudSecureBundle', label: 'Secure connect bundle', type: 'file', fileFilter: 'Secure connect bundle|*.zip',
    help: 'DataStax Astra: the bundle replaces contact points, port and SSL.' },
  { key: 'showSystemKeyspaces', label: 'Show system keyspaces', type: 'bool', default: false,
    help: 'List system, system_schema, system_traces … in the explorer.' },
];

export const CASSANDRA_PROVIDER: ProviderInfo = {
  id: 'cassandra', displayName: 'Cassandra', dialect: 'cql', kind: 'relational', formSpec: { fields: CASSANDRA_FORM_FIELDS },
};

// ---------------------------------------------------------------- schema model (seed-cassandra.cql)

type Kind = CqlColumnDef['kind'];
interface ModelColumn { name: string; type: string; kind: Kind; order?: 'asc' | 'desc' }
interface ModelTable {
  name: string;
  type: 'table' | 'mview';
  comment: string;
  columns: ModelColumn[];
  /** Options that differ from DEFAULT_OPTIONS (CQL literals). */
  options?: Record<string, string>;
  indexes?: CqlIndexDef[];
  baseTable?: string;
  whereClause?: string;
  partitions: number | null;
  meanBytes: number | null;
}

const pk = (name: string, type: string): ModelColumn => ({ name, type, kind: 'partition_key' });
const ck = (name: string, type: string, order: 'asc' | 'desc' = 'asc'): ModelColumn => ({ name, type, kind: 'clustering', order });
const col = (name: string, type: string): ModelColumn => ({ name, type, kind: 'regular' });
const stat = (name: string, type: string): ModelColumn => ({ name, type, kind: 'static' });

const SAI = 'org.apache.cassandra.index.sai.StorageAttachedIndex';

const TABLES: ModelTable[] = [
  { name: 'countries', type: 'table', comment: 'Countries (reference data)', partitions: 3, meanBytes: 96,
    columns: [pk('id', 'int'), col('code', 'text'), col('name', 'text'), col('local_name', 'text')] },
  { name: 'customers', type: 'table', comment: 'Customers by id', partitions: 5, meanBytes: 612,
    columns: [pk('id', 'int'), col('name', 'text'), col('email', 'text'), col('country_id', 'int'), col('country', 'text'),
      col('address', 'frozen<address>'), col('tags', 'set<text>'), col('phones', 'list<text>'), col('preferences', 'map<text, text>'),
      col('created_at', 'timestamp'), col('ext_id', 'uuid'), col('note', 'text')],
    indexes: [{ name: 'customers_email_idx', kind: 'CUSTOM', target: 'email', className: SAI }] },
  { name: 'products', type: 'table', comment: 'Product catalogue', partitions: 4, meanBytes: 388,
    columns: [pk('id', 'int'), col('sku', 'text'), col('name', 'text'), col('category', 'text'), col('price', 'decimal'), col('stock', 'int'),
      col('discontinued', 'boolean'), col('attributes', 'map<text, text>')] },
  { name: 'orders', type: 'table', comment: 'Orders by id', partitions: 6, meanBytes: 474,
    columns: [pk('id', 'int'), col('customer_id', 'int'), col('customer_name', 'text'), col('order_date', 'timestamp'), col('status', 'text'),
      col('total', 'decimal'), col('shipping_address', 'frozen<address>'), col('note', 'text')] },
  { name: 'orders_by_customer', type: 'table', comment: 'Query table: the orders of a customer, newest first', partitions: 4, meanBytes: 236,
    columns: [pk('customer_id', 'int'), ck('order_date', 'timestamp', 'desc'), ck('order_id', 'int'), col('status', 'text'), col('total', 'decimal')] },
  { name: 'order_lines', type: 'table', comment: 'The lines of an order (one partition per order)', partitions: 5, meanBytes: 182,
    columns: [pk('order_id', 'int'), ck('product_id', 'int'), col('product_name', 'text'), col('qty', 'int'), col('unit_price', 'decimal')] },
  { name: 'product_views', type: 'table', comment: 'Counter table: product page views', partitions: null, meanBytes: null,
    columns: [pk('product_id', 'int'), col('views', 'counter')] },
  { name: 'events_by_day', type: 'table', comment: 'Customer activity per day (composite partition key, 90-day TTL)', partitions: 2, meanBytes: 341,
    columns: [pk('customer_id', 'int'), pk('day', 'date'), ck('event_time', 'timeuuid', 'desc'), col('kind', 'text'), col('payload', 'text')],
    options: { default_time_to_live: '7776000' } },
  // the mock engine's SQLite shop also lists `events` (the large click stream): modelled as a time-bucketed table
  { name: 'events', type: 'table', comment: 'Click stream by day (large table)', partitions: 365, meanBytes: 2_621_440,
    columns: [pk('day', 'date'), ck('ts', 'timestamp', 'desc'), ck('id', 'bigint'), stat('day_note', 'text'), col('customer_id', 'int'),
      col('kind', 'text'), col('url', 'text'), col('payload', 'text')],
    options: { compaction: "{'class': 'org.apache.cassandra.db.compaction.TimeWindowCompactionStrategy', 'compaction_window_size': '1', 'compaction_window_unit': 'DAYS'}" } },
  { name: 'orders_by_status', type: 'mview', comment: 'Orders by status (materialized view)', baseTable: 'orders',
    whereClause: 'status IS NOT NULL AND id IS NOT NULL', partitions: 5, meanBytes: 198,
    columns: [pk('status', 'text'), ck('id', 'int'), col('customer_id', 'int'), col('order_date', 'timestamp'), col('total', 'decimal')] },
];

const DEFAULT_OPTIONS: Record<string, string> = {
  additional_write_policy: "'99p'",
  bloom_filter_fp_chance: '0.01',
  caching: "{'keys': 'ALL', 'rows_per_partition': 'NONE'}",
  cdc: 'false',
  compaction: "{'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}",
  compression: "{'chunk_length_in_kb': '16', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}",
  crc_check_chance: '1.0',
  default_time_to_live: '0',
  gc_grace_seconds: '864000',
  max_index_interval: '2048',
  memtable_flush_period_in_ms: '0',
  min_index_interval: '128',
  read_repair: "'BLOCKING'",
  speculative_retry: "'99p'",
};

const cqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function primaryKeyText(t: ModelTable): string {
  const part = t.columns.filter((c) => c.kind === 'partition_key').map((c) => c.name);
  const clus = t.columns.filter((c) => c.kind === 'clustering').map((c) => c.name);
  const head = part.length > 1 ? `(${part.join(', ')})` : part[0];
  return `PRIMARY KEY (${[head, ...clus].join(', ')})`;
}

function optionsOf(t: ModelTable): Record<string, string> {
  const o: Record<string, string> = { ...DEFAULT_OPTIONS, comment: cqlString(t.comment), ...(t.options ?? {}) };
  if (t.type === 'mview') delete o.cdc;
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function ddlOf(ks: string, t: ModelTable): string {
  const clus = t.columns.filter((c) => c.kind === 'clustering');
  const withParts = [
    ...(clus.length ? [`CLUSTERING ORDER BY (${clus.map((c) => `${c.name} ${(c.order ?? 'asc').toUpperCase()}`).join(', ')})`] : []),
    ...Object.entries(optionsOf(t)).map(([k, v]) => `${k} = ${v}`),
  ];
  const withText = `WITH ${withParts.join('\n    AND ')}`;
  if (t.type === 'mview') {
    return `CREATE MATERIALIZED VIEW ${ks}.${t.name} AS\n    SELECT ${t.columns.map((c) => c.name).join(', ')}\n    FROM ${ks}.${t.baseTable}\n`
      + `    WHERE ${t.whereClause}\n    ${primaryKeyText(t)}\n ${withText};`;
  }
  const part = t.columns.filter((c) => c.kind === 'partition_key');
  const inline = part.length === 1 && clus.length === 0;
  const lines = t.columns.map((c) => `    ${c.name} ${c.type}${c.kind === 'static' ? ' static' : ''}${inline && c.kind === 'partition_key' ? ' PRIMARY KEY' : ''}`);
  if (!inline) lines.push(`    ${primaryKeyText(t)}`);
  let ddl = `CREATE TABLE ${ks}.${t.name} (\n${lines.join(',\n')}\n) ${withText};`;
  for (const ix of t.indexes ?? []) {
    ddl += ix.kind === 'CUSTOM'
      ? `\n\nCREATE CUSTOM INDEX ${ix.name} ON ${ks}.${t.name} (${ix.target}) USING '${ix.className?.split('.').pop() ?? ix.className}';`
      : `\n\nCREATE INDEX ${ix.name} ON ${ks}.${t.name} (${ix.target});`;
  }
  return ddl;
}

export function cassandraTableInfo(ks: string, name: string): CqlTableInfo | null {
  const t = TABLES.find((x) => x.name === name.toLowerCase());
  if (!t) return null;
  const pos = new Map<Kind, number>();
  const columns: CqlColumnDef[] = t.columns.map((c) => {
    const keyed = c.kind === 'partition_key' || c.kind === 'clustering';
    const p = keyed ? (pos.get(c.kind) ?? 0) : -1;
    if (keyed) pos.set(c.kind, p + 1);
    return { name: c.name, type: c.type, kind: c.kind, position: p, order: c.kind === 'clustering' ? c.order ?? 'asc' : null };
  });
  return {
    keyspace: ks, name: t.name, type: t.type, baseTable: t.baseTable ?? null, whereClause: t.whereClause ?? null, columns,
    partitionKey: t.columns.filter((c) => c.kind === 'partition_key').map((c) => c.name),
    clustering: t.columns.filter((c) => c.kind === 'clustering').map((c) => ({ name: c.name, order: c.order ?? 'asc' })),
    primaryKey: primaryKeyText(t), options: optionsOf(t), isCounter: t.columns.some((c) => c.type === 'counter'),
    indexes: t.indexes ?? [], views: TABLES.filter((v) => v.type === 'mview' && v.baseTable === t.name).map((v) => v.name),
    estimatedPartitions: t.partitions, meanPartitionSizeBytes: t.meanBytes, ddl: ddlOf(ks, t),
  };
}

const tuple = (c: ModelColumn): CatalogColumnTuple => [c.name, c.type, c.kind === 'partition_key' || c.kind === 'clustering' ? 0 : 1, c.kind === 'partition_key' || c.kind === 'clustering' ? 1 : 0, 0, c.kind === 'static' ? 'static' : null];
const catalogTable = (name: string): CatalogObject => {
  const t = TABLES.find((x) => x.name === name)!;
  return {
    t: t.type, n: t.name, cm: t.comment, c: t.columns.map(tuple),
    ...(t.type === 'table' ? { pk: t.columns.filter((c) => c.kind === 'partition_key' || c.kind === 'clustering').map((c) => c.name) } : {}),
  };
};

/** Cassandra-only objects of the shop keyspace (the mock engine adds them to the SQLite shop tables). */
export const CASSANDRA_EXTRA_OBJECTS: CatalogObject[] = [
  catalogTable('orders_by_customer'),
  catalogTable('product_views'),
  catalogTable('events_by_day'),
  catalogTable('orders_by_status'),
  { t: 'type', n: 'address', cm: null, c: [['street', 'text', 1, 0, 0, null], ['city', 'text', 1, 0, 0, null], ['postal_code', 'text', 1, 0, 0, null], ['country', 'text', 1, 0, 0, null]] },
  { t: 'func', n: 'line_total', cm: 'RETURNS NULL ON NULL INPUT · LANGUAGE java', p: [['qty', 'int', 'in', 0], ['unit_price', 'decimal', 'in', 0], ['', 'decimal', 'return', 0]] },
];

// ---------------------------------------------------------------- cluster

const SCHEMA_VERSION = '6e4f2a1c-9b3d-3c8e-a7f5-2d1b0c9e8f71';
const NODES: Omit<CqlNode, 'releaseVersion'>[] = [
  { address: '10.0.1.11', dataCenter: 'datacenter1', rack: 'rack1', hostId: '2f6a1c8e-4b7d-4e3a-9c2f-1a8b7c6d5e01', isUp: true, isLocal: true, tokens: 16, schemaVersion: SCHEMA_VERSION },
  { address: '10.0.1.12', dataCenter: 'datacenter1', rack: 'rack2', hostId: '8c3d5e7f-1a2b-4c9d-8e6f-0b1c2d3e4f02', isUp: true, isLocal: false, tokens: 16, schemaVersion: SCHEMA_VERSION },
  { address: '10.0.1.13', dataCenter: 'datacenter1', rack: 'rack3', hostId: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f03', isUp: true, isLocal: false, tokens: 16, schemaVersion: SCHEMA_VERSION },
  { address: '10.0.2.21', dataCenter: 'datacenter2', rack: 'rack1', hostId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c04', isUp: true, isLocal: false, tokens: 16, schemaVersion: SCHEMA_VERSION },
  { address: '10.0.2.22', dataCenter: 'datacenter2', rack: 'rack2', hostId: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a05', isUp: false, isLocal: false, tokens: 16, schemaVersion: null },
];

function clusterInfo(releaseVersion: string): CqlClusterInfo {
  const nodes: CqlNode[] = NODES.map((n) => ({ ...n, releaseVersion }));
  const dcs = [...new Set(nodes.map((n) => n.dataCenter ?? ''))];
  const major = Number.parseInt(releaseVersion, 10);
  return {
    clusterName: 'Shop Cluster', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner',
    cqlVersion: major >= 5 ? '3.4.7' : major >= 4 ? '3.4.5' : '3.4.4', releaseVersion, protocolVersion: major >= 4 ? 5 : 4, product: 'cassandra',
    dataCenters: dcs.map((name) => {
      const of = nodes.filter((n) => n.dataCenter === name);
      return { name, nodes: of.length, up: of.filter((n) => n.isUp).length, racks: [...new Set(of.map((n) => n.rack ?? ''))].sort() };
    }),
    nodes,
    schemaInAgreement: new Set(nodes.filter((n) => n.isUp).map((n) => n.schemaVersion)).size <= 1,
  };
}

const CLIENTS: CqlClientConnection[] = [
  { address: '10.0.0.5', port: 51234, hostname: 'rowlit-desktop', username: 'anonymous', connectionStage: 'ready', protocolVersion: 5,
    driverName: 'DataStax C# Driver for Apache Cassandra', driverVersion: '3.22.1.0', requestCount: 1287, sslEnabled: false, keyspace: 'shop' },
  { address: '10.0.0.5', port: 51236, hostname: 'rowlit-desktop', username: 'anonymous', connectionStage: 'ready', protocolVersion: 5,
    driverName: 'DataStax C# Driver for Apache Cassandra', driverVersion: '3.22.1.0', requestCount: 412, sslEnabled: false, keyspace: null },
  { address: '10.0.3.40', port: 43120, hostname: 'orders-api-7d9f4', username: 'orders_svc', connectionStage: 'ready', protocolVersion: 5,
    driverName: 'DataStax Java driver for Apache Cassandra(R)', driverVersion: '4.17.0', requestCount: 982_311, sslEnabled: true, keyspace: 'shop' },
  { address: '127.0.0.1', port: 60122, hostname: 'localhost', username: 'anonymous', connectionStage: 'ready', protocolVersion: 5,
    driverName: 'DataStax Python Driver', driverVersion: '3.29.2', requestCount: 23, sslEnabled: false, keyspace: null },
];

// ---------------------------------------------------------------- traces

const COORDINATOR = '10.0.1.11';
const REPLICAS = ['10.0.1.12', '10.0.1.13', '10.0.1.11'];

function replicaCount(c: CqlConsistency): number {
  if (c === 'ONE' || c === 'LOCAL_ONE' || c === 'ANY') return 1;
  if (c === 'THREE' || c === 'ALL') return 3;
  return 2;
}

let uuidSeq = 0;
/** A version-1 (time-based) UUID for a timestamp (ms) plus a sub-millisecond offset (µs). */
function timeuuid(ms: number, micros = 0): string {
  const ticks = BigInt(ms) * 10_000n + BigInt(Math.round(micros * 10)) + 0x01b21dd213814000n;
  const hex = ticks.toString(16).padStart(15, '0');
  const seq = (0x8000 | (++uuidSeq & 0x3fff)).toString(16);
  return `${hex.slice(7)}-${hex.slice(3, 7)}-1${hex.slice(0, 3)}-${seq}-0242ac110002`;
}

interface RawEvent { source: string; offset: number; elapsed: number; activity: string; thread: string }

function traceEvents(sql: string, consistency: CqlConsistency): RawEvent[] {
  const s = sql.trim().replace(/\s+/g, ' ');
  const table = /\b(?:FROM|INTO|UPDATE)\s+(?:"?\w+"?\.)?"?(\w+)"?/i.exec(s)?.[1] ?? 'unknown';
  const head = s.split(' ')[0].toUpperCase();
  const write = head === 'INSERT' || head === 'UPDATE' || head === 'DELETE' || head === 'BEGIN';
  const read = head === 'SELECT';
  const NTR = 'Native-Transport-Requests-1';
  const out: RawEvent[] = [
    { source: COORDINATOR, offset: 0, elapsed: 176, activity: `Parsing ${s.length > 120 ? `${s.slice(0, 117)}...` : s}`, thread: NTR },
    { source: COORDINATOR, offset: 0, elapsed: 391, activity: 'Preparing statement', thread: NTR },
  ];
  if (!read && !write) {
    out.push({ source: COORDINATOR, offset: 0, elapsed: 1204, activity: 'Executing statement', thread: NTR });
    return out;
  }
  const replicas = REPLICAS.slice(0, replicaCount(consistency));
  if (write) out.push({ source: COORDINATOR, offset: 0, elapsed: 522, activity: 'Determining replicas for mutation', thread: NTR });
  let last = 0;
  replicas.forEach((r, i) => {
    const send = (write ? 640 : 610) + i * 95;
    const msg = write ? 'MUTATION_REQ' : 'READ_REQ';
    const size = write ? 211 : 145;
    if (r === COORDINATOR) {
      // the coordinator is a replica too: local execution
      out.push(read
        ? { source: r, offset: 0, elapsed: send + 120, activity: `Executing single-partition query on ${table}`, thread: 'ReadStage-3' }
        : { source: r, offset: 0, elapsed: send + 120, activity: 'Appending to commitlog', thread: 'MutationStage-2' });
      out.push(read
        ? { source: r, offset: 0, elapsed: send + 610, activity: 'Read 1 live rows and 0 tombstone cells', thread: 'ReadStage-3' }
        : { source: r, offset: 0, elapsed: send + 290, activity: `Adding to ${table} memtable`, thread: 'MutationStage-2' });
      last = Math.max(last, send + 640);
      return;
    }
    out.push({ source: COORDINATOR, offset: 0, elapsed: send, activity: read && i > 0 ? `reading digest from /${r}:7000` : `Sending ${msg} message to /${r}:7000 message size ${size} bytes`, thread: `Messaging-EventLoop-3-${i + 2}` });
    const offset = send + 240 + i * 60; // network delay: the replica's clock starts when the request arrives
    const rt = read ? `ReadStage-${i + 1}` : `MutationStage-${i + 1}`;
    out.push({ source: r, offset, elapsed: 38, activity: `${msg} message received from /${COORDINATOR}:7000`, thread: `Messaging-EventLoop-3-${i + 4}` });
    if (read) {
      out.push({ source: r, offset, elapsed: 254 + i * 31, activity: `Executing single-partition query on ${table}`, thread: rt });
      out.push({ source: r, offset, elapsed: 719 + i * 87, activity: `Merged data from memtables and ${i + 1} sstables`, thread: rt });
      out.push({ source: r, offset, elapsed: 802 + i * 87, activity: 'Read 1 live rows and 0 tombstone cells', thread: rt });
    } else {
      out.push({ source: r, offset, elapsed: 201 + i * 23, activity: 'Appending to commitlog', thread: rt });
      out.push({ source: r, offset, elapsed: 377 + i * 29, activity: `Adding to ${table} memtable`, thread: rt });
    }
    const replyAt = offset + (read ? 905 + i * 87 : 468 + i * 29);
    out.push({ source: r, offset, elapsed: replyAt - offset, activity: `Sending ${write ? 'MUTATION_RSP' : 'READ_RSP'} message to /${COORDINATOR}:7000 message size ${write ? 34 : 98} bytes`, thread: `Messaging-EventLoop-3-${i + 4}` });
    const back = replyAt + 260 + i * 40;
    out.push({ source: COORDINATOR, offset: 0, elapsed: back, activity: `${write ? 'MUTATION_RSP' : 'READ_RSP'} message received from /${r}:7000`, thread: `Messaging-EventLoop-3-${i + 2}` });
    last = Math.max(last, back);
  });
  if (read) out.push({ source: COORDINATOR, offset: 0, elapsed: last + 133, activity: 'Processing response from replicas', thread: 'RequestResponseStage-2' });
  return out;
}

interface StoredTrace { trace: CqlTrace; summary: CqlTraceSummary; fetches: number }

function buildTrace(id: string, sql: string, settings: CqlSessionSettings, startedMs: number): StoredTrace {
  const raw = traceEvents(sql, settings.consistency);
  const absolute = (e: RawEvent) => e.offset + e.elapsed;
  raw.sort((a, b) => absolute(a) - absolute(b));
  const events: CqlTraceEvent[] = raw.map((e) => {
    const at = absolute(e);
    return {
      eventId: timeuuid(startedMs + Math.floor(at / 1000), at % 1000), activity: e.activity, source: e.source, sourceElapsedMicros: e.elapsed,
      thread: e.thread, timestamp: new Date(startedMs + Math.floor(at / 1000)).toISOString(),
    };
  });
  const duration = Math.max(...raw.map(absolute)) + 187;
  const startedAt = new Date(startedMs).toISOString();
  const trace: CqlTrace = {
    traceId: id, coordinator: COORDINATOR, client: '10.0.0.5', request: 'Execute CQL3 query', command: 'QUERY', startedAt, durationMicros: duration,
    parameters: {
      consistency_level: settings.consistency, page_size: String(settings.pageSize), query: sql.trim(), serial_consistency_level: settings.serialConsistency,
    },
    events,
  };
  return {
    trace, fetches: 0,
    summary: { traceId: id, startedAt, statement: sql.trim().slice(0, 200), coordinator: COORDINATOR, durationMicros: duration, consistency: settings.consistency },
  };
}

// ---------------------------------------------------------------- state

interface SessionState { settings: CqlSessionSettings; traces: string[] }

export interface CassandraMockState {
  /** Release version every node reports (cluster view; `/clients` needs 4.0+). */
  releaseVersion: string;
  sessions: Map<string, SessionState>;
  /** By trace id (traces of every Cassandra connection). */
  traces: Map<string, StoredTrace & { connectionId: string }>;
  /** Records a traced statement of a session (what the engine does for every statement while tracing is on). */
  addTrace(sessionId: string, sql: string): string | null;
}

const STATES = new WeakMap<MockEngine, CassandraMockState>();

const isCassandra = (engine: MockEngine, cid: string | undefined) => !!cid && engine.conn(cid)?.providerId === 'cassandra';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function defaults(engine: MockEngine, cid: string): CqlSessionSettings {
  const p = engine.conn(cid)?.props ?? {};
  const c = str(p.consistency)?.toUpperCase() as CqlConsistency | undefined;
  const sc = str(p.serialConsistency)?.toUpperCase();
  const size = Number(p.pageSize);
  return {
    consistency: c && CQL_CONSISTENCY_LEVELS.includes(c) ? c : 'LOCAL_QUORUM',
    serialConsistency: sc === 'LOCAL_SERIAL' ? 'LOCAL_SERIAL' : 'SERIAL',
    tracing: false,
    pageSize: Number.isInteger(size) && size >= 1 ? Math.min(size, 10_000) : 1000,
    insertTtl: null,
    keyspace: str(p.keyspace),
    lastTraceId: null,
  };
}

/** The pack's per-engine state (created on first use). */
export function cassandraMockState(engine: MockEngine): CassandraMockState {
  let st = STATES.get(engine);
  if (st) return st;
  const state: CassandraMockState = {
    releaseVersion: '5.0.2',
    sessions: new Map(),
    traces: new Map(),
    addTrace(sessionId, sql) {
      const s = engine.sessions.get(sessionId);
      if (!s || !isCassandra(engine, s.connectionId)) return null;
      const ss = sessionState(sessionId)!;
      const started = Date.now() - 1;
      const id = timeuuid(started);
      state.traces.set(id, { ...buildTrace(id, sql, ss.settings, started), connectionId: s.connectionId });
      ss.traces.unshift(id);
      ss.traces.length = Math.min(ss.traces.length, 50);
      ss.settings = { ...ss.settings, lastTraceId: id };
      return id;
    },
  };
  const sessionState = (sid: string): SessionState | null => {
    const s = engine.sessions.get(sid);
    if (!s || !isCassandra(engine, s.connectionId)) return null;
    let ss = state.sessions.get(sid);
    if (!ss) {
      ss = { settings: defaults(engine, s.connectionId), traces: [] };
      state.sessions.set(sid, ss);
    }
    return ss;
  };
  stateSession.set(state, sessionState);
  STATES.set(engine, state);
  // Executions on Cassandra sessions go through the engine's interpreter (one statement per batch): the hook answers the
  // cqlsh shell commands itself and, while tracing is on, adds the trace result set and the "Tracing session" message.
  const base = engine.interpret.bind(engine);
  engine.interpret = (s, sqlRaw) => {
    const ss = sessionState(s.sessionId);
    if (!ss) return base(s, sqlRaw);
    const text = stripCqlComments(sqlRaw).trim().replace(/;\s*$/, '').trim();
    const shell = shellCommand(state, ss, text);
    if (shell) return { sets: [], messages: [], affected: null, kind: null, error: null, ...shell };
    const r = base(s, sqlRaw);
    if (!r.error && ss.settings.tracing && text) {
      const id = state.addTrace(s.sessionId, text);
      const t = id ? state.traces.get(id)?.trace : undefined;
      if (t) {
        r.sets = [...r.sets, traceResultSet(t)];
        r.messages = [...r.messages, { severity: 'info', text: `Tracing session: ${t.traceId}`, source: 'engine' }];
      }
    }
    return r;
  };
  return state;
}

const stateSession = new WeakMap<CassandraMockState, (sid: string) => SessionState | null>();

type Interpreted = ReturnType<MockEngine['interpret']>;

function stripCqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(--|\/\/)[^\n]*/g, '');
}

const info = (text: string): Partial<Interpreted> => ({ messages: [{ severity: 'info', text, source: 'engine' }] });
const failure = (text: string): Partial<Interpreted> => ({ error: text, errorCode: '8704' });

function column(name: string, ordinal: number, kind: ColumnInfo['kind'], dbType: string): ColumnInfo {
  return { name, ordinal, dbType, kind, nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false };
}

/** The trace as cqlsh prints it: one row per event between "Execute CQL3 query" and "Request complete". */
function traceResultSet(t: CqlTrace): { columns: ColumnInfo[]; rows: CellValue[][] } {
  const started = t.startedAt ?? t.events[0]?.timestamp ?? null;
  const done = t.durationMicros ?? Math.max(0, ...t.events.map((e) => e.sourceElapsedMicros));
  const end = started ? new Date(new Date(started).getTime() + Math.floor(done / 1000)).toISOString() : null;
  return {
    columns: [column('activity', 0, 'string', 'text'), column('timestamp', 1, 'datetime', 'timestamp'), column('source', 2, 'string', 'inet'),
      column('source_elapsed', 3, 'int', 'int'), column('client', 4, 'string', 'inet')],
    rows: [
      [t.request ?? 'Execute CQL3 query', started, t.coordinator, 0, t.client],
      ...t.events.map((e): CellValue[] => [e.activity, e.timestamp, e.source, e.sourceElapsedMicros, t.client]),
      ['Request complete', end, t.coordinator, done, t.client],
    ],
  };
}

const CQL_KEYSPACES = ['shop', 'system', 'system_auth', 'system_distributed', 'system_schema', 'system_traces', 'system_views', 'system_virtual_schema'];

/**
 * cqlsh shell commands the console accepts (engine: CqlShellCommands): the interpreter result, or null for a CQL
 * statement (`USE ks` also updates the session keyspace but runs as a statement).
 */
function shellCommand(state: CassandraMockState, ss: SessionState, text: string): Partial<Interpreted> | null {
  const set = (patch: Partial<CqlSessionSettings>) => (ss.settings = { ...ss.settings, ...patch });
  let m = /^SERIAL\s+CONSISTENCY(?:\s+(\w+))?$/i.exec(text);
  if (m) {
    if (!m[1]) return info(`Current serial consistency level is ${ss.settings.serialConsistency}.`);
    const v = m[1].toUpperCase();
    if (v !== 'SERIAL' && v !== 'LOCAL_SERIAL') return failure(`Improper SERIAL CONSISTENCY command: '${m[1]}' is not SERIAL or LOCAL_SERIAL.`);
    set({ serialConsistency: v });
    return info(`Serial consistency level set to ${v}.`);
  }
  m = /^CONSISTENCY(?:\s+(\w+))?$/i.exec(text);
  if (m) {
    if (!m[1]) return info(`Current consistency level is ${ss.settings.consistency}.`);
    const v = m[1].toUpperCase() as CqlConsistency;
    if (!CQL_CONSISTENCY_LEVELS.includes(v)) return failure(`Improper CONSISTENCY command: unknown consistency level '${m[1]}'.`);
    set({ consistency: v });
    return info(`Consistency level set to ${v}.`);
  }
  m = /^TRACING(?:\s+(ON|OFF))?$/i.exec(text);
  if (m) {
    const on = ss.settings.tracing;
    if (!m[1]) return info(`Tracing is currently ${on ? 'enabled' : 'disabled'}. Use TRACING ${on ? 'OFF' : 'ON'} to ${on ? 'disable' : 'enable'} it.`);
    set({ tracing: m[1].toUpperCase() === 'ON' });
    return info(ss.settings.tracing ? 'Now Tracing is enabled' : 'Disabled Tracing.');
  }
  m = /^PAGING(?:\s+(ON|OFF|\d+))?$/i.exec(text);
  if (m) {
    if (!m[1]) return info(`Query paging is currently ${ss.settings.pageSize < 10_000 ? 'enabled' : 'disabled'}.\nPage size: ${ss.settings.pageSize}`);
    const v = m[1].toUpperCase();
    if (v === 'OFF') {
      set({ pageSize: 10_000 });
      return info('Disabled Query paging.');
    }
    set({ pageSize: v === 'ON' ? 1000 : Math.min(Math.max(1, Number(v)), 10_000) });
    return info(`${v === 'ON' ? 'Now Query paging is enabled\n' : ''}Page size: ${ss.settings.pageSize}`);
  }
  m = /^SHOW\s+(VERSION|HOST|SESSION)(?:\s+([0-9a-f-]{36}))?$/i.exec(text);
  if (m) {
    const c = clusterInfo(state.releaseVersion);
    const what = m[1].toUpperCase();
    if (what === 'VERSION') return info(`[cqlsh 6.2.0 | Cassandra ${c.releaseVersion} | CQL spec ${c.cqlVersion} | Native protocol v${c.protocolVersion}]`);
    if (what === 'HOST') return info(`Connected to ${c.clusterName} at ${COORDINATOR}:9042`);
    if (!m[2]) return failure('Usage: SHOW SESSION <trace id>');
    const t = state.traces.get(m[2].toLowerCase())?.trace;
    return t ? { sets: [traceResultSet(t)] } : failure(`Trace ${m[2]} was not found in system_traces.sessions (traces expire after 24 hours).`);
  }
  m = /^DESC(?:RIBE)?\s+(.+)$/is.exec(text);
  if (m) {
    const arg = m[1].trim().replace(/\s+/g, ' ');
    const one = (name: string, rows: CellValue[][]): Partial<Interpreted> => ({ sets: [{ columns: [column(name, 0, 'string', 'text')], rows }] });
    if (/^KEYSPACES$/i.test(arg)) return one('keyspace_name', CQL_KEYSPACES.map((k) => [k]));
    if (/^TABLES$/i.test(arg)) return one('name', TABLES.filter((t) => t.type === 'table').map((t) => [t.name]));
    if (/^CLUSTER$/i.test(arg)) {
      const c = clusterInfo(state.releaseVersion);
      return info(`Cluster: ${c.clusterName}\nPartitioner: ${c.partitioner?.split('.').pop() ?? ''}`);
    }
    const t = /^(?:(?:TABLE|COLUMNFAMILY|MATERIALIZED VIEW)\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?$/i.exec(arg);
    const ks = t?.[1] ?? ss.settings.keyspace ?? 'shop';
    const ti = t ? cassandraTableInfo(ks, t[2]) : null;
    return ti ? one('create_statement', [[ti.ddl]]) : failure(`'${arg}' not found in keyspace '${ks}'`);
  }
  m = /^USE\s+"?(\w+)"?$/i.exec(text);
  if (m) set({ keyspace: m[1] });
  return null;
}

// ---------------------------------------------------------------- routes

function err(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

const MAX_TTL = 630_720_000; // 20 years, Cassandra's limit

function validatePatch(body: Record<string, unknown>): string | null {
  if ('consistency' in body && !CQL_CONSISTENCY_LEVELS.includes(body.consistency as CqlConsistency)) return `Unknown consistency level '${String(body.consistency)}'.`;
  if ('serialConsistency' in body && body.serialConsistency !== 'SERIAL' && body.serialConsistency !== 'LOCAL_SERIAL') {
    return `Serial consistency must be SERIAL or LOCAL_SERIAL, not '${String(body.serialConsistency)}'.`;
  }
  if ('tracing' in body && typeof body.tracing !== 'boolean') return 'tracing must be true or false.';
  if ('pageSize' in body && (!Number.isInteger(body.pageSize) || (body.pageSize as number) < 1 || (body.pageSize as number) > 10_000)) {
    return 'Page size must be a whole number between 1 and 10000.';
  }
  if ('insertTtl' in body && body.insertTtl !== null && (!Number.isInteger(body.insertTtl) || (body.insertTtl as number) < 0 || (body.insertTtl as number) > MAX_TTL)) {
    return `Insert TTL must be empty or a whole number of seconds between 0 and ${MAX_TTL}.`;
  }
  return null;
}

export function createCassandraHandlers(ctx: M2MockContext): RequestHandler[] {
  const P = `${M2_PREFIX}/cassandra`;
  const { ok } = ctx;
  const st = () => cassandraMockState(ctx.engine);
  const session = (sid: string) => stateSession.get(st())!(sid);
  const noSession = (sid: string) => err(404, 'NOT_FOUND', `Cassandra session '${sid}' was not found.`);
  const noConn = (cid: string) => err(404, 'NOT_FOUND', `Cassandra connection '${cid}' was not found.`);
  // create the state (and its execution observer) with the handlers, not on the first Cassandra request
  st();
  return [
    http.get(`${P}/sessions/:sid/settings`, ({ params }) => {
      const ss = session(String(params.sid));
      return ss ? ok(ss.settings) : noSession(String(params.sid));
    }),
    http.put(`${P}/sessions/:sid/settings`, async ({ params, request }) => {
      const ss = session(String(params.sid));
      if (!ss) return noSession(String(params.sid));
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const problem = validatePatch(body ?? {});
      if (problem) return err(400, 'VALIDATION', problem);
      const { consistency, serialConsistency, tracing, pageSize, insertTtl } = body as Partial<CqlSessionSettings>;
      ss.settings = {
        ...ss.settings,
        ...(consistency !== undefined ? { consistency } : {}),
        ...(serialConsistency !== undefined ? { serialConsistency: serialConsistency as CqlSerialConsistency } : {}),
        ...(tracing !== undefined ? { tracing } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(insertTtl !== undefined ? { insertTtl } : {}),
      };
      return ok(ss.settings);
    }),
    http.get(`${P}/sessions/:sid/traces`, ({ params }) => {
      const ss = session(String(params.sid));
      if (!ss) return noSession(String(params.sid));
      return ok(ss.traces.map((id) => st().traces.get(id)?.summary).filter((x): x is CqlTraceSummary => !!x));
    }),
    http.get(`${P}/:cid/traces/:traceId`, ({ params }) => {
      const cid = String(params.cid);
      if (!isCassandra(ctx.engine, cid)) return noConn(cid);
      const t = st().traces.get(String(params.traceId));
      if (!t || t.connectionId !== cid) return err(404, 'NOT_FOUND', `Trace ${String(params.traceId)} was not found in system_traces.sessions (traces expire after 24 hours).`);
      t.fetches++;
      if (t.fetches === 1) {
        // the coordinator has not finished writing the trace yet
        const cut = Math.ceil(t.trace.events.length / 2);
        return ok({ ...t.trace, durationMicros: null, events: t.trace.events.slice(0, cut) });
      }
      return ok(t.trace);
    }),
    http.get(`${P}/:cid/cluster`, ({ params }) => {
      const cid = String(params.cid);
      return isCassandra(ctx.engine, cid) ? ok(clusterInfo(st().releaseVersion)) : noConn(cid);
    }),
    http.get(`${P}/:cid/clients`, ({ params }) => {
      const cid = String(params.cid);
      if (!isCassandra(ctx.engine, cid)) return noConn(cid);
      const v = st().releaseVersion;
      if (Number.parseInt(v, 10) < 4) return err(400, 'NOT_SUPPORTED', `system_views.clients needs Cassandra 4.0 or later (the cluster runs ${v}).`);
      return ok(CLIENTS);
    }),
    http.get(`${P}/:cid/keyspaces/:ks/tables/:name`, ({ params }) => {
      const cid = String(params.cid);
      if (!isCassandra(ctx.engine, cid)) return noConn(cid);
      const info = cassandraTableInfo(String(params.ks), String(params.name));
      return info ? ok(info) : err(404, 'NOT_FOUND', `Table ${String(params.ks)}.${String(params.name)} does not exist.`);
    }),
  ];
}

export const cassandraPack: MockProviderPack = {
  providers: [CASSANDRA_PROVIDER],
  // fresh copies per mock engine (the engine mutates its profiles: lastUsedAt, edits)
  get connections() {
    return structuredClone(cassandraConnections);
  },
  extraObjects: { cassandra: CASSANDRA_EXTRA_OBJECTS },
  handlers: createCassandraHandlers,
};

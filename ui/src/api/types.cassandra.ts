// Cassandra / ScyllaDB module wire types (plan-batch3 WP-CS): `/cassandra/...` endpoints of the engine's
// CassandraModule (engine/src/DbStudio.Providers.Cassandra/Endpoints/CassandraEndpoints.cs). Type-only module.
// Conventions: camelCase JSON, ISO-8601 timestamps, durations in microseconds (Cassandra's tracing unit).

/** CQL consistency levels (driver `ConsistencyLevel`, cqlsh `CONSISTENCY`). */
export type CqlConsistency =
  | 'ANY' | 'ONE' | 'TWO' | 'THREE' | 'QUORUM' | 'ALL' | 'LOCAL_QUORUM' | 'EACH_QUORUM' | 'LOCAL_ONE' | 'SERIAL' | 'LOCAL_SERIAL';

/** Serial consistency of lightweight transactions (`IF …`). */
export type CqlSerialConsistency = 'SERIAL' | 'LOCAL_SERIAL';

export const CQL_CONSISTENCY_LEVELS: readonly CqlConsistency[] = [
  'ONE', 'TWO', 'THREE', 'QUORUM', 'ALL', 'LOCAL_ONE', 'LOCAL_QUORUM', 'EACH_QUORUM', 'ANY', 'SERIAL', 'LOCAL_SERIAL',
];

/**
 * `GET|PUT /cassandra/sessions/{sid}/settings`: console (tab session) settings. They apply to every following
 * statement of that session; the console also accepts the cqlsh shell commands `CONSISTENCY x`,
 * `SERIAL CONSISTENCY x`, `TRACING ON|OFF` and `PAGING n|ON|OFF`, which change the same values.
 */
export interface CqlSessionSettings {
  consistency: CqlConsistency;
  serialConsistency: CqlSerialConsistency;
  /** Request tracing for every statement (results gain a "trace" result set; see `traces`). */
  tracing: boolean;
  /** Rows per round trip (driver page size, 1..10000). */
  pageSize: number;
  /** TTL in seconds added to data-grid INSERTs (`USING TTL n`); null = none. */
  insertTtl: number | null;
  /** Current keyspace of the session (read-only here: change it with USE or the keyspace switcher). */
  keyspace: string | null;
  /** Trace id of the last traced statement, if any. */
  lastTraceId: string | null;
}

/** `PUT /cassandra/sessions/{sid}/settings` body: any subset. */
export type CqlSessionSettingsPatch = Partial<Pick<CqlSessionSettings, 'consistency' | 'serialConsistency' | 'tracing' | 'pageSize' | 'insertTtl'>>;

/** `GET /cassandra/sessions/{sid}/traces`: traced statements of the session, newest first (at most 50). */
export interface CqlTraceSummary {
  traceId: string;
  startedAt: string;
  /** Statement text (first 200 characters). */
  statement: string;
  coordinator: string | null;
  durationMicros: number | null;
  consistency: CqlConsistency | null;
}

/** One event of `system_traces.events`. */
export interface CqlTraceEvent {
  /** timeuuid of the event. */
  eventId: string;
  activity: string;
  /** Node that logged the event. */
  source: string;
  /** Microseconds since the request reached that node. */
  sourceElapsedMicros: number;
  thread: string | null;
  /** Event time (from the timeuuid). */
  timestamp: string;
}

/** `GET /cassandra/{cid}/traces/{traceId}`: `system_traces.sessions` + `events` of one request. */
export interface CqlTrace {
  traceId: string;
  coordinator: string | null;
  client: string | null;
  /** e.g. "Execute CQL3 query". */
  request: string | null;
  command: string | null;
  startedAt: string | null;
  /** Null while the coordinator has not finished writing the trace. */
  durationMicros: number | null;
  parameters: Record<string, string>;
  events: CqlTraceEvent[];
}

export interface CqlNode {
  address: string;
  dataCenter: string | null;
  rack: string | null;
  releaseVersion: string | null;
  hostId: string | null;
  /** Driver view of the node (up = reachable). */
  isUp: boolean;
  /** The node answering the control connection (system.local). */
  isLocal: boolean;
  /** Number of tokens (vnodes) the node owns. */
  tokens: number;
  schemaVersion: string | null;
}

export interface CqlDataCenter {
  name: string;
  nodes: number;
  up: number;
  racks: string[];
}

/** `GET /cassandra/{cid}/cluster`: system.local / system.peers(_v2) and the driver's host list. */
export interface CqlClusterInfo {
  clusterName: string | null;
  partitioner: string | null;
  cqlVersion: string | null;
  releaseVersion: string | null;
  /** Negotiated native protocol version. */
  protocolVersion: number | null;
  /** "cassandra" | "scylla" | "dse". */
  product: string;
  dataCenters: CqlDataCenter[];
  nodes: CqlNode[];
  /** Every node reports the same schema version. */
  schemaInAgreement: boolean;
}

/** `GET /cassandra/{cid}/clients`: `system_views.clients` (Cassandra 4.0+; 400 NOT_SUPPORTED before). */
export interface CqlClientConnection {
  address: string;
  port: number | null;
  hostname: string | null;
  username: string | null;
  connectionStage: string | null;
  protocolVersion: number | null;
  driverName: string | null;
  driverVersion: string | null;
  requestCount: number | null;
  sslEnabled: boolean | null;
  keyspace: string | null;
}

export interface CqlColumnDef {
  name: string;
  type: string;
  /** "partition_key" | "clustering" | "regular" | "static". */
  kind: 'partition_key' | 'clustering' | 'regular' | 'static';
  /** Position within the partition key / clustering key (-1 for regular/static). */
  position: number;
  /** Clustering order ("asc" | "desc"); null for other kinds. */
  order: 'asc' | 'desc' | null;
}

export interface CqlIndexDef {
  name: string;
  /** "COMPOSITES" | "KEYS" | "CUSTOM". */
  kind: string;
  /** Target column expression, e.g. "email", "keys(tags)". */
  target: string | null;
  /** Custom index class (SAI: org.apache.cassandra.index.sai.StorageAttachedIndex). */
  className: string | null;
}

/** `GET /cassandra/{cid}/keyspaces/{ks}/tables/{name}`: keys, options, indexes, views and size estimate of a table or MV. */
export interface CqlTableInfo {
  keyspace: string;
  name: string;
  /** "table" | "mview". */
  type: 'table' | 'mview';
  /** MVs: the base table. */
  baseTable: string | null;
  /** MVs: the WHERE clause. */
  whereClause: string | null;
  columns: CqlColumnDef[];
  partitionKey: string[];
  clustering: { name: string; order: 'asc' | 'desc' }[];
  /** CQL `PRIMARY KEY ((a, b), c, d)` text. */
  primaryKey: string;
  /** Table options (WITH …) as CQL literals, e.g. { default_time_to_live: "0", compaction: "{'class': '…'}" }. */
  options: Record<string, string>;
  isCounter: boolean;
  indexes: CqlIndexDef[];
  /** Materialized views of the table. */
  views: string[];
  /** system.size_estimates of the local node (null when unknown). */
  estimatedPartitions: number | null;
  meanPartitionSizeBytes: number | null;
  /** Generated CREATE statement (with indexes). */
  ddl: string;
}

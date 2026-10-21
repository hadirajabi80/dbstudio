// M2 feature wire types (docs/PLAN-M2.md sections 3–8), re-exported from ./types.ts.
// Written by M2-0 from the plan's endpoint tables; each feature package owns its section below and may extend it.
// Conventions: timestamps are ISO-8601 strings; Mongo documents are canonical EJSON *text* (parsed client-side);
// int64 offsets/sizes are plain numbers (values beyond 2^53 are not expected); free-form JSON is `unknown`.
import type { PlanNode, ServerInfo } from './types';

/** A string value cut by the engine (`len` = full length); "Load full" fetches the complete value. */
export interface M2TruncatedText { $trunc: string; len: number }

// ---------- Redis (PLAN-M2 §5) ----------
// Owner: M2-R (M2-R-E engine, M2-R-U UI). Paths: /api/v1/redis/{cid}/…

/** Key types as reported by `TYPE` (`ReJSON-RL` → `rejson`); `unknown` covers other module types (TSDB, …). */
export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'rejson' | 'unknown';
export type RedisMode = 'standalone' | 'cluster' | 'sentinel';

/** `GET /redis/{cid}/server`. */
export interface RedisServerInfo {
  server: ServerInfo;
  /** shape chosen by M2-0; the feature package may refine */
  mode: RedisMode;
  /** `MODULE LIST` names, e.g. `ReJSON`, `search`, `timeseries`. */
  modules: string[];
  /** shape chosen by M2-0; the feature package may refine — `CONFIG GET databases` (1 for cluster). */
  databases: number;
  /** shape chosen by M2-0; the feature package may refine — `INFO keyspace` (explorer db node counts). */
  keyspace: { db: number; keys: number; expires: number }[];
  /** M2-R: the profile is read-only (writes answer 403 READ_ONLY). */
  readOnly?: boolean;
  /** M2-R: the profile's key delimiter (tree view) and SCAN count. */
  delimiter?: string;
  scanCount?: number;
}

/** `POST /redis/{cid}/keys/scan`. `cursor` is `'0'` to start; cluster cursors are `node@cursor;…`. */
export interface RedisScanRequest {
  db: number;
  pattern: string;
  type?: RedisKeyType | null;
  cursor: string;
  count: number;
}
export interface RedisKeySummary {
  key: string;
  type: RedisKeyType;
  /** Seconds; -1 = no TTL, -2 = key gone. */
  ttl: number;
  /** `MEMORY USAGE` bytes when already known. */
  size?: number | null;
}
/** `cursor === '0'` means the scan is complete. */
export interface RedisScanResponse {
  cursor: string;
  keys: RedisKeySummary[];
  scanned: number;
  dbSize: number;
}

/** shape chosen by M2-0; the feature package may refine — `POST /redis/{cid}/keys/memory` (lazy badges, ≤ 100 keys). */
export interface RedisMemoryRequest { db: number; keys: string[] }
export interface RedisMemoryResponse { sizes: Record<string, number | null> }

/** Query of `GET /redis/{cid}/keys/{key}`; which paging fields apply depends on the key type. */
export interface RedisGetKeyQuery {
  db: number;
  /** hash/set/zset: HSCAN/SSCAN/ZSCAN cursor (`'0'` = first page). */
  cursor?: string;
  count?: number;
  /** hash/set/zset: `MATCH` filter. */
  field?: string;
  /** list: LRANGE indexes; stream: entry ids (`-`/`+` or `1700000000000-0`). */
  start?: number | string;
  stop?: number | string;
}

/** Header of every key value (`TYPE`, `TTL`, `OBJECT ENCODING`, `MEMORY USAGE`). */
export interface RedisKeyHeader {
  key: string;
  db: number;
  ttl: number;
  objectEncoding: string | null;
  memory: number | null;
}
export interface RedisStringValue extends RedisKeyHeader {
  type: 'string';
  /** Values > 1 MB arrive truncated. */
  value: string | M2TruncatedText;
  /** shape chosen by M2-0; the feature package may refine — `hex` when the bytes are not valid UTF-8 (value is hex text). */
  encoding: 'utf8' | 'hex';
  isJson: boolean;
  /** M2-R: `STRLEN` (bytes) of the full value. */
  length?: number;
}
export interface RedisHashValue extends RedisKeyHeader {
  type: 'hash';
  fields: { field: string; value: string }[];
  /** Next HSCAN cursor; `'0'` = last page. */
  cursor: string;
  /** shape chosen by M2-0; the feature package may refine — `HLEN`. */
  length: number;
}
export interface RedisListValue extends RedisKeyHeader {
  type: 'list';
  items: { index: number; value: string }[];
  length: number;
  start: number;
  stop: number;
}
export interface RedisSetValue extends RedisKeyHeader {
  type: 'set';
  members: string[];
  cursor: string;
  /** shape chosen by M2-0; the feature package may refine — `SCARD`. */
  length: number;
}
export interface RedisZsetValue extends RedisKeyHeader {
  type: 'zset';
  members: RedisZsetMember[];
  cursor: string;
  /** shape chosen by M2-0; the feature package may refine — `ZCARD`. */
  length: number;
}
export interface RedisZsetMember { member: string; score: number }
export interface RedisStreamEntry { id: string; fields: Record<string, string> }
export interface RedisStreamGroup {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
  lag: number | null;
}
export interface RedisStreamValue extends RedisKeyHeader {
  type: 'stream';
  entries: RedisStreamEntry[];
  length: number;
  firstId: string | null;
  lastId: string | null;
  groups: RedisStreamGroup[];
}
export interface RedisJsonValue extends RedisKeyHeader {
  type: 'rejson';
  /** Parsed result of `JSON.GET key $`. */
  json: unknown;
  path: string;
}
/** Typed value of `GET /redis/{cid}/keys/{key}` (discriminated on `type`). */
export type RedisKeyValue =
  | RedisStringValue | RedisHashValue | RedisListValue | RedisSetValue | RedisZsetValue | RedisStreamValue | RedisJsonValue;

// Mutations (all READ_ONLY-guarded; `db` travels as a query parameter on /keys/{key}/… routes).
/** `PUT /keys/{key}/string` (keeps the TTL). */
export interface RedisSetStringRequest { value: string }
/** `POST /keys/{key}/hash` (HSET/HDEL). */
export interface RedisHashEditRequest { set?: Record<string, string>; del?: string[] }
/** `POST /keys/{key}/list`: exactly one operation. */
export type RedisListEditRequest =
  | { push: { side: 'left' | 'right'; values: string[] } }
  | { setIndex: { index: number; value: string } }
  | { remove: { value: string; count: number } };
/** `POST /keys/{key}/set` (SADD/SREM). */
export interface RedisSetEditRequest { add?: string[]; remove?: string[] }
/** `POST /keys/{key}/zset` (ZADD/ZREM). */
export interface RedisZsetEditRequest { add?: RedisZsetMember[]; remove?: string[] }
/** `POST /keys/{key}/stream`: exactly one operation. `id` of `add` defaults to `*` (shape chosen by M2-0). */
export type RedisStreamEditRequest =
  | { add: Record<string, string>; id?: string }
  | { delete: string[] }
  | { ack: { group: string; ids: string[] } }
  | { groupCreate: { name: string; id: string } }
  | { groupDestroy: string };
/** `PUT /keys/{key}/json` (`JSON.SET key path value`). */
export interface RedisJsonSetRequest { path: string; value: unknown }
/** `POST /keys`: create a key (shape chosen by M2-0; the feature package may refine). */
export type RedisCreateKeyRequest = { key: string; db: number; ttl?: number | null } & (
  | { type: 'string'; value: string }
  | { type: 'hash'; fields: Record<string, string> }
  | { type: 'list'; values: string[] }
  | { type: 'set'; members: string[] }
  | { type: 'zset'; members: RedisZsetMember[] }
  | { type: 'stream'; fields: Record<string, string> }
  | { type: 'rejson'; json: unknown }
);
/** `POST /keys/{key}/rename` (RENAME / RENAMENX when !overwrite). Cluster: both keys must hash to the same slot. */
export interface RedisRenameRequest { newKey: string; overwrite: boolean }
/** `PUT /keys/{key}/ttl`: null = PERSIST. */
export interface RedisTtlRequest { seconds: number | null }
/** `POST /keys/delete-pattern` → job. */
export interface RedisDeletePatternRequest { db: number; pattern: string }
/** shape chosen by M2-0; the feature package may refine — `job.done.result` of delete-pattern. */
export interface RedisDeletePatternResult { scanned: number; deleted: number }

/** `POST /redis/{cid}/commands`: either parsed `commands` or `raw` lines (redis-cli quoting). */
export interface RedisCommandsRequest { db: number; commands?: string[][]; raw?: string[] }
export type RedisReplyType = 'simple' | 'bulk' | 'int' | 'array' | 'null' | 'error';
export type RedisReplyValue = string | number | null | RedisReplyValue[];
export interface RedisCommandResult {
  ok: boolean;
  type: RedisReplyType;
  value: RedisReplyValue;
  elapsedMs: number;
}
export interface RedisCommandsResponse {
  results: RedisCommandResult[];
  /** M2-R: the database selected after the batch (SELECT is tracked per request). */
  db?: number;
}
/** M2-R: `GET /redis/{cid}/keys/{key}/stream/groups/{group}?db=` (XINFO CONSUMERS + first 100 of XPENDING). */
export interface RedisStreamConsumer { name: string; pending: number; idleMs: number; inactiveMs: number | null }
export interface RedisPendingEntry { id: string; consumer: string; idleMs: number; deliveries: number }
export interface RedisStreamGroupDetail { group: string; consumers: RedisStreamConsumer[]; pending: RedisPendingEntry[] }
/** M2-R: `GET /redis/{cid}/pubsub/channels?pattern=` (PUBSUB CHANNELS + NUMSUB + NUMPAT). */
export interface RedisPubSubChannels { channels: { channel: string; subscribers: number }[]; patterns: number }

/** `POST /redis/{cid}/publish`. */
export interface RedisPublishRequest { channel: string; message: string }
export interface RedisPublishResponse { receivers: number }

/** Item of `GET /redis/{cid}/slowlog?count=`. */
export interface RedisSlowlogEntry {
  id: number;
  ts: string;
  durationUs: number;
  args: string[];
  client: string | null;
  name: string | null;
}

/** shape chosen by M2-0; the feature package may refine — `GET /redis/{cid}/config?pattern=` (`CONFIG GET`). */
export interface RedisConfigResponse { values: Record<string, string> }
/** shape chosen by M2-0; the feature package may refine — `PUT /redis/{cid}/config` (`CONFIG SET`, READ_ONLY-guarded). */
export interface RedisConfigSetRequest { name: string; value: string }

/** shape chosen by M2-0; the feature package may refine — a `CLUSTER NODES` line. */
export interface RedisClusterNode {
  id: string;
  address: string;
  flags: string[];
  masterId: string | null;
  slots: string[];
  linkState: string;
}
/** `GET /redis/{cid}/info`. */
export interface RedisInfoResponse {
  /** Parsed `INFO`: section → key → value. */
  sections: Record<string, Record<string, string>>;
  dbSize: number;
  /** `CLIENT LIST` count. */
  clients: number;
  /** Cluster mode only. */
  clusterNodes: RedisClusterNode[] | null;
}
/** shape chosen by M2-0; the feature package may refine — a `CLIENT LIST` row (`GET /redis/{cid}/clients`). */
export interface RedisClientInfo {
  id: string;
  addr: string;
  name: string | null;
  user: string | null;
  db: number;
  ageSeconds: number;
  idleSeconds: number;
  cmd: string | null;
  flags: string;
  /** Every raw `k=v` pair of the line. */
  fields: Record<string, string>;
}
/** shape chosen by M2-0; the feature package may refine — `POST /redis/{cid}/clients/kill` (`CLIENT KILL ID`). */
export interface RedisClientKillRequest { id: string }

/** `POST /redis/{cid}/analysis` → job. */
export interface RedisAnalysisRequest { db: number; sampleLimit: number; delimiter: string }
export interface RedisAnalysisNamespace {
  prefix: string;
  keys: number;
  memory: number;
  avgTtl: number | null;
  types: Partial<Record<RedisKeyType, number>>;
}
/** `job.done.result` of an analysis job (cluster: summed over masters). */
export interface RedisAnalysisResult {
  scanned: number;
  totalKeys: number;
  sampled: boolean;
  namespaces: RedisAnalysisNamespace[];
  /** Top 100 by `MEMORY USAGE`. */
  topKeys: { key: string; type: RedisKeyType; memory: number; ttl: number }[];
  /** shape chosen by M2-0; the feature package may refine */
  byType: Partial<Record<RedisKeyType, { keys: number; memory: number }>>;
  /** shape chosen by M2-0; the feature package may refine — `maxSeconds` null = open-ended last bucket. */
  ttl: { noTtl: number; buckets: { label: string; maxSeconds: number | null; keys: number }[] };
  /** shape chosen by M2-0; the feature package may refine — keys that have a TTL. */
  expiring: number;
  /** M2-R: duration of the analysis. */
  elapsedMs?: number;
}

/** `redis.monitor` stream item. */
export interface RedisMonitorItem { ts: string; db: number; client: string; args: string[] }
/** `redis.subscribe` stream item. */
export interface RedisMessageItem { ts: string; channel: string; pattern?: string; payload: string; binary?: boolean }
/** shape chosen by M2-0; the feature package may refine — `params` of a `redis.subscribe` stream. */
export interface RedisSubscribeParams { channels: string[]; patterns: string[] }
/** shape chosen by M2-0; the feature package may refine — `params` of a `redis.monitor` stream (auto-stop, default 10). */
export interface RedisMonitorParams { maxMinutes?: number }

// ---------- MongoDB (PLAN-M2 §6) ----------
// Owner: M2-M (M2-M-E engine, M2-M-U UI). Paths: /api/v1/mongo/{cid}/…, collection routes /mongo/{cid}/db/{db}/coll/{coll}/…

/** Canonical EJSON text of a document or value (parsed client-side). */
export type MongoEjson = string;

export interface MongoTopologyMember { host: string; state: string; health: boolean | null }
/** `GET /mongo/{cid}/server`. */
export interface MongoServerInfo {
  server: ServerInfo;
  type: 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced' | 'unknown';
  /** shape chosen by M2-0; the feature package may refine */
  setName: string | null;
  members: MongoTopologyMember[];
  isAtlas: boolean;
  maxWireVersion: number;
}
/** Item of `GET /mongo/{cid}/databases`. */
export interface MongoDatabaseInfo { name: string; sizeOnDisk: number | null; empty: boolean }
export type MongoCollectionType = 'collection' | 'view' | 'timeseries';
/** Item of `GET /mongo/{cid}/db/{db}/collections`; `count` is filled lazily (`estimatedDocumentCount`). */
export interface MongoCollectionInfo {
  name: string;
  type: MongoCollectionType;
  count?: number | null;
  /** shape chosen by M2-0; the feature package may refine */
  readOnly?: boolean;
  /** Views: source collection. */
  viewOn?: string | null;
}
/** shape chosen by M2-0; the feature package may refine — `GET …/coll/{coll}/stats` (documents view header). */
export interface MongoCollectionStats {
  count: number;
  size: number;
  avgObjSize: number | null;
  storageSize: number | null;
  indexes: number;
  totalIndexSize: number | null;
}

/** `POST …/fields` (sample, nested paths with types, cached 60 s). */
export interface MongoFieldsRequest { sampleSize?: number; filter?: string | null }
export interface MongoFieldPath {
  /** Dot path, e.g. `items.sku`. */
  path: string;
  /** BSON type names seen (`string`, `objectId`, `double`, …). */
  types: string[];
  /** Sampled distinct values (EJSON text) for enumerable fields (≤ 20), else null. */
  values?: MongoEjson[] | null;
}
export interface MongoFieldsResponse { sampled: number; fields: MongoFieldPath[] }

/**
 * `POST …/find`. `filter`/`projection`/`sort`/`collation` are query-bar text (shell JSON with EJSON helpers such as
 * `ObjectId("…")`); the engine rewrites it to EJSON (`ShellJson.cs`).
 */
export interface MongoFindRequest {
  filter: string;
  projection?: string | null;
  sort?: string | null;
  skip: number;
  limit: number;
  collation?: string | null;
  maxTimeMs?: number;
}
export interface MongoFindResponse {
  /** Strings > 32 KB / binary > 8 KB are `$trunc`-ed inside the EJSON; `GET …/doc` returns the full document. */
  docs: MongoEjson[];
  /** `exact: false` when the count fell back to an estimate or timed out. */
  count: { value: number; exact: boolean };
}
/** shape chosen by M2-0; the feature package may refine — `GET …/doc?_id=` (`_id` as EJSON text). */
export interface MongoDocResponse { doc: MongoEjson | null }
/** `POST …/docs`. */
export interface MongoInsertRequest { doc: MongoEjson }
/** shape chosen by M2-0; the feature package may refine */
export interface MongoInsertResponse { insertedId: MongoEjson }
/** `PUT …/docs` (`replaceOne` by `_id`). */
export interface MongoReplaceRequest { _id: MongoEjson; doc: MongoEjson; replace: true }
/** shape chosen by M2-0; the feature package may refine */
export interface MongoReplaceResponse { matched: number; modified: number }
/** `DELETE …/docs` (body). */
export interface MongoDeleteRequest { ids: MongoEjson[] }
/** shape chosen by M2-0; the feature package may refine */
export interface MongoDeleteResponse { deleted: number }

/** `POST …/aggregate`; `previewStage` runs the pipeline up to that stage index. */
export interface MongoAggregateRequest {
  /** One EJSON/shell text per stage. */
  pipeline: string[];
  previewStage?: number | null;
  limit: number;
  skip: number;
  allowDiskUse: boolean;
  maxTimeMs: number;
}
export interface MongoAggregateResponse {
  docs: MongoEjson[];
  truncated: boolean;
  /** M2-M: a preview slice ended in `$out`/`$merge`, which previews never execute (the docs are the stage's input). */
  writeStageSkipped?: boolean;
}

export type MongoExplainVerbosity = 'queryPlanner' | 'executionStats' | 'allPlansExecution';
/** `POST …/explain`. */
export type MongoExplainRequest =
  | ({ kind: 'find'; verbosity: MongoExplainVerbosity } & MongoFindRequest)
  | ({ kind: 'aggregate'; verbosity: MongoExplainVerbosity } & MongoAggregateRequest);
/** Normalised tree for `PlanView`: `op` = stage, `object` = index/collection, `actualRows` = `nReturned`. */
export interface MongoExplainResponse {
  raw: MongoEjson;
  root: PlanNode;
  warnings: string[];
  /** M2-M: headline numbers of the winning plan (Compass "Query performance summary"); stats are null for queryPlanner. */
  summary?: MongoExplainSummary;
}
/** M2-M: summary of an explain (counts from `executionStats`, null when the verbosity has none). */
export interface MongoExplainSummary {
  nReturned: number | null;
  docsExamined: number | null;
  keysExamined: number | null;
  executionTimeMs: number | null;
  /** Index names used by the winning plan. */
  indexes: string[];
  collscan: boolean;
  sortInMemory: boolean;
  rejectedPlans: number;
}

/** `POST …/schema` → job. */
export interface MongoSchemaRequest { sampleSize: number; filter?: string | null }
export interface MongoSchemaField {
  path: string;
  types: { bsonType: string; count: number; pct: number }[];
  probability: number;
  nested: MongoSchemaField[];
  examples: unknown[];
  stats?: { min: unknown; max: unknown; distinct: number };
}
/** `job.done.result` of a schema job. */
export interface MongoSchemaResult { sampled: number; fields: MongoSchemaField[] }

export type MongoIndexKeyType = 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed';
/** shape chosen by M2-0; the feature package may refine — ordered key parts instead of an object (order matters). */
export interface MongoIndexKeyPart { field: string; type: MongoIndexKeyType }
/** Item of `GET …/indexes`. */
export interface MongoIndexInfo {
  name: string;
  key: MongoIndexKeyPart[];
  unique: boolean;
  sparse: boolean;
  ttlSeconds: number | null;
  partialFilter: MongoEjson | null;
  collation: MongoEjson | null;
  size: number | null;
  /** `$indexStats` when permitted. */
  usage: { ops: number; since: string } | null;
}
/** `POST …/indexes`. */
export interface MongoCreateIndexRequest {
  key: MongoIndexKeyPart[];
  options: {
    name?: string | null;
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number | null;
    partialFilterExpression?: string | null;
    collation?: string | null;
  };
}
/** shape chosen by M2-0; the feature package may refine — `jobId` set when the build outlives 2 s (progress via jobs). */
export interface MongoCreateIndexResponse { name: string; jobId: string | null }

/** `GET`/`PUT /mongo/{cid}/db/{db}/profiling` (`db.setProfilingLevel`; PUT is READ_ONLY-guarded). 0 off, 1 slow ops, 2 all. */
export interface MongoProfiling {
  level: 0 | 1 | 2;
  slowms: number;
  sampleRate: number;
}
export interface MongoProfilingRequest {
  level: 0 | 1 | 2;
  slowms?: number;
  sampleRate?: number;
}

/** `GET`/`PUT …/validation` (`collMod`). */
export interface MongoValidation {
  validator: MongoEjson | null;
  level: 'off' | 'strict' | 'moderate';
  action: 'error' | 'warn' | 'errorAndLog';
}

export type MongoExportFormat = 'json' | 'jsonl' | 'csv';
/** `POST …/export` → job (path set) or the file itself (browser mode, path null). */
export interface MongoExportRequest {
  format: MongoExportFormat;
  filter: string;
  projection?: string | null;
  sort?: string | null;
  limit?: number | null;
  fields?: string[];
  path: string | null;
  /** M2-M: JSON/JSONL flavour (default `relaxed`; `canonical` keeps every BSON type for a lossless re-import). */
  ejsonMode?: 'relaxed' | 'canonical';
}
/** shape chosen by M2-0; the feature package may refine */
export interface MongoExportResult { path: string | null; docs: number }

export type MongoCsvColumnType = 'string' | 'number' | 'boolean' | 'date' | 'objectId';
/** `POST …/import` → job; `POST …/import/preview` takes the same body. */
export interface MongoImportRequest {
  format: MongoExportFormat;
  /** Engine-side file path, or `upload` = file text sent by the browser (shape chosen by M2-0). */
  path?: string | null;
  upload?: string | null;
  mode: 'insert' | 'upsert';
  upsertKey: string;
  batchSize: number;
  stopOnError: boolean;
  csv?: {
    header: boolean;
    delimiter: string;
    typeInference: boolean;
    /** shape chosen by M2-0; the feature package may refine — per-column overrides from the preview mapping table. */
    types?: Record<string, MongoCsvColumnType>;
  };
}
/** `POST …/import/preview`: first 20 parsed documents with inferred types. */
export interface MongoImportPreview {
  docs: MongoEjson[];
  /** CSV only. */
  columns: { name: string; inferredType: MongoCsvColumnType }[] | null;
  errors: MongoImportError[];
}
export interface MongoImportError { index: number; message: string }
/** shape chosen by M2-0; the feature package may refine — `job.done.result` (errors: first 100). */
export interface MongoImportResult { inserted: number; upserted: number; failed: number; errors: MongoImportError[] }

/** shape chosen by M2-0; the feature package may refine — `POST /mongo/{cid}/db/{db}/collections`. */
export interface MongoCreateCollectionRequest {
  name: string;
  options?: {
    capped?: boolean;
    size?: number | null;
    max?: number | null;
    timeseries?: { timeField: string; metaField?: string | null; granularity?: 'seconds' | 'minutes' | 'hours' } | null;
    validator?: MongoEjson | null;
    /** View: source collection + pipeline (EJSON text per stage). */
    viewOn?: string | null;
    pipeline?: string[] | null;
  };
}
/** shape chosen by M2-0; the feature package may refine — `POST …/coll/{coll}/rename`. */
export interface MongoRenameCollectionRequest { newName: string; dropTarget: boolean }

/** `mongo.changes` stream item. */
export interface MongoChangeItem {
  ts: string;
  /** `insert` | `update` | `replace` | `delete` | `drop` | `rename` | `dropDatabase` | `invalidate` | newer server kinds. */
  operationType: string;
  ns: { db: string; coll: string | null };
  documentKey: MongoEjson | null;
  fullDocument?: MongoEjson | null;
  /** shape chosen by M2-0; the feature package may refine */
  updateDescription?: { updatedFields: MongoEjson; removedFields: string[] } | null;
}
/** `params` of a `mongo.changes` stream. */
export interface MongoChangesParams { db: string; coll?: string | null; fullDocument: 'updateLookup' | 'default' }

// ---------- Kafka (PLAN-M2 §7) ----------
// Owner: M2-K (M2-K-E engine, M2-K-U UI). Paths: /api/v1/kafka/{cid}/…

/** Deserializers of the message browser (`auto`: magic byte 0 → registry; `{`/`[` → json; else string). */
export type KafkaValueFormat = 'string' | 'json' | 'hex' | 'int32' | 'int64' | 'avro' | 'protobuf' | 'jsonschema' | 'auto';
/** Serializers of produce. */
export type KafkaProduceFormat = 'string' | 'json' | 'hex' | 'avro' | 'protobuf' | 'jsonschema';

export interface KafkaBroker {
  id: number;
  host: string;
  port: number;
  rack: string | null;
  isController: boolean;
  configsAvailable: boolean;
}
/** `GET /kafka/{cid}/cluster`. */
export interface KafkaCluster {
  clusterId: string | null;
  controller: { id: number; host: string } | null;
  brokers: KafkaBroker[];
  topicCount: number;
  partitionCount: number;
  underReplicated: number;
  offlinePartitions: number;
  version: string | null;
}
export interface KafkaConfigSynonym { name: string; value: string | null; source: string }
/** Broker (`GET …/brokers/{id}/configs`) and topic config entries; sensitive values arrive null. */
export interface KafkaConfigEntry {
  name: string;
  value: string | null;
  source: string;
  isDefault: boolean;
  isReadOnly: boolean;
  isSensitive: boolean;
  synonyms: KafkaConfigSynonym[];
}
/** Item of `GET …/topics?includeInternal=`. */
export interface KafkaTopicSummary {
  name: string;
  partitions: number;
  replicationFactor: number;
  internal: boolean;
  underReplicated: number;
  /** Sum of high − low watermarks (lazy). */
  messages?: number | null;
  /** Via `DescribeLogDirs`. */
  size?: number | null;
}
export interface KafkaPartition {
  id: number;
  leader: number | null;
  replicas: number[];
  isr: number[];
  lowOffset: number;
  highOffset: number;
  messages: number;
  size: number | null;
}
/** `GET …/topics/{t}`. */
export interface KafkaTopicDetail {
  /** shape chosen by M2-0; the feature package may refine */
  name: string;
  internal: boolean;
  partitions: KafkaPartition[];
  configs: KafkaConfigEntry[];
}
/** `POST …/topics`. */
export interface KafkaCreateTopicRequest {
  name: string;
  partitions: number;
  replicationFactor: number;
  configs: Record<string, string>;
}
/** `PUT …/topics/{t}/configs` (`IncrementalAlterConfigs`). */
export interface KafkaAlterConfigsRequest { set: Record<string, string>; delete: string[] }
/** `POST …/topics/{t}/partitions` (new total count). */
export interface KafkaAddPartitionsRequest { count: number }
/** `POST …/topics/{t}/purge` (`DeleteRecords` to the high watermark); null/absent = all partitions. */
export interface KafkaPurgeRequest { partitions?: number[] | null }
/** shape chosen by M2-0; the feature package may refine */
export interface KafkaPurgeResult { partitions: { partition: number; lowOffset: number }[] }

/** Where a fetch starts per partition. */
export type KafkaFetchStart =
  | { kind: 'latest'; count: number }
  | { kind: 'oldest' }
  | { kind: 'offset'; offset: number }
  | { kind: 'timestamp'; iso: string };
/** `POST …/topics/{t}/messages` → `202 { jobId, streamId }`. */
export interface KafkaFetchRequest {
  /** null = all partitions. */
  partitions: number[] | null;
  start: KafkaFetchStart;
  limit: number;
  keyFormat: KafkaValueFormat;
  valueFormat: KafkaValueFormat;
  search?: { text: string; caseSensitive: boolean } | null;
  maxBytes?: number;
  timeoutMs?: number;
}
/**
 * shape chosen by M2-0; the feature package may refine — messages arrive as `stream.data` items (`KafkaMessage`) of a
 * `kafka.fetch` stream named by `streamId`; the job ends with `job.done { result: KafkaFetchResult }`.
 */
export interface KafkaFetchStarted { jobId: string; streamId: string }
export interface KafkaFetchResult {
  fetched: number;
  scanned: number;
  /** shape chosen by M2-0; the feature package may refine — partitions that reached their target offset. */
  partitionsDone: number[];
  /** M2-K: the fetch stopped at `timeoutMs` before every partition reached its end. */
  timedOut?: boolean;
  /** M2-K: more matching messages exist (limit or maxBytes reached). */
  truncated?: boolean;
}
/** A decoded key/value/header. `text` null = null payload (tombstone/no key). */
export interface KafkaDecoded {
  format: KafkaValueFormat;
  /** Truncated at 32 KB; "Load full" → `GET …/topics/{t}/messages/{partition}/{offset}`. */
  text: string | M2TruncatedText | null;
  json?: unknown;
  hex?: string;
  schemaId?: number;
  schemaSubject?: string;
  error?: string;
}
export interface KafkaHeader { key: string; value: KafkaDecoded }
/** Fetched/tailed message (also the `kafka.tail` / `kafka.fetch` stream item). */
export interface KafkaMessage {
  topic: string;
  partition: number;
  offset: number;
  timestamp: string;
  timestampType: 'create' | 'logAppend' | 'notAvailable';
  key: KafkaDecoded;
  value: KafkaDecoded;
  headers: KafkaHeader[];
  size: number;
}
/** shape chosen by M2-0; the feature package may refine — query of the single-message endpoint. */
export interface KafkaMessageQuery { keyFormat?: KafkaValueFormat; valueFormat?: KafkaValueFormat }
/** `params` of a `kafka.tail` stream; `offsets` (`"partition" → offset`) is used with `from: 'offsetMap'`. */
export interface KafkaTailParams {
  topic: string;
  partitions: number[] | null;
  from: 'latest' | 'offsetMap';
  offsets?: Record<string, number>;
  keyFormat: KafkaValueFormat;
  valueFormat: KafkaValueFormat;
  filter?: string | null;
}

export interface KafkaProduceMessage {
  key: string | null;
  value: string | null;
  headers?: { key: string; value: string }[];
  /** null/absent = partitioner decides. */
  partition?: number | null;
}
/** `POST …/topics/{t}/produce` (READ_ONLY-guarded). */
export interface KafkaProduceRequest {
  messages: KafkaProduceMessage[];
  keyFormat: KafkaProduceFormat;
  valueFormat: KafkaProduceFormat;
  schema?: { subject: string; version: number | 'latest' } | null;
  /** shape chosen by M2-0; the feature package may refine */
  keySchema?: { subject: string; version: number | 'latest' } | null;
  compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
}
/** One per produced message, in order. */
export interface KafkaProduceResult { partition: number; offset: number; timestamp: string }

export type KafkaGroupState = 'Stable' | 'Empty' | 'Dead' | 'PreparingRebalance' | 'CompletingRebalance' | 'Unknown';
/** Item of `GET …/groups`. */
export interface KafkaGroupSummary {
  groupId: string;
  state: KafkaGroupState;
  protocol: string | null;
  members: number;
  topics: string[];
  /** null when the lag budget (10 s) ran out. */
  lagTotal: number | null;
  coordinator: { id: number; host: string } | null;
}
export interface KafkaGroupMember {
  memberId: string;
  clientId: string;
  host: string;
  assignments: { topic: string; partitions: number[] }[];
}
export interface KafkaGroupPartition {
  topic: string;
  partition: number;
  committed: number | null;
  high: number;
  low: number;
  lag: number | null;
  memberId: string | null;
}
/** `GET …/groups/{g}`. */
export interface KafkaGroupDetail {
  groupId: string;
  state: KafkaGroupState;
  /** shape chosen by M2-0; the feature package may refine */
  protocol: string | null;
  coordinator: { id: number; host: string } | null;
  members: KafkaGroupMember[];
  partitions: KafkaGroupPartition[];
}
/** `POST …/groups/{g}/offsets`: `partitions` or a whole `topic`; 409 GROUP_ACTIVE unless the group is Empty. */
export interface KafkaOffsetResetRequest {
  partitions?: { topic: string; partition: number }[];
  topic?: string;
  /** `value`: offset / shift (number) or ISO timestamp (string). */
  to: { kind: 'earliest' | 'latest' | 'offset' | 'timestamp' | 'shiftBy'; value?: number | string };
  dryRun: boolean;
}
export interface KafkaOffsetResetRow { topic: string; partition: number; from: number | null; to: number }

export type KafkaSchemaType = 'AVRO' | 'PROTOBUF' | 'JSON';
/** shape chosen by M2-0; the feature package may refine — item of `GET /kafka/{cid}/schemas/subjects`. */
export interface KafkaSchemaSubject {
  subject: string;
  versions?: number[];
  latestVersion?: number | null;
  schemaType?: KafkaSchemaType;
}
/** `GET …/schemas/subjects/{s}/versions/{v}` (`v` may be `latest`). */
export interface KafkaSchemaVersion {
  subject: string;
  version: number;
  id: number;
  schemaType: KafkaSchemaType;
  schema: string;
  references: { name: string; subject: string; version: number }[];
}

// ---------- Logs & activity (PLAN-M2 §8) ----------
// Owner: M2-L. Paths: /api/v1/logs/{cid}/… — `cid = 'engine'` addresses the engine log.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown';
/** Item of `GET /logs/{cid}/sources` (`available:false` + `needs` when the server denied the view). */
export interface LogSourceInfo {
  id: string;
  title: string;
  kind: 'log' | 'activity';
  supportsTail: boolean;
  supportsRange: boolean;
  levels: string[];
  /** Privilege hint (the grant to ask for). */
  needs?: string;
  available: boolean;
  reason?: string;
}
export interface LogEntry {
  ts: string | null;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string | null;
  fields?: Record<string, string>;
  seq: number;
}
/** Body of `POST /logs/{cid}/query`. */
export interface LogQuery {
  sourceId: string;
  from?: string;
  to?: string;
  levels?: string[];
  q?: string;
  /** ≤ 5000. */
  limit: number;
  /** `seq` cursor. */
  before?: number;
  /** SQL Server error log file index. */
  archive?: number;
}
export interface LogQueryResponse { entries: LogEntry[]; hasMore: boolean; truncated: boolean }

export type ActivityKind = 'session' | 'op' | 'lock' | 'client';
export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  user?: string;
  host?: string;
  app?: string;
  database?: string;
  state: string;
  since?: string;
  durationMs?: number;
  waitType?: string;
  blockedBy?: string;
  command?: string;
  text?: string;
  cpu?: number;
  reads?: number;
  canKill: boolean;
  fields?: Record<string, string>;
}
/** `activity.poll` stream item. */
export interface ActivityPollItem { ts: string; sessions: ActivityRow[] }
/** `params` of a `logs.tail` stream. */
export interface LogsTailParams { sourceId: string; levels?: string[]; q?: string }
/** `params` of an `activity.poll` stream. */
export interface ActivityPollParams { intervalMs: number }

/** `POST /logs/{cid}/kill` (danger, READ_ONLY-guarded). */
export interface LogKillRequest {
  id: string;
  kind: ActivityKind;
  /** shape chosen by M2-0; the feature package may refine — PostgreSQL `pg_cancel_backend` vs `pg_terminate_backend`. */
  mode?: 'cancel' | 'terminate';
}
/** shape chosen by M2-0; the feature package may refine */
export interface LogKillResult { killed: boolean; message: string | null }
export type LogExportFormat = 'txt' | 'csv' | 'json';
/** `POST /logs/{cid}/export`: the query plus format; `path` null = the response is the file (browser mode). */
export interface LogExportRequest extends LogQuery {
  format: LogExportFormat;
  path: string | null;
}
/** shape chosen by M2-0; the feature package may refine — `job.done.result` of a log export. */
export interface LogExportResult { path: string | null; entries: number }

// ---------- ER diagram layouts (PLAN-M2 §3) ----------
// Owner: M2-ER. Paths: /api/v1/connections/{cid}/er/layouts…; UI helpers in ./er.ts.

/** What a diagram shows: one schema, or an explicit table set (`schema.table` names). Exactly one of the two is set. */
export interface DiagramScope {
  database: string | null;
  schema?: string | null;
  tables?: string[] | null;
}
/** shape chosen by M2-0; the feature package may refine — the "Auto ▾" layout last applied. */
export type DiagramAutoLayout = 'layered-lr' | 'layered-tb' | 'grid';
/** Saved per (connection, database, scope key); `GET` returns them, `PUT /{id}` upserts, `DELETE /{id}` removes. */
export interface DiagramLayout {
  id: string;
  scope: DiagramScope;
  /** `"schema.table"` → `[x, y]` in diagram coordinates. */
  positions: Record<string, [number, number]>;
  /** `schema.table` names removed from the diagram. */
  hidden: string[];
  zoom: number;
  /** shape chosen by M2-0; the feature package may refine — `[x, y]` translation. */
  pan: [number, number];
  updatedAt: string;
  auto?: DiagramAutoLayout;
  /** M2-ER: `schema.table` names added to the scope ("Add tables…", ghost click, "Show related"). */
  added?: string[] | null;
  /** M2-ER: cards whose position an auto layout keeps. */
  pinned?: string[] | null;
  /** M2-ER: view options (column mode, types, filters); opaque to the engine. */
  options?: DiagramViewOptions | null;
}
/** M2-ER: what the cards show and which tables are filtered out. */
export interface DiagramViewOptions {
  columns?: 'all' | 'keys' | 'none';
  types?: boolean;
  onlyConnected?: boolean;
  hideViews?: boolean;
  details?: boolean;
}
/** Query of `GET /connections/{cid}/er/layouts`; `scope` is a scope key (see `layoutScopeKey` in ./er.ts). */
export interface DiagramLayoutQuery { database?: string | null; scope?: string | null }

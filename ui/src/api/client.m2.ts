// M2 feature namespaces of the REST client (`api.redis.*`, `api.mongo.*`, `api.kafka.*`, `api.logs.*`, `api.er.*`).
// Bodies follow the endpoint tables of docs/PLAN-M2.md sections 3–8; wire types are in ./types.m2.ts.
// Each feature package owns its namespace below (append, keep signatures backward compatible).
// Common errors: 503 SOURCE_UNAVAILABLE (client cannot connect), 403 READ_ONLY (writes on a read-only profile),
// 403 PRIVILEGE (`detail.needs`), 400 VALIDATION (names the field). Long operations return `202 { jobId }`
// (progress via `job.progress` / `job.done`; cancel with `api.cancelJob`).
import type { FileResponse, M2Http } from './client';
import type { JobStarted } from './types';
import type {
  // Redis
  RedisAnalysisRequest, RedisClientInfo, RedisClientKillRequest, RedisCommandsRequest, RedisCommandsResponse,
  RedisConfigResponse, RedisConfigSetRequest, RedisCreateKeyRequest, RedisDeletePatternRequest, RedisGetKeyQuery,
  RedisHashEditRequest, RedisInfoResponse, RedisJsonSetRequest, RedisKeyValue, RedisListEditRequest,
  RedisMemoryRequest, RedisMemoryResponse, RedisPublishRequest, RedisPublishResponse, RedisRenameRequest,
  RedisScanRequest, RedisScanResponse, RedisServerInfo, RedisSetEditRequest, RedisSetStringRequest,
  RedisSlowlogEntry, RedisStreamEditRequest, RedisTtlRequest, RedisZsetEditRequest,
  // Mongo
  MongoAggregateRequest, MongoAggregateResponse, MongoCollectionInfo, MongoCollectionStats,
  MongoCreateCollectionRequest, MongoCreateIndexRequest, MongoCreateIndexResponse, MongoDatabaseInfo,
  MongoDeleteRequest, MongoDeleteResponse, MongoDocResponse, MongoEjson, MongoExplainRequest, MongoExplainResponse,
  MongoExportRequest, MongoFieldsRequest, MongoFieldsResponse, MongoFindRequest, MongoFindResponse,
  MongoImportPreview, MongoImportRequest, MongoIndexInfo, MongoInsertRequest, MongoInsertResponse,
  MongoRenameCollectionRequest, MongoReplaceRequest, MongoReplaceResponse, MongoSchemaRequest, MongoServerInfo,
  MongoValidation,
  // Kafka
  KafkaAddPartitionsRequest, KafkaAlterConfigsRequest, KafkaCluster, KafkaConfigEntry, KafkaCreateTopicRequest,
  KafkaFetchRequest, KafkaFetchStarted, KafkaGroupDetail, KafkaGroupSummary, KafkaMessage, KafkaMessageQuery,
  KafkaOffsetResetRequest, KafkaOffsetResetRow, KafkaProduceRequest, KafkaProduceResult, KafkaPurgeRequest,
  KafkaPurgeResult, KafkaSchemaSubject, KafkaSchemaVersion, KafkaTopicDetail, KafkaTopicSummary,
  // Logs
  LogExportRequest, LogKillRequest, LogKillResult, LogQuery, LogQueryResponse, LogSourceInfo,
  // ER
  DiagramLayout, DiagramLayoutQuery,
} from './types';

/** Connection id of the engine's own log in `api.logs.*` (`GET /logs/engine/sources`, …). */
export const ENGINE_LOG_CID = 'engine';

export function createM2Namespaces(http: M2Http) {
  const enc = http.enc;
  const json = http.json;

  /** POST that answers `202 { jobId }` (engine writes the file) or, in browser mode (`path: null`), the file itself. */
  async function jobOrFile(path: string, body: unknown): Promise<JobStarted | FileResponse> {
    const res = await http.send('POST', path, { body });
    const type = res.headers.get('Content-Type') ?? '';
    if (res.status === 202 || type.includes('application/json')) return (await res.json()) as JobStarted;
    return { blob: await res.blob(), filename: http.filenameFrom(res) };
  }


  return {
    // ---------- Redis (PLAN-M2 §5; owner M2-R). Key routes carry `?db=`; writes are READ_ONLY-guarded. ----------
    redis: {
      /** Server info + `modules` (`MODULE LIST`), mode, keyspace counts. */
      server: (cid: string) => json<RedisServerInfo>('GET', `/redis/${enc(cid)}/server`),
      scan: (cid: string, req: RedisScanRequest, signal?: AbortSignal) =>
        json<RedisScanResponse>('POST', `/redis/${enc(cid)}/keys/scan`, { body: req, signal }),
      /** `MEMORY USAGE` for visible rows (≤ 100 keys; endpoint shape chosen by M2-0). */
      memory: (cid: string, req: RedisMemoryRequest, signal?: AbortSignal) =>
        json<RedisMemoryResponse>('POST', `/redis/${enc(cid)}/keys/memory`, { body: req, signal }),
      /** Typed value (discriminated on `type`); 404 NOT_FOUND when the key is gone. */
      getKey: (cid: string, key: string, q: RedisGetKeyQuery, signal?: AbortSignal) =>
        json<RedisKeyValue>('GET', `/redis/${enc(cid)}/keys/${enc(key)}`, {
          query: { db: q.db, cursor: q.cursor, count: q.count, field: q.field, start: q.start, stop: q.stop },
          signal,
        }),
      setString: (cid: string, db: number, key: string, body: RedisSetStringRequest) =>
        json<void>('PUT', `/redis/${enc(cid)}/keys/${enc(key)}/string`, { query: { db }, body }),
      editHash: (cid: string, db: number, key: string, body: RedisHashEditRequest) =>
        json<void>('POST', `/redis/${enc(cid)}/keys/${enc(key)}/hash`, { query: { db }, body }),
      editList: (cid: string, db: number, key: string, body: RedisListEditRequest) =>
        json<void>('POST', `/redis/${enc(cid)}/keys/${enc(key)}/list`, { query: { db }, body }),
      editSet: (cid: string, db: number, key: string, body: RedisSetEditRequest) =>
        json<void>('POST', `/redis/${enc(cid)}/keys/${enc(key)}/set`, { query: { db }, body }),
      editZset: (cid: string, db: number, key: string, body: RedisZsetEditRequest) =>
        json<void>('POST', `/redis/${enc(cid)}/keys/${enc(key)}/zset`, { query: { db }, body }),
      editStream: (cid: string, db: number, key: string, body: RedisStreamEditRequest) =>
        json<void>('POST', `/redis/${enc(cid)}/keys/${enc(key)}/stream`, { query: { db }, body }),
      /** `JSON.SET` (ReJSON module required, else 400 NOT_SUPPORTED). */
      setJson: (cid: string, db: number, key: string, body: RedisJsonSetRequest) =>
        json<void>('PUT', `/redis/${enc(cid)}/keys/${enc(key)}/json`, { query: { db }, body }),
      createKey: (cid: string, body: RedisCreateKeyRequest) => json<void>('POST', `/redis/${enc(cid)}/keys`, { body }),
      /** Cluster: 400 when the new key hashes to another slot. */
      renameKey: (cid: string, db: number, key: string, body: RedisRenameRequest) =>
        json<void>('POST', `/redis/${enc(cid)}/keys/${enc(key)}/rename`, { query: { db }, body }),
      /** `seconds: null` = PERSIST. */
      setTtl: (cid: string, db: number, key: string, body: RedisTtlRequest) =>
        json<void>('PUT', `/redis/${enc(cid)}/keys/${enc(key)}/ttl`, { query: { db }, body }),
      /** UNLINK. */
      deleteKey: (cid: string, db: number, key: string) => json<void>('DELETE', `/redis/${enc(cid)}/keys/${enc(key)}`, { query: { db } }),
      /** 202 { jobId }; `job.done.result`: RedisDeletePatternResult. */
      deletePattern: (cid: string, body: RedisDeletePatternRequest) =>
        json<JobStarted>('POST', `/redis/${enc(cid)}/keys/delete-pattern`, { body }),
      /** 400 VALIDATION for blocked commands (MONITOR, SUBSCRIBE…); READ_ONLY for `@write` commands on read-only profiles. */
      commands: (cid: string, body: RedisCommandsRequest, signal?: AbortSignal) =>
        json<RedisCommandsResponse>('POST', `/redis/${enc(cid)}/commands`, { body, signal }),
      publish: (cid: string, body: RedisPublishRequest) =>
        json<RedisPublishResponse>('POST', `/redis/${enc(cid)}/publish`, { body }),
      slowlog: (cid: string, count = 128) => json<RedisSlowlogEntry[]>('GET', `/redis/${enc(cid)}/slowlog`, { query: { count } }),
      /** `SLOWLOG RESET` (danger; route chosen by M2-0). */
      resetSlowlog: (cid: string) => json<void>('POST', `/redis/${enc(cid)}/slowlog/reset`),
      /** `CONFIG GET pattern`, e.g. `slowlog-log-slower-than` (route chosen by M2-0). */
      config: (cid: string, pattern: string) => json<RedisConfigResponse>('GET', `/redis/${enc(cid)}/config`, { query: { pattern } }),
      /** `CONFIG SET` (READ_ONLY-guarded; route chosen by M2-0). */
      setConfig: (cid: string, body: RedisConfigSetRequest) => json<void>('PUT', `/redis/${enc(cid)}/config`, { body }),
      info: (cid: string) => json<RedisInfoResponse>('GET', `/redis/${enc(cid)}/info`),
      /** `CLIENT LIST` (route chosen by M2-0). */
      clients: (cid: string) => json<RedisClientInfo[]>('GET', `/redis/${enc(cid)}/clients`),
      /** `CLIENT KILL ID` (danger; route chosen by M2-0). */
      killClient: (cid: string, body: RedisClientKillRequest) => json<void>('POST', `/redis/${enc(cid)}/clients/kill`, { body }),
      /** 202 { jobId }; `job.done.result`: RedisAnalysisResult. */
      analysis: (cid: string, body: RedisAnalysisRequest) => json<JobStarted>('POST', `/redis/${enc(cid)}/analysis`, { body }),
    },

    // ---------- MongoDB (PLAN-M2 §6; owner M2-M). Writes are READ_ONLY-guarded. ----------
    mongo: {
      server: (cid: string) => json<MongoServerInfo>('GET', `/mongo/${enc(cid)}/server`),
      databases: (cid: string) => json<MongoDatabaseInfo[]>('GET', `/mongo/${enc(cid)}/databases`),
      collections: (cid: string, db: string) => json<MongoCollectionInfo[]>('GET', `/mongo/${enc(cid)}/db/${enc(db)}/collections`),
      /** Documents view header (route chosen by M2-0). */
      stats: (cid: string, db: string, coll: string) => json<MongoCollectionStats>('GET', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/stats`),
      fields: (cid: string, db: string, coll: string, body: MongoFieldsRequest = {}, signal?: AbortSignal) =>
        json<MongoFieldsResponse>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/fields`, { body, signal }),
      /** 400 VALIDATION when the filter/projection/sort text does not parse. */
      find: (cid: string, db: string, coll: string, body: MongoFindRequest, signal?: AbortSignal) =>
        json<MongoFindResponse>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/find`, { body, signal }),
      /** Full (untruncated) document; `id` = `_id` as EJSON text. */
      doc: (cid: string, db: string, coll: string, id: MongoEjson) =>
        json<MongoDocResponse>('GET', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/doc`, { query: { _id: id } }),
      insert: (cid: string, db: string, coll: string, body: MongoInsertRequest) =>
        json<MongoInsertResponse>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/docs`, { body }),
      replace: (cid: string, db: string, coll: string, body: MongoReplaceRequest) =>
        json<MongoReplaceResponse>('PUT', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/docs`, { body }),
      deleteDocs: (cid: string, db: string, coll: string, body: MongoDeleteRequest) =>
        json<MongoDeleteResponse>('DELETE', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/docs`, { body }),
      explain: (cid: string, db: string, coll: string, body: MongoExplainRequest, signal?: AbortSignal) =>
        json<MongoExplainResponse>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/explain`, { body, signal }),
      /** Write stages (`$merge`/`$out`) are READ_ONLY-guarded. */
      aggregate: (cid: string, db: string, coll: string, body: MongoAggregateRequest, signal?: AbortSignal) =>
        json<MongoAggregateResponse>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/aggregate`, { body, signal }),
      /** 202 { jobId }; `job.done.result`: MongoSchemaResult. */
      schema: (cid: string, db: string, coll: string, body: MongoSchemaRequest) =>
        json<JobStarted>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/schema`, { body }),
      indexes: (cid: string, db: string, coll: string) => json<MongoIndexInfo[]>('GET', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/indexes`),
      createIndex: (cid: string, db: string, coll: string, body: MongoCreateIndexRequest) =>
        json<MongoCreateIndexResponse>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/indexes`, { body }),
      dropIndex: (cid: string, db: string, coll: string, name: string) =>
        json<void>('DELETE', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/indexes/${enc(name)}`),
      validation: (cid: string, db: string, coll: string) => json<MongoValidation>('GET', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/validation`),
      setValidation: (cid: string, db: string, coll: string, body: MongoValidation) =>
        json<MongoValidation>('PUT', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/validation`, { body }),
      /** 202 { jobId } (`job.done.result`: MongoExportResult) or, with `path: null`, the file. */
      exportDocs: (cid: string, db: string, coll: string, body: MongoExportRequest) =>
        jobOrFile(`/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/export`, body),
      /** 202 { jobId }; `job.done.result`: MongoImportResult. */
      importDocs: (cid: string, db: string, coll: string, body: MongoImportRequest) =>
        json<JobStarted>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/import`, { body }),
      importPreview: (cid: string, db: string, coll: string, body: MongoImportRequest, signal?: AbortSignal) =>
        json<MongoImportPreview>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/import/preview`, { body, signal }),
      createCollection: (cid: string, db: string, body: MongoCreateCollectionRequest) =>
        json<void>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/collections`, { body }),
      renameCollection: (cid: string, db: string, coll: string, body: MongoRenameCollectionRequest) =>
        json<void>('POST', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}/rename`, { body }),
      dropCollection: (cid: string, db: string, coll: string) => json<void>('DELETE', `/mongo/${enc(cid)}/db/${enc(db)}/coll/${enc(coll)}`),
      dropDatabase: (cid: string, db: string) => json<void>('DELETE', `/mongo/${enc(cid)}/db/${enc(db)}`),
    },

    // ---------- Kafka (PLAN-M2 §7; owner M2-K). Produce/create/delete/offset reset are READ_ONLY-guarded. ----------
    kafka: {
      cluster: (cid: string) => json<KafkaCluster>('GET', `/kafka/${enc(cid)}/cluster`),
      brokerConfigs: (cid: string, brokerId: number) =>
        json<KafkaConfigEntry[]>('GET', `/kafka/${enc(cid)}/brokers/${brokerId}/configs`),
      topics: (cid: string, includeInternal = false) =>
        json<KafkaTopicSummary[]>('GET', `/kafka/${enc(cid)}/topics`, { query: { includeInternal: includeInternal ? 'true' : undefined } }),
      topic: (cid: string, topic: string) => json<KafkaTopicDetail>('GET', `/kafka/${enc(cid)}/topics/${enc(topic)}`),
      createTopic: (cid: string, body: KafkaCreateTopicRequest) => json<void>('POST', `/kafka/${enc(cid)}/topics`, { body }),
      alterTopicConfigs: (cid: string, topic: string, body: KafkaAlterConfigsRequest) =>
        json<void>('PUT', `/kafka/${enc(cid)}/topics/${enc(topic)}/configs`, { body }),
      addPartitions: (cid: string, topic: string, body: KafkaAddPartitionsRequest) =>
        json<void>('POST', `/kafka/${enc(cid)}/topics/${enc(topic)}/partitions`, { body }),
      deleteTopic: (cid: string, topic: string) => json<void>('DELETE', `/kafka/${enc(cid)}/topics/${enc(topic)}`),
      /** `DeleteRecords` to the high watermark (danger). */
      purgeTopic: (cid: string, topic: string, body: KafkaPurgeRequest = {}) =>
        json<KafkaPurgeResult>('POST', `/kafka/${enc(cid)}/topics/${enc(topic)}/purge`, { body }),
      /** 202 { jobId, streamId }: messages arrive on the `kafka.fetch` stream; `job.done.result`: KafkaFetchResult. */
      fetchMessages: (cid: string, topic: string, body: KafkaFetchRequest) =>
        json<KafkaFetchStarted>('POST', `/kafka/${enc(cid)}/topics/${enc(topic)}/messages`, { body }),
      /** One full (untruncated) message. */
      message: (cid: string, topic: string, partition: number, offset: number, q: KafkaMessageQuery = {}) =>
        json<KafkaMessage>('GET', `/kafka/${enc(cid)}/topics/${enc(topic)}/messages/${partition}/${offset}`, {
          query: { keyFormat: q.keyFormat, valueFormat: q.valueFormat },
        }),
      produce: (cid: string, topic: string, body: KafkaProduceRequest) =>
        json<KafkaProduceResult[]>('POST', `/kafka/${enc(cid)}/topics/${enc(topic)}/produce`, { body }),
      groups: (cid: string) => json<KafkaGroupSummary[]>('GET', `/kafka/${enc(cid)}/groups`),
      group: (cid: string, groupId: string) => json<KafkaGroupDetail>('GET', `/kafka/${enc(cid)}/groups/${enc(groupId)}`),
      /** 409 GROUP_ACTIVE (detail: members) unless the group is Empty; `dryRun` only previews. */
      resetOffsets: (cid: string, groupId: string, body: KafkaOffsetResetRequest) =>
        json<KafkaOffsetResetRow[]>('POST', `/kafka/${enc(cid)}/groups/${enc(groupId)}/offsets`, { body }),
      deleteGroup: (cid: string, groupId: string) => json<void>('DELETE', `/kafka/${enc(cid)}/groups/${enc(groupId)}`),
      /** 400 NOT_SUPPORTED when no Schema Registry is configured. */
      schemaSubjects: (cid: string) => json<KafkaSchemaSubject[]>('GET', `/kafka/${enc(cid)}/schemas/subjects`),
      schemaVersion: (cid: string, subject: string, version: number | 'latest' = 'latest') =>
        json<KafkaSchemaVersion>('GET', `/kafka/${enc(cid)}/schemas/subjects/${enc(subject)}/versions/${enc(String(version))}`),
    },

    // ---------- Logs & activity (PLAN-M2 §8; owner M2-L). `cid` may be ENGINE_LOG_CID. ----------
    logs: {
      sources: (cid: string) => json<LogSourceInfo[]>('GET', `/logs/${enc(cid)}/sources`),
      /** 403 PRIVILEGE (`detail.needs`) when the server denies the source. */
      query: (cid: string, body: LogQuery, signal?: AbortSignal) =>
        json<LogQueryResponse>('POST', `/logs/${enc(cid)}/query`, { body, signal }),
      /** Danger; READ_ONLY on read-only profiles. */
      kill: (cid: string, body: LogKillRequest) => json<LogKillResult>('POST', `/logs/${enc(cid)}/kill`, { body }),
      /** 202 { jobId } (`job.done.result`: LogExportResult) or, with `path: null`, the file. */
      export: (cid: string, body: LogExportRequest) => jobOrFile(`/logs/${enc(cid)}/export`, body),
    },

    // ---------- ER diagram layouts (PLAN-M2 §3; owner M2-ER) ----------
    er: {
      /** `scope` is a scope key (`layoutScopeKey` in ./er.ts). */
      layouts: (cid: string, q: DiagramLayoutQuery = {}) =>
        json<DiagramLayout[]>('GET', `/connections/${enc(cid)}/er/layouts`, { query: { database: q.database, scope: q.scope } }),
      /** Upsert by id. */
      saveLayout: (cid: string, layout: DiagramLayout) =>
        json<DiagramLayout>('PUT', `/connections/${enc(cid)}/er/layouts/${enc(layout.id)}`, { body: layout }),
      deleteLayout: (cid: string, id: string) => json<void>('DELETE', `/connections/${enc(cid)}/er/layouts/${enc(id)}`),
    },
  };
}

// Wire types of the Elasticsearch / OpenSearch module (plan-batch3 WP-ES): `/api/v1/es/{cid}/…` of
// engine/src/DbStudio.Sources.Elasticsearch (Endpoints/EsEndpoints.cs). JSON is camelCase; `unknown` fields carry the
// server's JSON as is (mappings, settings, query DSL, aggregations, _source). Type-only module (no runtime code).

export type EsFlavor = 'elasticsearch' | 'opensearch';
export type EsHealth = 'green' | 'yellow' | 'red';

/** `GET /es/{cid}/cluster`: `GET /` + `_cluster/health` + `_cluster/stats` (the stats part is null when denied). */
export interface EsCluster {
  clusterName: string;
  clusterUuid: string | null;
  flavor: EsFlavor;
  /** Product version ("8.15.3", "2.17.1"). */
  version: string;
  luceneVersion: string | null;
  status: EsHealth;
  timedOut: boolean;
  nodes: number;
  dataNodes: number;
  activePrimaryShards: number;
  activeShards: number;
  relocatingShards: number;
  initializingShards: number;
  unassignedShards: number;
  activeShardsPercent: number;
  pendingTasks: number;
  indices: number | null;
  docs: number | null;
  storeBytes: number | null;
  jvmHeapUsedBytes: number | null;
  jvmHeapMaxBytes: number | null;
  fsTotalBytes: number | null;
  fsAvailableBytes: number | null;
}

/** `GET /es/{cid}/nodes` (`_cat/nodes`). */
export interface EsNode {
  id: string;
  name: string;
  ip: string | null;
  /** Expanded role names ("master", "data", "ingest", "ml"…). */
  roles: string[];
  /** The elected master. */
  master: boolean;
  version: string | null;
  heapPercent: number | null;
  ramPercent: number | null;
  cpu: number | null;
  load1m: number | null;
  diskUsedPercent: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  uptime: string | null;
}

/** `GET /es/{cid}/indices?hidden=` (`_cat/indices` + `_cat/aliases` + `index.hidden` / creation date settings). */
export interface EsIndexSummary {
  name: string;
  uuid: string | null;
  health: EsHealth | null;
  status: 'open' | 'close';
  primaries: number;
  replicas: number;
  docsCount: number | null;
  docsDeleted: number | null;
  storeBytes: number | null;
  priStoreBytes: number | null;
  /** `index.hidden` or a dot-prefixed name. */
  hidden: boolean;
  /** System index (dot-prefixed and not a data stream backing index). */
  system: boolean;
  aliases: string[];
  /** Data stream this index backs (`.ds-…`), or null. */
  dataStream: string | null;
  /** ISO time from `index.creation_date`. */
  createdAt: string | null;
}

/** `GET /es/{cid}/aliases` (`_cat/aliases`). */
export interface EsAlias {
  alias: string;
  index: string;
  filter: boolean;
  indexRouting: string | null;
  searchRouting: string | null;
  isWriteIndex: boolean | null;
}

/** `GET /es/{cid}/datastreams` (`_data_stream`; empty when unsupported). */
export interface EsDataStream {
  name: string;
  status: EsHealth | null;
  template: string | null;
  generation: number;
  timestampField: string | null;
  indices: string[];
}

/** `GET /es/{cid}/templates`: composable, component and legacy templates. */
export interface EsTemplate {
  name: string;
  kind: 'index' | 'component' | 'legacy';
  patterns: string[];
  priority: number | null;
  version: number | null;
  dataStream: boolean;
  composedOf: string[];
  /** The template as the server returns it. */
  body: unknown;
}

export interface EsShard {
  shard: number;
  /** 'p' primary, 'r' replica. */
  prirep: 'p' | 'r';
  state: string;
  docs: number | null;
  storeBytes: number | null;
  ip: string | null;
  node: string | null;
  unassignedReason: string | null;
}

/** `GET /es/{cid}/indices/{index}`: `GET /{index}` + `_cat/shards` + `_stats` of one concrete index. */
export interface EsIndexDetail {
  name: string;
  mappings: unknown;
  settings: unknown;
  aliases: unknown;
  summary: EsIndexSummary | null;
  shards: EsShard[];
  /** `_stats` `{ primaries, total }` (raw). */
  stats: { primaries: unknown; total: unknown } | null;
}

/** `GET /es/{cid}/indices/{index}/fields` (index may be a pattern or alias): the flattened mapping. */
export interface EsField {
  /** Dotted path ("customer.name", "name.keyword"). */
  path: string;
  type: string;
  /** Multi-field parent ("name" for "name.keyword"), else null. */
  parent: string | null;
  searchable: boolean;
  aggregatable: boolean;
}

/** `POST /es/{cid}/search`: the DSL body passes through; the engine sets `seq_no_primary_term` and caps `size`. */
export interface EsSearchRequest {
  /** Index, alias, pattern or comma list ("shop-*"). */
  index: string;
  /** Query DSL body (`{ query, aggs, sort, _source, highlight… }`). */
  body?: unknown;
  /** Override body.from / body.size. */
  from?: number | null;
  size?: number | null;
  /** `search_after` values (keyset paging of the document grid). */
  searchAfter?: unknown[] | null;
  /** Default true (exact totals). */
  trackTotalHits?: boolean | number | null;
}

export interface EsHit {
  index: string;
  id: string;
  score: number | null;
  seqNo: number | null;
  primaryTerm: number | null;
  version: number | null;
  routing: string | null;
  source: unknown;
  fields: unknown | null;
  highlight: Record<string, string[]> | null;
  sort: unknown[] | null;
  explanation: unknown | null;
  matchedQueries: string[] | null;
}

export interface EsSearchResponse {
  took: number;
  timedOut: boolean;
  total: number | null;
  totalRelation: 'eq' | 'gte';
  maxScore: number | null;
  hits: EsHit[];
  aggregations: unknown | null;
  shards: { total: number; successful: number; skipped: number; failed: number };
  profile: unknown | null;
  /** Round trip measured by the engine. */
  elapsedMs: number;
  /** The requested size was above the cap (10,000) and was lowered. */
  capped: boolean;
  /** The body the engine sent (for "Copy as console request"). */
  request: unknown;
}

/** `GET /es/{cid}/indices/{index}/docs/{id}?routing=`. */
export interface EsDoc {
  index: string;
  id: string;
  found: boolean;
  seqNo: number | null;
  primaryTerm: number | null;
  version: number | null;
  routing: string | null;
  source: unknown;
}

/**
 * `PUT /es/{cid}/indices/{index}/docs/{id}` (index/replace) and `POST /es/{cid}/indices/{index}/docs` (auto id).
 * `ifSeqNo` + `ifPrimaryTerm` = optimistic concurrency: a stale edit answers 409 (code PROVIDER_ERROR,
 * `detail.esType` "version_conflict_engine_exception").
 */
export interface EsPutDocRequest {
  source: unknown;
  ifSeqNo?: number | null;
  ifPrimaryTerm?: number | null;
  routing?: string | null;
  /** `op_type=create`: fail when the id exists. */
  create?: boolean;
  /** Default 'wait_for' (the grid re-reads right after). */
  refresh?: 'true' | 'false' | 'wait_for';
}

export interface EsWriteResult {
  index: string;
  id: string;
  /** created | updated | deleted | noop | not_found. */
  result: string;
  seqNo: number | null;
  primaryTerm: number | null;
  version: number | null;
}

/** `POST /es/{cid}/indices`. */
export interface EsCreateIndexRequest {
  name: string;
  shards?: number | null;
  replicas?: number | null;
  /** `{ settings, mappings, aliases }` merged with shards/replicas. */
  body?: unknown;
}

/** `POST /es/{cid}/indices/{index}/actions/{action}`. */
export type EsIndexAction = 'open' | 'close' | 'refresh' | 'flush' | 'forcemerge' | 'clearcache';

/** `POST /es/{cid}/aliases` (`_aliases`). */
export interface EsAliasAction {
  add?: { index: string; alias: string; filter?: unknown; routing?: string | null; isWriteIndex?: boolean | null };
  remove?: { index: string; alias: string };
}
export interface EsAliasesRequest { actions: EsAliasAction[] }

/** Error detail of a failed Elasticsearch call (ApiError.detail). */
export interface EsErrorDetail {
  /** HTTP status Elasticsearch answered. */
  status: number;
  /** Error type ("index_not_found_exception", "parsing_exception", "version_conflict_engine_exception"…). */
  esType: string | null;
  /** root_cause[0].reason when it differs from the top reason. */
  rootCause: string | null;
}

// ---- jobs (202 { jobId }, then job.progress / job.done)

/** `POST /es/{cid}/reindex` (`_reindex?wait_for_completion=false`, progress from `_tasks/{id}`; cancel → `_tasks/{id}/_cancel`). */
export interface EsReindexRequest {
  source: string;
  dest: string;
  /** Optional query (DSL `query` object) on the source. */
  query?: unknown;
  conflicts?: 'abort' | 'proceed';
  maxDocs?: number | null;
  slices?: number | null;
  /** Painless source of an optional script. */
  script?: string | null;
}
export interface EsReindexResult {
  taskId: string | null;
  total: number;
  created: number;
  updated: number;
  deleted: number;
  versionConflicts: number;
  failures: string[];
  tookMs: number;
}

export type EsFileFormat = 'ndjson' | 'json' | 'csv';

/** `POST /es/{cid}/import`: `_bulk` in chunks; `path` (desktop) or `upload` (the file text, browser). */
export interface EsImportRequest {
  index: string;
  format: EsFileFormat;
  path?: string | null;
  upload?: string | null;
  /** Source field used as `_id` (removed from nothing; the field stays in _source). */
  idField?: string | null;
  /** Documents per `_bulk` request (default 1000; also cut at ~5 MB). */
  batchSize?: number | null;
  pipeline?: string | null;
  csv?: { delimiter?: string; header?: boolean } | null;
}
export interface EsImportResult { indexed: number; failed: number; errors: string[]; tookMs: number }

/** `POST /es/{cid}/export`: scroll through the hits; with `path` a job writes the file, without it the file is the response. */
export interface EsExportRequest {
  index: string;
  format: EsFileFormat;
  /** DSL `query` object (default match_all). */
  query?: unknown;
  /** `_source` includes (CSV columns); default all. */
  fields?: string[] | null;
  max?: number | null;
  path?: string | null;
  /** NDJSON/JSON: wrap documents as `{ _index, _id, _source }` (default false: the bare _source). */
  includeMeta?: boolean;
}
export interface EsExportResult { path: string | null; docs: number }

// ---- SQL

/** `POST /es/{cid}/sql`: Elasticsearch `_sql?format=json` or OpenSearch `_plugins/_sql` (jdbc), normalised. */
export interface EsSqlRequest {
  query: string;
  fetchSize?: number | null;
  /** Next page of a previous response. */
  cursor?: string | null;
}
export interface EsSqlResponse {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  cursor: string | null;
  elapsedMs: number;
}
/** `POST /es/{cid}/sql/translate` → the query DSL of a SQL statement. */
export interface EsSqlTranslateResponse { dsl: unknown }

// ---- Dev Tools console

/**
 * `POST /es/{cid}/console`: one raw request. Methods GET, POST, PUT, DELETE, HEAD; the path must be relative to the
 * cluster (no scheme/host, no `..`). Read-only connections allow GET/HEAD and read-only POST endpoints only
 * (`_search`, `_count`, `_msearch`, `_mget`, `_sql`, `_field_caps`, `_validate/query`, `_explain`, `_analyze`…).
 * Elasticsearch errors are answered here (status ≥ 400 in the body), not as an engine error.
 */
export interface EsConsoleRequest {
  method: string;
  path: string;
  /** JSON or NDJSON text (as typed). */
  body?: string | null;
}
export interface EsConsoleResponse {
  status: number;
  statusText: string;
  elapsedMs: number;
  contentType: string | null;
  /** Response text (JSON pretty-printed). */
  body: string;
  /** The body was cut at 5 MB. */
  truncated: boolean;
}

// ---- tasks

/** `GET /es/{cid}/tasks?actions=&detailed=` (`_tasks`), also the items of the `es.tasks` stream (`{ at, tasks }`). */
export interface EsTask {
  /** "nodeId:taskNumber". */
  id: string;
  node: string;
  action: string;
  type: string;
  description: string | null;
  startTime: string;
  runningTimeMs: number;
  cancellable: boolean;
  cancelled: boolean;
  parentTaskId: string | null;
  /** Task status (reindex/update-by-query progress: total, created, updated, deleted, batches…). */
  status: unknown | null;
}
export interface EsTasksStreamItem { at: string; tasks: EsTask[] }

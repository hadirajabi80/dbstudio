// ClickHouse dialect spec (plan-batch3 WP-CH), loaded lazily by dialect/registry.ts (D7).
// Rules for this chunk (and every file only it imports: format/rules/clickhouse, data/clickhouse-*.json):
// - no runtime import from the shell / intel / format modules (type imports are fine): use the kit arguments instead
//   (DialectKit here, FormatKit in the rules factory), else the initial bundle re-partitions;
// - lazy-only shared helpers are fine: ../lexer/traits (traitLexer);
// - export `define` (DialectDefine).
//
// ClickHouse specifics: identifiers are case-sensitive but most keywords are not, so names resolve case-insensitively
// ('insensitive'); `database`, `table`, `default`, `partition`, `rows`, `engine`… are everyday column/database names in
// ClickHouse (system.parts, the `default` database), so they are contextual keywords (highlighted, never reserved).
// Statements end at semicolons (the default splitter). Query parameters are `{name:Type}` (also :name / @name, which
// the engine rewrites).
import type { CompletionItem, StatementKind, Token } from '../types';
import type { CursorContext } from '../context/context';
import type { CompleteEnv, ExtraCompletionSource } from '../complete/completer';
import type { DialectDefine, DialectSpec, FunctionCatalogJson, LexTraits, SnippetDef, SystemCatalogJson } from './spec';
import catalog from './data/clickhouse-functions.json';
import system from './data/clickhouse-system.json';
import { traitLexer } from '../lexer/traits';
import { clickhouseRules } from '../../format/rules/clickhouse';

const LEX: LexTraits = { backtickIdent: true, hashComment: true, backslashEscapes: true, braceParams: true, hexNumbers: true, paramPrefixes: ':@' };

const KEYWORDS = `
  ALL ALTER AND ANTI ANY ARRAY AS ASC ASOF ATTACH BETWEEN BOTH BY CASE CAST CHECK CONSTRAINT CREATE CROSS DEDUPLICATE
  DELETE DESC DESCRIBE DETACH DISTINCT DROP ELSE END EXCEPT EXCHANGE EXISTS EXPLAIN FALSE FINAL FOR FROM FULL GLOBAL
  GRANT GROUP HAVING IF ILIKE IN INNER INSERT INTERSECT INTERVAL INTO IS JOIN KILL LEADING LEFT LIKE LIMIT NOT NULL
  OFFSET ON OPTIMIZE OR ORDER OUTER PASTE PREWHERE PRIMARY RENAME REPLACE REVOKE RIGHT SAMPLE SELECT SEMI SET SETTINGS
  SHOW THEN TO TOTALS TRAILING TRUE TRUNCATE UNION UPDATE USE USING VALUES VIEW WHEN WHERE WITH`;

const CONTEXTUAL = `
  ADD AFTER ALIAS APPLY AUTO_INCREMENT BEFORE CACHE CACHES CASCADE CLEAR CLUSTER CODEC COLLATE COLUMN COLUMNS
  COMMENT CUBE CURRENT DATABASE DATABASES DEFAULT DELAY DEPENDS DICTIONARIES DICTIONARY DISK DISTRIBUTED ENGINE ENGINES
  EPHEMERAL EVENT EVENTS EXTENDED FETCH FETCHES FILL FILESYSTEM FIRST FLUSH FOLLOWING FORMAT FREEZE FUNCTION
  FUNCTIONS GRANULARITY ID IDENTIFIED INDEX INDEXES INHERIT INTERPOLATE KEY KEYS LAST LAYOUT LIFETIME LIVE LOGS
  MATERIALIZE MATERIALIZED MERGES METRICS MODIFY MOVE MOVES MUTATION MUTATIONS NAME NAMED NEXT NO NULLS OPTION OVER
  PARALLEL PART PARTITION PARTITIONS PARTS PERMANENTLY PIPELINE PLAN POLICY POPULATE PRECEDING PROCESSLIST PROFILE
  PROJECTION QUERY QUOTA RANGE RECOMPRESS REFRESH RELOAD REMOVE REPLICA REPLICAS REPLICATED RESET RESTART RESTORE ROLE
  ROLES ROLLUP ROW ROWS SCHEMA SECOND SENDS SERVER SOURCE START STATISTICS STEP STOP SYNC SYNTAX SYSTEM TABLE TABLES TEMPORARY
  TEST TIES TOP TREE TTL TYPE UNBOUNDED UNFREEZE USER USERS UUID VOLUME WATCH WINDOW ZOOKEEPER YEAR MONTH WEEK DAY HOUR
  MINUTE QUARTER NANOSECOND MICROSECOND MILLISECOND RECURSIVE ESTIMATE AST QUERY_TREE CURRENT_ROLE ROLLBACK COMMIT
  TRANSACTION BACKUP ASYNC`;

const STATEMENT_STARTS = `
  SELECT INSERT WITH CREATE ALTER DROP TRUNCATE RENAME EXCHANGE ATTACH DETACH OPTIMIZE SYSTEM KILL SHOW DESCRIBE DESC
  EXPLAIN USE SET EXISTS CHECK GRANT REVOKE DELETE UPDATE WATCH UNDROP BACKUP RESTORE BEGIN COMMIT ROLLBACK`;

// Data types (CamelCase as ClickHouse spells them; matching is case-insensitive).
const DATA_TYPES = `
  UInt8 UInt16 UInt32 UInt64 UInt128 UInt256 Int8 Int16 Int32 Int64 Int128 Int256 Float32 Float64 BFloat16
  Decimal Decimal32 Decimal64 Decimal128 Decimal256 Bool Boolean String FixedString UUID Date Date32 DateTime DateTime64
  Time Time64 Enum Enum8 Enum16 LowCardinality Nullable Array Map Tuple Nested IPv4 IPv6 JSON Object Variant Dynamic
  AggregateFunction SimpleAggregateFunction Point Ring LineString MultiLineString Polygon MultiPolygon Nothing
  IntervalSecond IntervalMinute IntervalHour IntervalDay IntervalWeek IntervalMonth IntervalQuarter IntervalYear`;

/** Table engines offered after `ENGINE =` (insert text, detail). */
export const ENGINES: [string, string, string][] = [
  ['MergeTree', 'MergeTree', 'The main engine: sorted parts merged in the background (ORDER BY required).'],
  ['ReplacingMergeTree', 'ReplacingMergeTree(${1:version})', 'Removes duplicate sorting keys on merge, keeping the highest version.'],
  ['SummingMergeTree', 'SummingMergeTree(${1:columns})', 'Sums numeric columns of rows with the same sorting key on merge.'],
  ['AggregatingMergeTree', 'AggregatingMergeTree', 'Merges AggregateFunction states of rows with the same sorting key.'],
  ['CollapsingMergeTree', 'CollapsingMergeTree(${1:sign})', 'Collapses row pairs whose sign column is 1 / -1.'],
  ['VersionedCollapsingMergeTree', 'VersionedCollapsingMergeTree(${1:sign}, ${2:version})', 'Collapsing with a version column (any insert order).'],
  ['GraphiteMergeTree', "GraphiteMergeTree('${1:config_section}')", 'Rolls up Graphite metrics.'],
  ['CoalescingMergeTree', 'CoalescingMergeTree', 'Keeps the latest non-NULL value of each column per key.'],
  ['ReplicatedMergeTree', "ReplicatedMergeTree('${1:/clickhouse/tables/{shard}/{database}/{table}}', '${2:{replica}}')", 'MergeTree replicated through ZooKeeper/Keeper.'],
  ['ReplicatedReplacingMergeTree', "ReplicatedReplacingMergeTree('${1:path}', '${2:{replica}}'${3:, version})", 'Replicated ReplacingMergeTree.'],
  ['ReplicatedSummingMergeTree', "ReplicatedSummingMergeTree('${1:path}', '${2:{replica}}')", 'Replicated SummingMergeTree.'],
  ['ReplicatedAggregatingMergeTree', "ReplicatedAggregatingMergeTree('${1:path}', '${2:{replica}}')", 'Replicated AggregatingMergeTree.'],
  ['ReplicatedCollapsingMergeTree', "ReplicatedCollapsingMergeTree('${1:path}', '${2:{replica}}', ${3:sign})", 'Replicated CollapsingMergeTree.'],
  ['ReplicatedVersionedCollapsingMergeTree', "ReplicatedVersionedCollapsingMergeTree('${1:path}', '${2:{replica}}', ${3:sign}, ${4:version})", 'Replicated VersionedCollapsingMergeTree.'],
  ['SharedMergeTree', 'SharedMergeTree', 'ClickHouse Cloud MergeTree on shared storage.'],
  ['Log', 'Log', 'Small tables, appended files with marks; no indexes.'],
  ['TinyLog', 'TinyLog', 'Simplest log engine (one file per column).'],
  ['StripeLog', 'StripeLog', 'Log engine with all columns in one file.'],
  ['Memory', 'Memory', 'Data kept in RAM, lost on restart.'],
  ['Buffer', 'Buffer(${1:database}, ${2:table}, ${3:16}, ${4:10}, ${5:100}, ${6:10000}, ${7:1000000}, ${8:10000000}, ${9:100000000})', 'Buffers writes in RAM and flushes them to another table.'],
  ['Distributed', "Distributed(${1:cluster}, ${2:database}, ${3:table}${4:, rand()})", 'Queries a table on every shard of a cluster.'],
  ['Dictionary', 'Dictionary(${1:dictionary})', 'A dictionary as a table.'],
  ['Merge', "Merge(${1:database}, '${2:^table_regexp}')", 'Reads several tables whose names match a regular expression.'],
  ['File', 'File(${1:CSVWithNames})', 'A file in the data directory.'],
  ['URL', "URL('${1:https://…}', ${2:CSV})", 'Data behind a URL.'],
  ['S3', "S3('${1:https://bucket.s3.amazonaws.com/path/*.parquet}', ${2:Parquet})", 'Objects in S3.'],
  ['S3Queue', "S3Queue('${1:path}', ${2:format})", 'Streams new S3 objects into ClickHouse.'],
  ['HDFS', "HDFS('${1:uri}', ${2:format})", 'Files in HDFS.'],
  ['Kafka', "Kafka('${1:host:9092}', '${2:topic}', '${3:group}', '${4:JSONEachRow}')", 'Consumes a Kafka topic (read it with a materialized view).'],
  ['RabbitMQ', 'RabbitMQ', 'Consumes RabbitMQ messages.'],
  ['MySQL', "MySQL('${1:host:3306}', '${2:database}', '${3:table}', '${4:user}', '${5:password}')", 'A remote MySQL table.'],
  ['PostgreSQL', "PostgreSQL('${1:host:5432}', '${2:database}', '${3:table}', '${4:user}', '${5:password}')", 'A remote PostgreSQL table.'],
  ['MongoDB', "MongoDB('${1:host:27017}', '${2:database}', '${3:collection}', '${4:user}', '${5:password}')", 'A remote MongoDB collection.'],
  ['Redis', "Redis('${1:host:6379}', ${2:0})", 'A Redis key space.'],
  ['JDBC', 'JDBC(${1:datasource}, ${2:schema}, ${3:table})', 'A table over the JDBC bridge.'],
  ['ODBC', 'ODBC(${1:connection}, ${2:database}, ${3:table})', 'A table over ODBC.'],
  ['EmbeddedRocksDB', 'EmbeddedRocksDB', 'Key-value table in RocksDB (PRIMARY KEY required).'],
  ['Null', 'Null', 'Discards writes (useful as a materialized view source).'],
  ['Set', 'Set', 'A set kept in RAM for IN.'],
  ['Join', 'Join(${1:ANY}, ${2:LEFT}, ${3:key})', 'A prepared JOIN right side in RAM.'],
  ['GenerateRandom', 'GenerateRandom', 'Random rows of the table structure.'],
  ['View', 'View', 'Stored query (CREATE VIEW).'],
  ['MaterializedView', 'MaterializedView', 'Stored insert trigger (CREATE MATERIALIZED VIEW).'],
  ['Iceberg', "Iceberg('${1:url}')", 'An Apache Iceberg table.'],
  ['DeltaLake', "DeltaLake('${1:url}')", 'A Delta Lake table.'],
  ['TimeSeries', 'TimeSeries', 'Prometheus-compatible time series.'],
];

/** Settings offered after `SETTINGS` (name, doc); query settings first, then MergeTree table settings. */
export const SETTINGS: [string, string][] = [
  ['max_threads', 'Threads used to process a query (default: number of cores).'],
  ['max_memory_usage', 'Memory limit of a query in bytes (0 = unlimited).'],
  ['max_execution_time', 'Time limit of a query in seconds.'],
  ['max_result_rows', 'Row limit of the result.'],
  ['max_result_bytes', 'Byte limit of the result.'],
  ['result_overflow_mode', "'throw' or 'break' when a result limit is hit."],
  ['max_rows_to_read', 'Row limit of what a query reads.'],
  ['max_bytes_to_read', 'Byte limit of what a query reads.'],
  ['read_overflow_mode', "'throw' or 'break' when a read limit is hit."],
  ['max_block_size', 'Rows per block.'],
  ['readonly', '1 = read-only queries only, 2 = read-only but settings may change.'],
  ['join_use_nulls', 'Missing JOIN values become NULL instead of the type default.'],
  ['join_algorithm', "JOIN algorithm: 'hash', 'parallel_hash', 'partial_merge', 'full_sorting_merge', 'grace_hash', 'auto'."],
  ['max_bytes_in_join', 'Memory limit of the JOIN hash table.'],
  ['final', 'Apply FINAL to every table of the query.'],
  ['optimize_move_to_prewhere', 'Move WHERE conditions to PREWHERE automatically.'],
  ['optimize_read_in_order', 'Read in sorting-key order for ORDER BY.'],
  ['optimize_aggregation_in_order', 'Aggregate in sorting-key order for GROUP BY.'],
  ['optimize_skip_unused_shards', 'Skip shards that cannot match the WHERE clause.'],
  ['optimize_throw_if_noop', 'OPTIMIZE throws when it did not merge anything.'],
  ['optimize_use_projections', 'Use projections to answer queries.'],
  ['allow_experimental_analyzer', 'Use the new query analyzer.'],
  ['allow_experimental_json_type', 'Allow the JSON data type.'],
  ['allow_experimental_object_type', "Allow the legacy Object('json') type."],
  ['allow_experimental_variant_type', 'Allow the Variant data type.'],
  ['allow_experimental_dynamic_type', 'Allow the Dynamic data type.'],
  ['allow_experimental_parallel_reading_from_replicas', 'Read one query from several replicas in parallel.'],
  ['allow_experimental_lightweight_update', 'Allow lightweight UPDATE statements.'],
  ['allow_nondeterministic_mutations', 'Allow non-deterministic functions in mutations.'],
  ['mutations_sync', '0 = async, 1 = wait for this replica, 2 = wait for all replicas.'],
  ['alter_sync', '0 = async ALTER, 1 = wait for this replica, 2 = wait for all.'],
  ['lightweight_deletes_sync', 'Wait for lightweight DELETE to finish (0/1/2).'],
  ['insert_quorum', 'Replicas that must confirm an insert.'],
  ['insert_quorum_timeout', 'Quorum write timeout in milliseconds.'],
  ['insert_deduplicate', 'Deduplicate inserted blocks of Replicated tables.'],
  ['async_insert', 'Buffer small inserts on the server and write them in batches.'],
  ['wait_for_async_insert', 'Wait until an asynchronous insert is written.'],
  ['async_insert_busy_timeout_ms', 'Maximum time an async insert buffer waits before flushing.'],
  ['max_insert_block_size', 'Rows per inserted block.'],
  ['max_partitions_per_insert_block', 'Partitions one inserted block may touch.'],
  ['insert_distributed_sync', 'Insert into Distributed tables synchronously.'],
  ['distributed_product_mode', "Subqueries over Distributed tables: 'deny', 'local', 'global', 'allow'."],
  ['prefer_localhost_replica', 'Prefer the local replica of Distributed queries.'],
  ['max_parallel_replicas', 'Replicas used to read one query in parallel.'],
  ['use_query_cache', 'Use the query result cache.'],
  ['query_cache_ttl', 'Seconds a cached result stays valid.'],
  ['use_uncompressed_cache', 'Use the cache of uncompressed blocks.'],
  ['log_queries', 'Log queries to system.query_log.'],
  ['log_comment', 'Comment stored in system.query_log.'],
  ['send_logs_level', "Server log level sent to the client: 'trace', 'debug', 'information', 'warning', 'error', 'none'."],
  ['enable_http_compression', 'Compress HTTP responses.'],
  ['max_query_size', 'Maximum size of the query text in bytes.'],
  ['max_ast_elements', 'Maximum size of the query syntax tree.'],
  ['group_by_overflow_mode', "'throw', 'break' or 'any' when max_rows_to_group_by is hit."],
  ['max_rows_to_group_by', 'Distinct GROUP BY keys allowed.'],
  ['max_bytes_before_external_group_by', 'Spill GROUP BY to disk above this many bytes.'],
  ['max_bytes_before_external_sort', 'Spill ORDER BY to disk above this many bytes.'],
  ['transform_null_in', 'NULL = NULL in IN.'],
  ['aggregate_functions_null_for_empty', 'Aggregates over no rows return NULL.'],
  ['date_time_input_format', "'basic' or 'best_effort' parsing of DateTime input."],
  ['date_time_output_format', "'simple', 'iso' or 'unix_timestamp'."],
  ['session_timezone', 'Time zone of the session.'],
  ['output_format_json_quote_64bit_integers', 'Quote 64-bit integers in JSON output.'],
  ['output_format_json_named_tuples_as_objects', 'Write named tuples as JSON objects.'],
  ['output_format_pretty_max_rows', 'Rows shown by Pretty formats.'],
  ['output_format_csv_crlf_end_of_line', 'CRLF line endings in CSV output.'],
  ['output_format_parquet_compression_method', "Parquet compression: 'lz4', 'snappy', 'zstd', 'gzip', 'none'."],
  ['input_format_skip_unknown_fields', 'Ignore unknown fields in JSON/TSKV input.'],
  ['input_format_allow_errors_num', 'Rows with errors tolerated per input.'],
  ['input_format_allow_errors_ratio', 'Ratio of rows with errors tolerated.'],
  ['input_format_csv_delimiter', 'CSV field delimiter.'],
  ['format_csv_delimiter', 'CSV field delimiter.'],
  ['input_format_null_as_default', 'NULL input becomes the column default for non-Nullable columns.'],
  ['input_format_import_nested_json', 'Read nested JSON objects into Nested columns.'],
  ['schema_inference_make_columns_nullable', 'Inferred columns are Nullable.'],
  ['max_download_threads', 'Threads used to download from URL/S3.'],
  ['s3_truncate_on_insert', 'Overwrite S3 objects on INSERT.'],
  ['cancel_http_readonly_queries_on_client_close', 'Cancel read-only HTTP queries when the client disconnects.'],
  // MergeTree table settings (CREATE TABLE … SETTINGS)
  ['index_granularity', 'MergeTree: rows per primary index mark (default 8192).'],
  ['index_granularity_bytes', 'MergeTree: adaptive granularity target in bytes.'],
  ['min_bytes_for_wide_part', 'MergeTree: parts smaller than this are Compact.'],
  ['min_rows_for_wide_part', 'MergeTree: parts with fewer rows are Compact.'],
  ['ttl_only_drop_parts', 'MergeTree: TTL drops whole parts only.'],
  ['merge_with_ttl_timeout', 'MergeTree: seconds between TTL merges.'],
  ['storage_policy', 'MergeTree: storage policy (disks and volumes).'],
  ['allow_nullable_key', 'MergeTree: allow Nullable columns in the sorting key.'],
  ['parts_to_delay_insert', 'MergeTree: active parts per partition that slow down inserts.'],
  ['parts_to_throw_insert', 'MergeTree: active parts per partition that reject inserts.'],
  ['max_parts_in_total', 'MergeTree: maximum active parts of the table.'],
  ['old_parts_lifetime', 'MergeTree: seconds before merged parts are removed.'],
  ['enable_mixed_granularity_parts', 'MergeTree: allow adaptive granularity.'],
  ['use_minimalistic_part_header_in_zookeeper', 'Replicated: compact part headers in Keeper.'],
  ['min_age_to_force_merge_seconds', 'MergeTree: merge parts older than this regardless of size.'],
  ['deduplicate_merge_projection_mode', "MergeTree: projections on Replacing/Collapsing tables: 'throw', 'drop', 'rebuild'."],
  ['lightweight_mutation_projection_mode', "MergeTree: projections on lightweight deletes: 'throw', 'drop', 'rebuild'."],
  ['compress_marks', 'MergeTree: compress mark files.'],
  ['compress_primary_key', 'MergeTree: compress the primary index.'],
];

/** Formats offered after `FORMAT`. */
export const FORMATS = `
  TabSeparated TabSeparatedRaw TabSeparatedWithNames TabSeparatedWithNamesAndTypes TSV TSVRaw TSVWithNames
  TSVWithNamesAndTypes CSV CSVWithNames CSVWithNamesAndTypes CustomSeparated Values Vertical JSON JSONStrings
  JSONCompact JSONCompactStrings JSONColumns JSONColumnsWithMetadata JSONEachRow JSONEachRowWithProgress
  JSONStringsEachRow JSONCompactEachRow JSONCompactEachRowWithNames JSONCompactEachRowWithNamesAndTypes JSONObjectEachRow
  JSONLines NDJSON TSKV Pretty PrettyCompact PrettyCompactMonoBlock PrettyNoEscapes PrettySpace PrettyMonoBlock Prometheus
  Protobuf ProtobufSingle Avro AvroConfluent Parquet Arrow ArrowStream ORC Npy RowBinary RowBinaryWithNames
  RowBinaryWithNamesAndTypes Native Null XML Markdown MySQLWire PostgreSQLWire CapnProto LineAsString Regexp RawBLOB
  MsgPack Template TemplateIgnoreSpaces SQLInsert BSONEachRow Form`.split(/\s+/).filter(Boolean);

/** Compression codecs offered inside `CODEC(`. */
export const CODECS = ['LZ4', 'LZ4HC', 'ZSTD', 'NONE', 'Delta', 'DoubleDelta', 'Gorilla', 'FPC', 'T64', 'GCD', 'Deflate_qpl', 'AES_128_GCM_SIV', 'AES_256_GCM_SIV'];
/** Dictionary layouts offered inside `LAYOUT(`. */
export const LAYOUTS = ['FLAT()', 'HASHED()', 'SPARSE_HASHED()', 'HASHED_ARRAY()', 'COMPLEX_KEY_HASHED()', 'COMPLEX_KEY_SPARSE_HASHED()', 'COMPLEX_KEY_HASHED_ARRAY()', 'RANGE_HASHED()', 'COMPLEX_KEY_RANGE_HASHED()', 'CACHE(SIZE_IN_CELLS 1000000)', 'COMPLEX_KEY_CACHE(SIZE_IN_CELLS 1000000)', 'SSD_CACHE()', 'DIRECT()', 'COMPLEX_KEY_DIRECT()', 'IP_TRIE()', 'POLYGON()', 'REGEXP_TREE()'];
/** Dictionary sources offered inside `SOURCE(`. */
export const SOURCES = ["CLICKHOUSE(TABLE '${1:table}'${2: DB '${3:db}'})", "MYSQL(HOST '${1:host}' PORT ${2:3306} USER '${3:user}' PASSWORD '${4}' DB '${5:db}' TABLE '${6:table}')", "POSTGRESQL(HOST '${1:host}' PORT ${2:5432} USER '${3:user}' PASSWORD '${4}' DB '${5:db}' TABLE '${6:table}')", "HTTP(URL '${1:url}' FORMAT '${2:JSONEachRow}')", "FILE(PATH '${1:path}' FORMAT '${2:CSV}')", "EXECUTABLE(COMMAND '${1:cmd}' FORMAT '${2:TabSeparated}')", "MONGODB(HOST '${1:host}' PORT ${2:27017} DB '${3:db}' COLLECTION '${4:coll}')", "REDIS(HOST '${1:host}' PORT ${2:6379})", 'NULL()'];

const SNIPPETS: SnippetDef[] = [
  { prefix: 'sel', label: 'sel', body: 'SELECT ${1:*}\nFROM ${2:table}$0', doc: 'SELECT ... FROM' },
  { prefix: 'selw', label: 'selw', body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}$0', doc: 'SELECT ... FROM ... WHERE' },
  { prefix: 'ins', label: 'ins', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})$0', doc: 'INSERT INTO ... VALUES' },
  { prefix: 'mt', label: 'mt', body: 'CREATE TABLE ${1:name}\n(\n\t${2:id} UInt64,\n\t${3:created_at} DateTime DEFAULT now()$0\n)\nENGINE = MergeTree\nPARTITION BY toYYYYMM(${3:created_at})\nORDER BY (${2:id});', doc: 'CREATE TABLE … ENGINE = MergeTree' },
  { prefix: 'rmt', label: 'rmt', body: 'CREATE TABLE ${1:name}\n(\n\t${2:id} UInt64,\n\t${3:version} UInt64$0\n)\nENGINE = ReplacingMergeTree(${3:version})\nORDER BY ${2:id};', doc: 'CREATE TABLE … ENGINE = ReplacingMergeTree' },
  { prefix: 'mv', label: 'mv', body: 'CREATE MATERIALIZED VIEW ${1:name}\nTO ${2:target}\nAS SELECT\n\t${3:*}\nFROM ${4:source}$0;', doc: 'CREATE MATERIALIZED VIEW … TO … AS SELECT' },
  { prefix: 'dict', label: 'dict', body: "CREATE DICTIONARY ${1:name}\n(\n\t${2:id} UInt64,\n\t${3:value} String$0\n)\nPRIMARY KEY ${2:id}\nSOURCE(CLICKHOUSE(TABLE '${4:source_table}'))\nLAYOUT(HASHED())\nLIFETIME(MIN 300 MAX 600);", doc: 'CREATE DICTIONARY … SOURCE … LAYOUT … LIFETIME' },
  { prefix: 'adel', label: 'adel', body: 'ALTER TABLE ${1:table}\nDELETE WHERE ${2:condition}$0;', doc: 'ALTER TABLE … DELETE WHERE (mutation)' },
  { prefix: 'aupd', label: 'aupd', body: 'ALTER TABLE ${1:table}\nUPDATE ${2:column} = ${3:value}\nWHERE ${4:condition}$0;', doc: 'ALTER TABLE … UPDATE … WHERE (mutation)' },
  { prefix: 'opt', label: 'opt', body: 'OPTIMIZE TABLE ${1:table}${2: PARTITION ${3:id}} FINAL$0;', doc: 'OPTIMIZE TABLE … FINAL' },
  { prefix: 'parts', label: 'parts', body: "SELECT partition, name, rows, formatReadableSize(bytes_on_disk) AS size\nFROM system.parts\nWHERE database = currentDatabase() AND table = '${1:table}' AND active\nORDER BY partition, name$0", doc: 'Active parts of a table (system.parts)' },
  { prefix: 'killq', label: 'killq', body: "KILL QUERY WHERE query_id = '${1:query_id}'$0", doc: 'KILL QUERY WHERE query_id = …' },
];

// ---------------------------------------------------------------------------------------------- classify

const sig = (t: Token) => t.kind === 'keyword' || t.kind === 'ident';
const at = (toks: Token[], i: number) => (toks[i] && sig(toks[i]) ? toks[i].upper : '');

/** Index of the first top-level word in [from, …) equal to one of `words`, or -1. */
function findTop(toks: Token[], from: number, words: Set<string>): number {
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'punct') {
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
    } else if (depth === 0 && sig(t) && words.has(t.upper)) return i;
  }
  return -1;
}

const ALTER_ACTIONS = new Set(['DELETE', 'UPDATE', 'DROP', 'CLEAR', 'DETACH', 'MODIFY', 'ADD', 'RENAME', 'MATERIALIZE', 'FREEZE', 'ATTACH', 'REPLACE', 'MOVE', 'COMMENT', 'REMOVE', 'FETCH', 'APPLY']);

/**
 * Statement kinds for the destructive-run guard: mutations (ALTER … DELETE / UPDATE), dropping columns, partitions, parts,
 * indexes and projections, DETACH, KILL, CREATE OR REPLACE and SYSTEM SHUTDOWN/KILL are destructive; SHOW / DESCRIBE /
 * EXISTS / CHECK read; OPTIMIZE and other SYSTEM commands write without destroying.
 */
export function classifyClickHouse(toks: Token[], head: number): StatementKind | undefined {
  const u = at(toks, head);
  const n1 = at(toks, head + 1);
  switch (u) {
    case 'SHOW': case 'DESCRIBE': case 'DESC': case 'EXISTS': case 'CHECK': case 'WATCH': return 'select';
    case 'EXPLAIN': return 'explain';
    case 'OPTIMIZE': case 'EXCHANGE': case 'UNDROP': case 'BACKUP': case 'RESTORE': return 'other';
    case 'ATTACH': return 'other';
    case 'DETACH': return 'drop:destructive';
    case 'KILL': return 'other:destructive';
    case 'SYSTEM': {
      const rest = toks.slice(head + 1, head + 4).map((t) => t.upper).join(' ');
      return /^(SHUTDOWN|KILL|DROP REPLICA|DROP DATABASE REPLICA)/.test(rest) ? 'other:destructive' : 'other';
    }
    case 'BEGIN': case 'COMMIT': case 'ROLLBACK': return 'tx';
    case 'CREATE': {
      if (n1 === 'OR' && at(toks, head + 2) === 'REPLACE') return 'create:destructive';
      return 'create';
    }
    case 'ALTER': {
      if (n1 !== 'TABLE' && n1 !== 'TEMPORARY') return 'alter';
      const action = findTop(toks, head + 2, ALTER_ACTIONS);
      if (action < 0) return 'alter';
      // every top-level action of the ALTER (comma-separated) counts
      let destructive = false;
      let kind: StatementKind = 'alter';
      for (let i = action; i < toks.length; i++) {
        const t = toks[i];
        if (!sig(t)) continue;
        const prev = toks[i - 1];
        const actionStart = i === action || (prev?.kind === 'punct' && prev.text === ',');
        if (!actionStart) continue;
        const a = t.upper;
        if (a === 'DELETE') { destructive = true; kind = 'delete:destructive'; }
        else if (a === 'UPDATE') { destructive = true; if (kind === 'alter') kind = 'update:destructive'; }
        else if (a === 'DROP' || a === 'CLEAR' || a === 'DETACH' || a === 'REPLACE' || (a === 'MOVE' && at(toks, i + 1) === 'PARTITION')) {
          destructive = true;
          if (kind === 'alter') kind = 'drop:destructive';
        }
      }
      return destructive ? kind : 'alter';
    }
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------------------------- completion
// Engines after `ENGINE =`, settings after `SETTINGS`, formats after `FORMAT`, codecs in `CODEC(`, dictionary layouts in
// `LAYOUT(` and sources in `SOURCE(`. Exposed as DialectSpec.complete (wired into the completer by intel/index.ts,
// R3 TODO(WPCH-shared)); the function is self-contained (own prefix matching, no runtime import of the ranker).

function score(prefix: string, label: string): number {
  if (!prefix) return 0;
  const p = prefix.toLowerCase();
  const l = label.toLowerCase();
  if (l === p) return 100;
  if (l.startsWith(p)) return 90 - Math.min(5, Math.floor((l.length - p.length) / 3));
  const segs = label.split(/_|(?<=[a-z0-9])(?=[A-Z])/).map((s) => s.toLowerCase());
  if (segs.some((s) => s.startsWith(p))) return 60;
  if (l.includes(p)) return 50;
  return -1;
}

const sortText = (s: number) => Math.max(0, Math.min(9999999, 9999999 - Math.round(s * 100))).toString().padStart(7, '0');

type Slot = 'engine' | 'setting' | 'format' | 'codec' | 'layout' | 'source';

/** What the cursor completes: the significant tokens before the typed prefix decide. */
export function chSlot(c: CursorContext): Slot | null {
  const toks = c.statement.tokens.filter((t) => t.kind !== 'comment' && t.kind !== 'ws' && t.kind !== 'eof' && t.end <= c.prefixStart);
  const n = toks.length;
  if (!n) return null;
  const last = toks[n - 1];
  const prev = toks[n - 2];
  const isW = (t: Token | undefined, w: string) => !!t && sig(t) && t.upper === w;
  if (last.kind === 'op' && last.text === '=' && isW(prev, 'ENGINE')) return 'engine';
  if (isW(last, 'FORMAT')) return 'format';
  if (last.kind === 'punct' && last.text === '(') {
    if (isW(prev, 'CODEC')) return 'codec';
    if (isW(prev, 'LAYOUT')) return 'layout';
    if (isW(prev, 'SOURCE')) return 'source';
  }
  if (last.kind === 'punct' && last.text === ',') {
    // CODEC(Delta, |) chains codecs
    let depth = 0;
    for (let i = n - 1; i >= 0; i--) {
      const t = toks[i];
      if (t.kind === 'punct' && t.text === ')') depth++;
      else if (t.kind === 'punct' && t.text === '(') {
        if (depth === 0) { if (isW(toks[i - 1], 'CODEC')) return 'codec'; break; }
        depth--;
      }
    }
  }
  // SETTINGS a = 1, b = 2, |  (top level, after the last SETTINGS keyword)
  if (isW(last, 'SETTINGS') || (last.kind === 'punct' && last.text === ',')) {
    let depth = 0;
    for (let i = n - 1; i >= 0; i--) {
      const t = toks[i];
      if (t.kind === 'punct' && t.text === ')') depth++;
      else if (t.kind === 'punct' && t.text === '(') { if (depth === 0) return null; depth--; }
      else if (depth === 0 && isW(t, 'SETTINGS')) return 'setting';
      else if (depth === 0 && sig(t) && t.kind === 'keyword' && !isW(t, 'SETTINGS') && t.upper !== 'TRUE' && t.upper !== 'FALSE' && t.upper !== 'NULL') return null;
    }
  }
  return null;
}

export const chComplete: ExtraCompletionSource = (c: CursorContext, env: CompleteEnv): CompletionItem[] | null => {
  if (c.qualifier) return null;
  const slot = chSlot(c);
  if (!slot) return null;
  const out: CompletionItem[] = [];
  let rank = 1000;
  // curated order breaks ties (MergeTree first)
  const add = (label: string, insertText: string, detail: string, documentation: string | undefined, kind: CompletionItem['kind'], snippet: boolean) => {
    const ms = score(c.prefixText, label);
    rank--;
    if (c.prefixText && ms < 0) return;
    const s = 9000 + ms + rank / 100;
    out.push({ label, kind, detail, documentation, insertText, isSnippet: snippet, sortText: sortText(s), filterText: label, score: s, usageKey: `ch:${slot}:${label}` });
  };
  const kw = (s: string) => (env.opts.keywordCase === 'lower' ? s.toLowerCase() : s);
  switch (slot) {
    case 'engine':
      for (const [name, body, doc] of ENGINES) add(name, body, 'table engine', doc, 'keyword', body.includes('$'));
      break;
    case 'setting':
      for (const [name, doc] of SETTINGS) add(name, `${name} = `, 'setting', doc, 'variable', false);
      break;
    case 'format':
      for (const f of FORMATS) add(f, f, 'format', undefined, 'keyword', false);
      break;
    case 'codec':
      for (const k of CODECS) add(k, k === 'ZSTD' || k === 'LZ4HC' ? `${k}(\${1:1})` : k, 'codec', undefined, 'function', k === 'ZSTD' || k === 'LZ4HC');
      break;
    case 'layout':
      for (const l of LAYOUTS) add(l.replace(/\(.*$/, ''), kw(l), 'dictionary layout', undefined, 'function', false);
      break;
    case 'source':
      for (const s of SOURCES) add(s.replace(/\(.*$/, ''), s, 'dictionary source', undefined, 'function', s.includes('$'));
      break;
  }
  return out;
};

/** ClickHouse spec plus its completion source (DialectSpec.complete once the R3 hook lands; see WP-CH notes). */
export type ClickHouseSpec = DialectSpec & { complete?: ExtraCompletionSource };

export const define: DialectDefine = (kit) => {
  const spec: ClickHouseSpec = kit.buildSpec({
    id: 'clickhouse',
    keywords: KEYWORDS,
    contextual: CONTEXTUAL,
    notAlias: 'FINAL PREWHERE ARRAY GLOBAL ANY ALL ASOF SEMI ANTI PASTE SETTINGS FORMAT LIMIT INTO TOTALS',
    statementStarts: STATEMENT_STARTS,
    dataTypes: DATA_TYPES,
    catalog: catalog as unknown as FunctionCatalogJson,
    systemCatalog: system as unknown as SystemCatalogJson,
    quote: ['`', '`'],
    caseFolding: 'insensitive',
    batchSeparator: null,
    identExtra: '',
    snippets: SNIPPETS,
    selectKeywords: 'DISTINCT, DISTINCT ON, CASE, CAST, NULL, EXISTS, NOT, ALL, ARRAY, TUPLE, INTERVAL, COLUMNS(',
    afterSourceKeywords: `
      WHERE, PREWHERE, FINAL, SAMPLE, ARRAY JOIN, LEFT ARRAY JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN,
      JOIN, ANY LEFT JOIN, ANY INNER JOIN, ASOF JOIN, ASOF LEFT JOIN, LEFT SEMI JOIN, LEFT ANTI JOIN, GLOBAL JOIN,
      PASTE JOIN, GROUP BY, ORDER BY, HAVING, WINDOW, LIMIT, LIMIT BY, OFFSET, SETTINGS, FORMAT, UNION ALL, UNION DISTINCT,
      EXCEPT, INTERSECT, AS`,
    afterExprKeywords: `
      AND, OR, NOT, IN, NOT IN, GLOBAL IN, GLOBAL NOT IN, IS NULL, IS NOT NULL, LIKE, ILIKE, NOT LIKE, BETWEEN, GROUP BY,
      ORDER BY, HAVING, LIMIT, LIMIT BY, WITH TOTALS, WITH ROLLUP, WITH CUBE, SETTINGS, FORMAT, UNION ALL, OVER (`,
    startKeywords: `
      SELECT, INSERT INTO, WITH, CREATE TABLE, CREATE TABLE IF NOT EXISTS, CREATE MATERIALIZED VIEW, CREATE VIEW,
      CREATE DICTIONARY, CREATE DATABASE, CREATE FUNCTION, ALTER TABLE, DROP TABLE, TRUNCATE TABLE, RENAME TABLE,
      EXCHANGE TABLES, OPTIMIZE TABLE, DELETE FROM, UPDATE, ATTACH, DETACH, KILL QUERY, KILL MUTATION, SYSTEM,
      SHOW TABLES, SHOW DATABASES, SHOW CREATE TABLE, SHOW PROCESSLIST, DESCRIBE TABLE, EXPLAIN, EXPLAIN PIPELINE,
      EXPLAIN indexes = 1, EXISTS TABLE, CHECK TABLE, USE, SET, GRANT, REVOKE`,
    ops2: ['<>', '!=', '<=', '>=', '==', '||', '::', '->'],
    lex: LEX,
    lexHook: traitLexer(LEX),
    formatRules: clickhouseRules,
    classify: classifyClickHouse,
  });
  spec.complete = chComplete; // TODO(WPCH-shared): read by intel/index.ts once DialectSpec.complete exists (R3)
  // TODO(WPCH-shared): set `preserveNameCase: true` once DialectSpec has it (R3): ClickHouse function/type names are
  // case-sensitive, so completion and Format SQL must keep `toYYYYMM` / `UInt32` as spelled.
  return spec;
};

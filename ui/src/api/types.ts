// Wire contract between the UI and the .NET engine. Mirrors docs/PLAN.md section 3.
// Frozen: change the plan (and the engine DTOs) before changing this file.

export type Dialect = 'tsql' | 'plsql' | 'sqlite' | 'pgsql';
/** M2: relational providers (sqlserver, oracle, sqlite, postgresql) and non-relational sources (redis, mongodb, kafka). */
export type ProviderId = 'sqlserver' | 'oracle' | 'sqlite' | 'postgresql' | 'redis' | 'mongodb' | 'kafka';
/** M2 (docs/PLAN-M2.md D1): provider family. Only `relational` providers have sessions, consoles and a SQL catalog. */
export type SourceKind = 'relational' | 'keyvalue' | 'document' | 'stream';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; detail?: unknown };
}
export type ApiErrorCode =
  | 'UNAUTHORIZED' | 'NOT_FOUND' | 'VALIDATION' | 'SESSION_BUSY' | 'SESSION_BROKEN'
  | 'TX_OPEN' | 'PROVIDER_ERROR' | 'BIND_VARS_UNSUPPORTED' | 'NOT_SUPPORTED' | 'READ_ONLY'
  // M1.5 (docs/PLAN-M1.5.md 3.7–3.9)
  | 'SESSION_LIMIT' | 'DDL_FAILED' | 'NOT_EDITABLE'
  // M2 (docs/PLAN-M2.md 1.1): 503 a source client cannot connect, 429 more than 8 open streams per UI client,
  // 403 the server denied a system view (`detail.needs` names the grant), 409 offset reset on an active group (7.5).
  | 'SOURCE_UNAVAILABLE' | 'STREAM_LIMIT' | 'PRIVILEGE' | 'GROUP_ACTIVE';

// ---------- 3.1 Meta ----------
export interface Health { status: 'ok'; version: string; pid: number; dev: boolean }

export type FormFieldType = 'text' | 'password' | 'number' | 'bool' | 'select' | 'file' | 'list';
export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  placeholder?: string | null;
  default?: unknown;
  options?: { value: string; label: string }[] | null;
  /** Show only when every listed field equals the value. */
  visibleWhen?: Record<string, string> | null;
  fileFilter?: string | null;
  help?: string | null;
}
export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  /** M2: null for non-relational sources (redis, mongodb, kafka). */
  dialect: Dialect | null;
  /** M2: provider family (engines before M2 omitted it; treat a missing kind as `relational`). */
  kind: SourceKind;
  formSpec: { fields: FormField[] };
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  editor: {
    fontSize: number;
    keywordCase: 'upper' | 'lower' | 'asIs';
    identifierCase: 'asIs' | 'lower' | 'upper' | 'matchPrefix';
    qualifyObjects: 'never' | 'nonDefaultSchema' | 'always';
    qualifyColumns: 'ambiguous' | 'always';
    tabSize: number;
    blankLineSplitsStatements: boolean;
    /** M1.5: per-dialect override of blankLineSplitsStatements (a missing dialect uses the global flag). */
    blankLineSplitsStatementsByDialect?: Partial<Record<Dialect, boolean>>;
  };
  results: { maxRows: number; nullText: string; dateFormat: 'iso' | 'locale' };
  confirmDestructive: boolean;
  /** Free-form UI state persisted by the engine (MRU completion usage, layout sizes, ...). */
  ui?: Record<string, unknown>;
  // M1.5 additive keys: always present in engine responses, optional here so M1 defaults still type-check.
  format?: FormatOptions;
  snippets?: Snippet[];
  grid?: GridSettings;
  connections?: ConnectionsSettings;
  // M2 additive keys (engine defaults: streams.maxQueuedItems 50000, logs.tailIntervalMs 2000).
  streams?: StreamsSettings;
  logs?: LogsSettings;
}

// ---------- 3.2 Connections ----------
export interface ConnectionProfile {
  id: string;
  name: string;
  providerId: ProviderId;
  color: string | null;
  folder: string | null;
  readOnly: boolean;
  props: Record<string, unknown>;
  hasPassword: boolean;
  savePassword: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
export type ConnectionInput = Omit<ConnectionProfile, 'id' | 'hasPassword' | 'createdAt' | 'lastUsedAt'> & {
  /** null = keep stored password, '' = clear it. */
  password: string | null;
};

export interface ServerInfo {
  version: string;
  productVersion: string | null;
  serverName: string | null;
  user: string | null;
  database: string | null;
}
export interface TestConnectionRequest {
  profile: Partial<ConnectionProfile> & Pick<ConnectionProfile, 'providerId' | 'props'>;
  password: string | null;
  useStoredPassword: boolean;
}
export interface TestConnectionResult {
  ok: boolean;
  serverInfo: ServerInfo | null;
  elapsedMs: number;
  error: ErrorInfo | null;
}

// ---------- 3.3 Catalog ----------
export interface DatabasesResponse { databases: string[]; current: string | null }
export interface SchemasResponse {
  database: string | null;
  defaultSchema: string;
  /** M2 (PostgreSQL): `searchPathIndex` = position in `current_schemas(true)`, null/absent when not on the path. */
  schemas: { name: string; loaded: boolean; objectCount?: number | null; searchPathIndex?: number | null }[];
}

export type CatalogObjectType =
  | 'table' | 'view' | 'mview' | 'proc' | 'func' | 'tablefunc'
  | 'synonym' | 'sequence' | 'package' | 'type' | 'trigger';

/** [name, typeText, nullable(0|1), isPk(0|1), flags(1=identity/autoinc, 2=computed/virtual, 4=hidden, 8=read-only: Oracle GENERATED ALWAYS identity), comment] */
export type CatalogColumnTuple = [string, string, 0 | 1, 0 | 1, number, string | null];
/** [name, type, direction, hasDefault(0|1)]; direction in|out|inout|return */
export type CatalogParamTuple = [string, string, 'in' | 'out' | 'inout' | 'return', 0 | 1];

export interface CatalogForeignKey {
  n: string;          // constraint name
  cols: string[];     // columns in this table
  rs: string | null;  // referenced schema
  rt: string;         // referenced table
  rcols: string[];    // referenced columns
  dis?: boolean;      // isDisabled: SQL Server NOCHECK CONSTRAINT (not enforced)
  nt?: boolean;       // isNotTrusted: existing rows not checked (WITH NOCHECK, or disabled)
}
export interface CatalogPackageMember {
  n: string;
  k: 'proc' | 'func';
  ov: number;
  p: CatalogParamTuple[];
}
export interface CatalogObject {
  t: CatalogObjectType;
  n: string;
  cm?: string | null;
  c?: CatalogColumnTuple[];
  pk?: string[];
  fk?: CatalogForeignKey[];
  p?: CatalogParamTuple[];
  target?: { d?: string | null; s: string | null; n: string; t: CatalogObjectType | null };
  members?: CatalogPackageMember[];
  st?: 'VALID' | 'INVALID' | null;
}
export interface CatalogSchema { name: string; version: number; objects: CatalogObject[] }
export interface CatalogSnapshot {
  connectionId: string;
  dialect: Dialect;
  database: string | null;
  defaultSchema: string;
  version: number;
  databases: string[];
  schemas: CatalogSchema[];
  /** M2 (PostgreSQL): `current_schemas(true)` minus `pg_catalog`, in order; omitted for other dialects. */
  searchPath?: string[];
  /** UI only (store/catalog.ts): every schema of the database, loaded or not (GET /schemas), for IntelliSense. */
  schemaNames?: string[];
}

export interface ObjectRef { database: string | null; schema: string | null; name: string; type: CatalogObjectType }
export interface ColumnDetail {
  name: string; type: string; nullable: boolean; default: string | null; isPk: boolean;
  isIdentity: boolean; isComputed: boolean; comment: string | null; ordinal: number;
}
export interface IndexDetail { name: string; unique: boolean; columns: string[]; type: string | null; isPrimaryKey: boolean }
export interface ForeignKeyDetail { name: string; columns: string[]; refSchema: string | null; refTable: string; refColumns: string[] }
export interface ObjectDetails {
  ref: ObjectRef;
  columns: ColumnDetail[];
  indexes: IndexDetail[];
  foreignKeys: ForeignKeyDetail[];
  referencedBy: { schema: string | null; table: string; constraint: string; columns: string[] }[];
  triggers: string[];
  parameters: { name: string; typeText: string; direction: string; hasDefault: boolean }[];
  rowCountEstimate: number | null;
  created: string | null;
  modified: string | null;
}
export interface DdlResponse { ddl: string; source: 'generated' | 'stored' }
export interface ObjectError { line: number; col: number; message: string; severity: 'error' | 'warning' }

// ---------- 3.4 Sessions and execution ----------
export type TxMode = 'auto' | 'manual';
export type SessionState = 'idle' | 'executing' | 'broken' | 'closed';
export interface CreateSessionRequest {
  connectionId: string;
  database: string | null;
  txMode: TxMode;
  captureServerOutput: boolean;
}
export interface SessionInfo {
  sessionId: string;
  connectionId: string;
  serverInfo: ServerInfo;
  database: string | null;
  txMode: TxMode;
  txOpen: boolean;
  state: SessionState;
  dialect: Dialect;
  /** M1.5: start of the running execution (ISO), null when idle. */
  executingSince?: string | null;
  /** M1.5: from the last ExecuteRequest.source. */
  tabId?: string | null;
  label?: string | null;
  /**
   * B1 (logic-08): the UI window that owns the session (created or last used it) has no live WebSocket. The engine
   * closes it (rolling back) after settings `connections.orphanGraceSeconds` unless that window reconnects or another
   * window uses the session.
   */
  orphan?: boolean;
}

/** line/col are 1-based positions of the batch's first character in the editor document. */
export interface SqlBatch { sql: string; line: number; col: number }
export type RunLabel = 'statement' | 'selection' | 'script';
export interface ExecuteRequest {
  batches: SqlBatch[];
  maxRows: number;
  stopOnError: boolean;
  label: ExecLabel;
  source?: { tabId: string; title: string };
  /** Set after the user confirmed a destructive statement; otherwise read-only connections reject non-queries. */
  confirmedDestructive?: boolean;
  /** M1.5 (A2): bind values. Bound by name (`@id`, `:id`, `$id`) or by position when the name is numeric or the SQL uses `?`. */
  params?: QueryParam[] | null;
  /** B1 (logic-19): do not record this run in history (describe probes, COUNT(*) helpers). Default false. */
  skipHistory?: boolean;
}
export interface ExecuteResponse { executionId: string; startedAt: string }

export type ColumnKind =
  | 'int' | 'float' | 'decimal' | 'string' | 'bool' | 'date' | 'time' | 'datetime'
  | 'datetimeoffset' | 'guid' | 'binary' | 'json' | 'xml' | 'cursor' | 'other';
export interface ColumnInfo {
  name: string;
  ordinal: number;
  dbType: string;
  kind: ColumnKind;
  nullable: boolean;
  size: number | null;
  precision: number | null;
  scale: number | null;
  table: string | null;
  schema: string | null;
  isKey: boolean;
}

/** Wire cell value. Decimals and int64 beyond 2^53 arrive as strings; dates as ISO strings. */
export type CellValue =
  | null | boolean | number | string
  | { $bin: string; len: number }
  | { $trunc: string; len: number }
  | { $cursor: true };

export interface RowsPage { columns: ColumnInfo[]; rows: CellValue[][]; total: number; truncated: boolean }
export interface CellResponse { kind: 'string' | 'binary'; value: string; len: number }

export type ExportFormat = 'csv' | 'json' | 'sql-insert' | 'xlsx';
export interface ExportOptions { delimiter?: string; header?: boolean; nullAs?: string; tableName?: string }
export interface ResultSetExportRequest { format: ExportFormat; path: string | null; options: ExportOptions }
export interface QueryExportRequest { sessionId: string; sql: string; format: ExportFormat; path: string; options: ExportOptions }

export interface HistoryEntry {
  id: number;
  connectionId: string;
  database: string | null;
  sql: string;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error' | 'cancelled';
  rowsAffected: number | null;
  resultRows: number | null;
  error: string | null;
  label: ExecLabel;
  pinned: boolean;
}

export interface ErrorInfo {
  code: string;
  message: string;
  line?: number | null;
  col?: number | null;
  state?: number | null;
  detail?: string | null;
  providerCode?: number | null;
}

// ---------- 3.5 SQL services ----------
export interface DiagnosticsRequest { dialect: Dialect; sql: string; connectionId: string | null }
export interface ServerDiagnostic {
  line: number; col: number; endLine: number; endCol: number;
  severity: 'error' | 'warning' | 'info';
  code: string | null;
  message: string;
}
export interface DiagnosticsResponse { diagnostics: ServerDiagnostic[]; engine: string }

// ---------- 3.6 WebSocket events (server → client) ----------
interface Ev<T extends string> { type: T; ts: string }
export type WsEvent =
  | Ev<'auth.ok'>
  | Ev<'pong'>
  | (Ev<'exec.started'> & { executionId: string; sessionId: string; batchCount: number })
  | (Ev<'exec.batch.started'> & { executionId: string; batchIndex: number })
  | (Ev<'exec.resultset'> & { executionId: string; resultSetId: number; batchIndex: number; columns: ColumnInfo[] })
  | (Ev<'exec.rows'> & { executionId: string; resultSetId: number; rows: CellValue[][] })
  | (Ev<'exec.resultset.end'> & { executionId: string; resultSetId: number; rowCount: number; truncated: boolean; elapsedMs: number })
  | (Ev<'exec.affected'> & { executionId: string; batchIndex: number; count: number; statementKind: string | null })
  | (Ev<'exec.message'> & {
      executionId: string; batchIndex: number; severity: 'info' | 'warning' | 'error'; text: string;
      line: number | null; code: number | null; source: 'server' | 'dbmsOutput' | 'engine';
    })
  | (Ev<'exec.error'> & {
      executionId: string; batchIndex: number; code: string; message: string;
      line: number | null; col: number | null; detail: string | null;
    })
  | (Ev<'exec.batch.ended'> & { executionId: string; batchIndex: number; elapsedMs: number; status: 'ok' | 'error' | 'cancelled' })
  | (Ev<'exec.done'> & {
      executionId: string; sessionId: string; status: 'ok' | 'error' | 'cancelled'; elapsedMs: number;
      resultSets: number; rowsAffected: number; txOpen: boolean;
      /** M1.5: values of out/inout params (refcursor outs arrive as normal result sets instead). */
      outParams?: OutParamValue[];
    })
  | (Ev<'exec.diagnostics'> & { executionId: string; diagnostics: ServerDiagnostic[] })
  | (Ev<'exec.plan'> & ExecPlanPayload)
  | (Ev<'session.changed'> & { sessionId: string; state: SessionState; txOpen: boolean; database: string | null; txMode: TxMode })
  | (Ev<'catalog.changed'> & { connectionId: string; database: string | null; schemas: string[]; version: number })
  | (Ev<'export.progress'> & { exportId: string; rows: number })
  | (Ev<'export.done'> & { exportId: string; path: string; rows: number; status: 'ok' | 'error' | 'cancelled'; error: string | null })
  | (Ev<'engine.log'> & { level: 'debug' | 'info' | 'warn' | 'error'; message: string })
  // ---- M2 (docs/PLAN-M2.md 1.2, 2.4): streams, source clients, jobs
  | (Ev<'stream.data'> & StreamDataPayload)
  | (Ev<'stream.state'> & StreamStatePayload)
  | (Ev<'source.client'> & { connectionId: string; state: SourceClientState })
  | (Ev<'job.progress'> & JobProgressPayload)
  | (Ev<'job.done'> & JobDonePayload);

export type WsEventType = WsEvent['type'];
export type WsEventOf<T extends WsEventType> = Extract<WsEvent, { type: T }>;

/** Client → server frames. */
/** B1 (logic-08): `clientId` names this UI window (see api/clientId.ts); sessions it owns outlive a disconnect only for the grace period. */
export type WsClientFrame = { type: 'auth'; token: string; clientId?: string } | { type: 'ping' };

// ---------- M1.5 ----------
// Additive wire types of docs/PLAN-M1.5.md (sections 1, 2 and 3.7–3.9). Authored by WP-F; the engine DTOs live in
// engine/src/DbStudio.Host/Contracts/M15.cs and engine/src/DbStudio.Core/{Designer,Plans,Params}.

/** Execution labels: the M1 run labels plus the M1.5 origins shown in history. */
export type ExecLabel = RunLabel | 'filter' | 'data' | 'multi' | 'explain';

// ----- Settings additions -----
export type CaseStyle = 'upper' | 'lower' | 'asIs';
export interface FormatOptions {
  keywordCase: CaseStyle;
  identifierCase: CaseStyle;
  indent: number;
  useTabs: boolean;
  commaStyle: 'trailing' | 'leading';
  lineWidth: number;
  clauseKeywordsOnOwnLine: boolean;
  andOrOnNewLine: boolean;
  alignAliases: boolean;
  blankLineBetweenStatements: number;
  maxConsecutiveBlankLines: number;
  functionCase: CaseStyle;
  datatypeCase: CaseStyle;
  /** Explorer "Open DDL" formats the DDL text on open. */
  formatDdlOnOpen: boolean;
}
export interface Snippet {
  id: string;
  name: string;
  prefix: string;
  /** null = all dialects. */
  dialects: Dialect[] | null;
  /** Monaco snippet syntax: `$1`, `${1:default}`, `$0`. */
  body: string;
  description?: string | null;
}
export interface GridSettings {
  density: 'comfortable' | 'compact';
  pageSize: number;
  verifyUnchanged: boolean;
  /** user-02: open the SQL preview before saving grid edits (default false: Ctrl+S saves directly, like Navicat). */
  showSqlBeforeSave?: boolean;
}
export interface ConnectionsSettings {
  maxSessionsPerProfile: number;
  /** B1 (logic-08): seconds a session survives its window's disconnect before the engine closes it (0 = never). Default 90. */
  orphanGraceSeconds?: number;
  /** M2 (D2): seconds an unused Redis/MongoDB/Kafka client stays open (0 = never close). Default 600. */
  sourceIdleSeconds?: number;
}
/** M2 (docs/PLAN-M2.md 1.1): engine stream queue size (oldest items dropped beyond it). */
export interface StreamsSettings { maxQueuedItems: number }
/** M2: poll interval of `logs.tail` streams over sources without push. */
export interface LogsSettings { tailIntervalMs: number }

// ----- Error details -----
/** `detail` of a 429 SESSION_LIMIT error. */
export interface SessionLimitDetail { connectionId: string; limit: number; open: number }
/** B1 (logic-21): `detail` of a 409 TX_OPEN from DELETE /connections/{id} (retry with `force` to roll them back). */
export interface ConnectionTxOpenDetail { sessions: { sessionId: string; label?: string | null; tabId?: string | null }[] }
/** `detail` of a 409 DDL_FAILED error from POST .../designer/apply. */
export interface DdlFailedDetail {
  failedIndex: number;
  executed: number;
  rolledBack: boolean;
  providerError: ErrorInfo;
}

// ----- 1.1 Filter model (shared by grid, explorer and history; evaluated in the renderer) -----
export type FilterOp =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'in' | 'notIn' | 'isNull' | 'isNotNull' | 'isTrue' | 'isFalse' | 'isEmpty' | 'regex' | 'before' | 'after'
  | 'onDate' | 'last' | 'next';
export type FilterValue = string | number | boolean | null;
export interface FilterCondition {
  id: string;
  column: string;
  op: FilterOp;
  values: FilterValue[];
  caseSensitive?: boolean;
}
export interface FilterGroup { id: string; logic: 'and' | 'or'; items: (FilterCondition | FilterGroup)[] }
export interface FilterModel { root: FilterGroup; quick?: string }

// ----- 3.7 Saved filters and history filters -----
export interface SavedFilter {
  id: string;
  connectionId: string;
  /** Sorted `name:kind` list joined with `|`, e.g. "Id:int|Name:string|Total:decimal". */
  signature: string;
  name: string;
  model: FilterModel;
  createdAt: string;
  lastUsedAt: string | null;
}
export type SavedFilterInput = Pick<SavedFilter, 'connectionId' | 'signature' | 'name' | 'model'>;
export type SavedFilterPatch = Partial<Pick<SavedFilter, 'name' | 'model' | 'lastUsedAt'>>;

export type HistoryStatus = HistoryEntry['status'];
export interface HistoryQuery {
  connectionId?: string | null;
  q?: string;
  limit?: number;
  before?: string | number | null;
  /** M1.5 filters (all optional, combined with AND). */
  status?: HistoryStatus[] | null;
  /** ISO timestamps, inclusive. */
  from?: string | null;
  to?: string | null;
  /** true = only pinned entries. */
  pinned?: boolean | null;
}

// ----- 3.8 Parameters -----
export type ParamKind =
  | 'int' | 'string' | 'decimal' | 'float' | 'bool' | 'date' | 'datetime' | 'datetimeoffset' | 'time' | 'guid'
  | 'binary' | 'null' | 'refcursor';
export type ParamDirection = 'in' | 'out' | 'inout';
export interface QueryParam {
  /** Without prefix (`id` for `@id`/`:id`); numeric ("1") = positional. A leading `@`/`:`/`$` is tolerated. */
  name: string;
  kind: ParamKind;
  /** decimal/int64 as string or number; dates ISO; binary base64; null for NULL and for refcursor/out params. */
  value: FilterValue;
  /** Default "in". `refcursor` is always an out param (Oracle) and yields an extra result set. */
  direction?: ParamDirection;
  /** Optional size for out/inout string/binary params (default 4000). */
  size?: number | null;
}
export interface OutParamValue { name: string; value: CellValue }

// ----- 3.8 Describe -----
export interface DescribeRequest { sql: string; params?: QueryParam[] | null }
export interface DescribeResponse {
  columns: ColumnInfo[];
  /** True when the result maps to one base table and all of its key columns are present. */
  editable: boolean;
  table: { schema: string | null; name: string } | null;
  keyColumns: string[];
  warnings: string[];
}

// ----- 3.8 Explain plan -----
export type ExplainMode = 'estimated' | 'actual';
export interface ExplainRequest {
  sql: string;
  params?: QueryParam[] | null;
  mode: ExplainMode;
  /** 1-based editor position of `sql` (error line mapping); default 1/1. */
  line?: number;
  col?: number;
  /** Row cap for result sets delivered in actual mode (default: settings results.maxRows). */
  maxRows?: number;
  source?: { tabId: string; title: string };
  /** Actual mode runs the statement: required for non-queries on read-only connections (rejected otherwise). */
  confirmedDestructive?: boolean;
}
export interface PlanNode {
  id: number;
  /** Physical operator / Oracle "OPERATION OPTIONS" / SQLite detail text. */
  op: string;
  logicalOp: string | null;
  object: string | null;
  estRows: number | null;
  actualRows: number | null;
  /** Subtree cost in the provider's unit (SQL Server cost units, Oracle cost); null when unknown (SQLite). */
  cost: number | null;
  /** Share of the root's total cost spent in this node alone (0–100); null when costs are unknown. */
  costPct: number | null;
  predicate: string | null;
  warnings: string[];
  /** Extra provider attributes for a detail pane (e.g. "Bytes", "EstimateIO", "Access predicates"). */
  props?: Record<string, string>;
  children: PlanNode[];
}
export interface ExecPlanPayload {
  executionId: string;
  dialect: Dialect;
  mode: ExplainMode;
  root: PlanNode;
  raw: string;
  /** M2: `json` for PostgreSQL `EXPLAIN (FORMAT JSON)`. */
  rawFormat: 'xml' | 'text' | 'json';
  warnings: string[];
}
export type ExecPlanEvent = WsEventOf<'exec.plan'>;

// ----- 3.8 Sample database -----
export interface SampleDbRequest {
  /** Recreate the file even if it exists (default false: reuse the existing file and profile). */
  reset?: boolean;
}
export interface SampleDbResponse { path: string; connectionId: string; profile: ConnectionProfile; created: boolean }

// ----- 3.9 Designer -----
export type ReferentialAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT';
export interface TableColumnModel {
  /** Stable id assigned by the UI (= original column name for existing columns); a rename keeps the id. */
  id?: string | null;
  name: string;
  /** Full type text incl. size: `nvarchar(100)`, `NUMBER(10,2)`, `TEXT`. */
  type: string;
  nullable: boolean;
  /** Default as SQL expression text (`0`, `'x'`, `SYSUTCDATETIME()`); null = none. */
  default: string | null;
  /** SQL Server default constraint name. */
  defaultName: string | null;
  /** `always` (Oracle GENERATED ALWAYS) defaults to false = BY DEFAULT. */
  identity: { seed: number; increment: number; always?: boolean } | null;
  computed: { expression: string; persisted: boolean } | null;
  collation: string | null;
  comment: string | null;
  /** SQLite INTEGER PRIMARY KEY AUTOINCREMENT. */
  autoincrement: boolean;
}
export interface PrimaryKeyModel { name: string | null; columns: string[]; clustered: boolean }
export interface UniqueModel { name: string | null; columns: string[] }
export interface IndexColumnModel { name: string; desc: boolean }
export interface IndexModel {
  name: string;
  columns: IndexColumnModel[];
  unique: boolean;
  clustered: boolean;
  include: string[];
  filter: string | null;
}
export interface ForeignKeyModel {
  name: string | null;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}
export interface CheckModel { name: string | null; expression: string }
export interface TableOptions { withoutRowid: boolean; strict: boolean; tablespace: string | null }
export interface TableModel {
  schema: string | null;
  name: string;
  comment: string | null;
  options: TableOptions;
  columns: TableColumnModel[];
  primaryKey: PrimaryKeyModel | null;
  uniques: UniqueModel[];
  indexes: IndexModel[];
  foreignKeys: ForeignKeyModel[];
  checks: CheckModel[];
}

export type DesignerTypeParams = 'length' | 'precisionScale' | 'precision' | 'none';
export interface DesignerType {
  name: string;
  params: DesignerTypeParams;
  /** Suggested full type text, e.g. "nvarchar(100)". */
  default: string;
  category: 'string' | 'number' | 'date' | 'binary' | 'other';
}
export interface DesignerFeatures {
  identity: boolean;
  computed: boolean;
  clusteredIndexes: boolean;
  includedColumns: boolean;
  filteredIndexes: boolean;
  onUpdateAction: boolean;
  comments: boolean;
  renameColumn: boolean;
  dropColumn: boolean;
  withoutRowid: boolean;
  strict: boolean;
  transactionalDdl: boolean;
  autoincrement: boolean;
  /** The dialect has schemas (false for SQLite). */
  schemas: boolean;
}
export interface DesignerTypesResponse { types: DesignerType[]; features: DesignerFeatures }

export type DdlStatementKind = 'create' | 'alter' | 'drop' | 'rename' | 'rebuild' | 'comment' | 'index' | 'pragma';
export interface DdlStatement { sql: string; kind: DdlStatementKind; warning: string | null }
export interface DdlScript {
  /** Ordered; never contains BEGIN/COMMIT (apply manages the transaction). */
  statements: DdlStatement[];
  rebuildRequired: boolean;
  /** true: apply runs every statement in one transaction (SQL Server, SQLite); false: autocommit per statement (Oracle). */
  transactional: boolean;
  warnings: string[];
}

/** Change list computed by TableDiff (informational; the script is the source of truth). */
export type TableChangeKind =
  | 'tableRenamed' | 'tableCommentChanged' | 'optionsChanged'
  | 'columnAdded' | 'columnDropped' | 'columnRenamed' | 'columnTypeChanged' | 'columnNullabilityChanged'
  | 'columnDefaultChanged' | 'columnIdentityChanged' | 'columnComputedChanged' | 'columnCollationChanged'
  | 'columnCommentChanged' | 'columnsReordered'
  | 'primaryKeyAdded' | 'primaryKeyDropped' | 'uniqueAdded' | 'uniqueDropped' | 'indexAdded' | 'indexDropped'
  | 'foreignKeyAdded' | 'foreignKeyDropped' | 'checkAdded' | 'checkDropped';
export interface TableChange { kind: TableChangeKind; target: string; detail: string | null }

export interface TableScriptRequest { database: string | null; original: TableModel | null; desired: TableModel }
export interface TableScriptResponse extends DdlScript { changes: TableChange[] }

export interface ViewOptions { schemaBinding: boolean; checkOption: boolean; force: boolean }
export interface ViewModel {
  schema: string | null;
  name: string;
  /** The SELECT only (CREATE ... AS header stripped from the stored DDL). */
  body: string;
  options: ViewOptions;
  /** The stored DDL as returned by the server. */
  ddl: string;
}
export interface ViewScriptRequest {
  database: string | null;
  schema: string | null;
  name: string;
  /** Existing view's name when editing (a rename when it differs from name); null for a new view. */
  originalName: string | null;
  body: string;
  options: ViewOptions;
}

export interface DdlApplyRequest {
  database: string | null;
  statements: string[];
  transactional: boolean;
  /** Schema to refresh in the catalog after success (default: the connection's default schema). */
  schema?: string | null;
}
export interface DdlApplyResponse { ok: true; executed: number; elapsedMs: number }

// ---------- M2 (docs/PLAN-M2.md 1.2, 2.3, 2.4) ----------
// Shared framework types. Feature wire types (Redis, Mongo, Kafka, Logs, ER) live in ./types.m2.ts (re-exported here).

/** Stream kinds; the engine dispatches `POST /streams` to the `IStreamFactory` registered under the same key. */
export type StreamKind =
  | 'redis.monitor' | 'redis.subscribe' | 'kafka.tail' | 'kafka.fetch' | 'mongo.changes' | 'logs.tail' | 'activity.poll'
  // Find in database (api/types.search.ts)
  | 'db.search';
export interface StreamOpenRequest { kind: StreamKind; connectionId: string; params: Record<string, unknown> }
export interface StreamOpenResponse { streamId: string }
/** `open` is re-sent about every second while items are dropped (with the running `dropped` total). */
export type StreamState = 'open' | 'paused' | 'ended' | 'error';
export interface StreamInfo {
  streamId: string;
  kind: StreamKind;
  connectionId: string;
  state: StreamState;
  /** UI client id (`X-DbStudio-Client`) owning the stream; null for API callers without one. */
  owner: string | null;
  openedAt: string;
  /** Items delivered in `stream.data` batches so far. */
  delivered: number;
  dropped: number;
}
/** `items` are kind-specific JSON objects (docs/PLAN-M2.md 2.4); `seq` is monotonic per stream (one per batch). */
export interface StreamDataPayload { streamId: string; items: unknown[]; seq: number }
export interface StreamStatePayload { streamId: string; state: StreamState; reason: string | null; dropped: number }
export type StreamDataEvent = WsEventOf<'stream.data'>;
export type StreamStateEvent = WsEventOf<'stream.state'>;
export type StreamEvent = StreamDataEvent | StreamStateEvent;

export type SourceClientState = 'open' | 'closed' | 'broken';
/** One long-lived client per non-relational connection (D2); listed as "Clients" in the Connections panel. */
export interface SourceClientInfo {
  connectionId: string;
  state: SourceClientState;
  server: ServerInfo | null;
  openedAt: string;
  lastUsed: string;
}

/** Long operations (2.3): `202 { jobId }`, then `job.progress` / `job.done`; `DELETE /jobs/{id}` cancels. */
export interface JobStarted { jobId: string }
export interface JobProgressPayload { jobId: string; kind: string; done: number; total: number | null; message: string | null }
export interface JobDonePayload {
  jobId: string;
  kind: string;
  status: 'ok' | 'error' | 'cancelled';
  error: string | null;
  result: unknown;
}
export type JobProgressEvent = WsEventOf<'job.progress'>;
export type JobDoneEvent = WsEventOf<'job.done'>;

export * from './types.m2';

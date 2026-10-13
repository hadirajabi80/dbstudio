// Wire contract between the UI and the .NET engine. Mirrors docs/PLAN.md section 3.
// Frozen: change the plan (and the engine DTOs) before changing this file.

export type Dialect = 'tsql' | 'plsql' | 'sqlite';
export type ProviderId = 'sqlserver' | 'oracle' | 'sqlite';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; detail?: unknown };
}
export type ApiErrorCode =
  | 'UNAUTHORIZED' | 'NOT_FOUND' | 'VALIDATION' | 'SESSION_BUSY' | 'SESSION_BROKEN'
  | 'TX_OPEN' | 'PROVIDER_ERROR' | 'BIND_VARS_UNSUPPORTED' | 'NOT_SUPPORTED' | 'READ_ONLY';

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
  dialect: Dialect;
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
  };
  results: { maxRows: number; nullText: string; dateFormat: 'iso' | 'locale' };
  confirmDestructive: boolean;
  /** Free-form UI state persisted by the engine (MRU completion usage, layout sizes, ...). */
  ui?: Record<string, unknown>;
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
  schemas: { name: string; loaded: boolean; objectCount?: number | null }[];
}

export type CatalogObjectType =
  | 'table' | 'view' | 'mview' | 'proc' | 'func' | 'tablefunc'
  | 'synonym' | 'sequence' | 'package' | 'type' | 'trigger';

/** [name, typeText, nullable(0|1), isPk(0|1), flags(1=identity/autoinc, 2=computed/virtual, 4=hidden), comment] */
export type CatalogColumnTuple = [string, string, 0 | 1, 0 | 1, number, string | null];
/** [name, type, direction, hasDefault(0|1)]; direction in|out|inout|return */
export type CatalogParamTuple = [string, string, 'in' | 'out' | 'inout' | 'return', 0 | 1];

export interface CatalogForeignKey {
  n: string;          // constraint name
  cols: string[];     // columns in this table
  rs: string | null;  // referenced schema
  rt: string;         // referenced table
  rcols: string[];    // referenced columns
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
}

/** line/col are 1-based positions of the batch's first character in the editor document. */
export interface SqlBatch { sql: string; line: number; col: number }
export type RunLabel = 'statement' | 'selection' | 'script';
export interface ExecuteRequest {
  batches: SqlBatch[];
  maxRows: number;
  stopOnError: boolean;
  label: RunLabel;
  source?: { tabId: string; title: string };
  /** Set after the user confirmed a destructive statement; otherwise read-only connections reject non-queries. */
  confirmedDestructive?: boolean;
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

export type ExportFormat = 'csv' | 'json' | 'sql-insert';
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
  label: RunLabel;
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
    })
  | (Ev<'exec.diagnostics'> & { executionId: string; diagnostics: ServerDiagnostic[] })
  | (Ev<'session.changed'> & { sessionId: string; state: SessionState; txOpen: boolean; database: string | null; txMode: TxMode })
  | (Ev<'catalog.changed'> & { connectionId: string; database: string | null; schemas: string[]; version: number })
  | (Ev<'export.progress'> & { exportId: string; rows: number })
  | (Ev<'export.done'> & { exportId: string; path: string; rows: number; status: 'ok' | 'error' | 'cancelled'; error: string | null })
  | (Ev<'engine.log'> & { level: 'debug' | 'info' | 'warn' | 'error'; message: string });

export type WsEventType = WsEvent['type'];
export type WsEventOf<T extends WsEventType> = Extract<WsEvent, { type: T }>;

/** Client → server frames. */
export type WsClientFrame = { type: 'auth'; token: string } | { type: 'ping' };

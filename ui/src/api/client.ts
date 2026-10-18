// Typed REST client for the engine (docs/PLAN.md section 3). Every request carries `Authorization: Bearer`.
import type {
  ApiErrorBody, ApiErrorCode, CatalogSnapshot, CellResponse, ConnectionInput, ConnectionProfile,
  CreateSessionRequest, DatabasesResponse, DdlResponse, DiagnosticsRequest, DiagnosticsResponse, ExecuteRequest,
  ExecuteResponse, Health, HistoryEntry, ObjectDetails, ObjectError, ObjectRef, ProviderInfo, QueryExportRequest,
  ResultSetExportRequest, RowsPage, SchemasResponse, SessionInfo, Settings, TestConnectionRequest,
  TestConnectionResult, TxMode,
} from './types';
// M1.5
import type {
  DdlApplyRequest, DdlApplyResponse, DdlScript, DescribeRequest, DescribeResponse, DesignerTypesResponse,
  ExplainRequest, HistoryQuery, SampleDbRequest, SampleDbResponse, SavedFilter, SavedFilterInput, SavedFilterPatch,
  TableModel, TableScriptRequest, TableScriptResponse, ViewModel, ViewScriptRequest,
} from './types';
import { CLIENT_ID_HEADER, uiClientId } from './clientId';

export const API_PREFIX = '/api/v1';

export type ClientErrorCode = ApiErrorCode | 'NETWORK' | 'HTTP' | 'ABORTED';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: ClientErrorCode, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isApiError(e: unknown, code?: ClientErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface ClientConfig {
  baseUrl: string;
  token: string;
}

let config: ClientConfig | null = null;
let readyResolve: ((c: ClientConfig) => void) | null = null;
let ready: Promise<ClientConfig> = new Promise((r) => (readyResolve = r));

/** Points the client at an engine. May be called again after an engine restart. */
export function configureClient(c: ClientConfig): void {
  config = { baseUrl: c.baseUrl.replace(/\/+$/, ''), token: c.token };
  if (readyResolve) {
    readyResolve(config);
    readyResolve = null;
  } else {
    ready = Promise.resolve(config);
  }
}

export function getClientConfig(): ClientConfig | null {
  return config;
}

type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function buildUrl(base: string, path: string, query?: Query): string {
  let url = `${base}${API_PREFIX}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const c = config ?? (await ready);
  const headers: Record<string, string> = { Authorization: `Bearer ${c.token}`, [CLIENT_ID_HEADER]: uiClientId(), ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(c.baseUrl, path, opts.query), { method, headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('ABORTED', 'Request aborted', 0);
    throw new ApiError('NETWORK', `Cannot reach the DbStudio engine (${errorMessage(e)})`, 0);
  }
  if (res.status === 304 || res.ok) return res;
  throw await toApiError(res);
}

async function toApiError(res: Response): Promise<ApiError> {
  let parsed: ApiErrorBody | null = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as ApiErrorBody) : null;
  } catch {
    parsed = null;
  }
  if (parsed?.error?.code) return new ApiError(parsed.error.code, parsed.error.message, res.status, parsed.error.detail);
  const code: ClientErrorCode = res.status === 401 ? 'UNAUTHORIZED' : res.status === 404 ? 'NOT_FOUND' : 'HTTP';
  return new ApiError(code, `${res.status} ${res.statusText || 'HTTP error'}`, res.status);
}

async function json<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
  const res = await send(method, path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export type CatalogFetchResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; etag: string | null; snapshot: CatalogSnapshot };

export interface FileResponse {
  blob: Blob;
  filename: string | null;
}

function filenameFrom(res: Response): string | null {
  const cd = res.headers.get('Content-Disposition');
  if (!cd) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : null;
}

function refQuery(database: string | null | undefined, ref: Pick<ObjectRef, 'schema' | 'name' | 'type'>): Query {
  return { database: database ?? undefined, schema: ref.schema ?? undefined, name: ref.name, type: ref.type };
}

export const api = {
  // 3.1 Meta
  health: (signal?: AbortSignal) => json<Health>('GET', '/health', { signal }),
  providers: () => json<ProviderInfo[]>('GET', '/providers'),
  getSettings: () => json<Settings>('GET', '/settings'),
  putSettings: (s: Partial<Settings>) => json<Settings>('PUT', '/settings', { body: s }),

  // 3.2 Connections
  listConnections: () => json<ConnectionProfile[]>('GET', '/connections'),
  createConnection: (c: ConnectionInput) => json<ConnectionProfile>('POST', '/connections', { body: c }),
  updateConnection: (id: string, c: ConnectionInput) => json<ConnectionProfile>('PUT', `/connections/${enc(id)}`, { body: c }),
  /** B1 (logic-21): 409 TX_OPEN (detail.sessions) while a session of the connection has an open transaction, unless `force`. */
  deleteConnection: (id: string, opts?: { force?: boolean }) =>
    json<void>('DELETE', `/connections/${enc(id)}`, { query: { force: opts?.force ? 'true' : undefined } }),
  testConnection: (req: TestConnectionRequest, signal?: AbortSignal) =>
    json<TestConnectionResult>('POST', '/connections/test', { body: req, signal }),

  // 3.3 Catalog
  databases: (cid: string) => json<DatabasesResponse>('GET', `/connections/${enc(cid)}/catalog/databases`),
  schemas: (cid: string, database: string | null) =>
    json<SchemasResponse>('GET', `/connections/${enc(cid)}/catalog/schemas`, { query: { database } }),
  async catalog(cid: string, database: string | null, schemas: string[] | null, etag?: string | null): Promise<CatalogFetchResult> {
    const res = await send('GET', `/connections/${enc(cid)}/catalog`, {
      query: { database, schemas: schemas?.length ? schemas.join(',') : undefined },
      headers: etag ? { 'If-None-Match': etag } : undefined,
    });
    const newTag = res.headers.get('ETag');
    if (res.status === 304) return { notModified: true, etag: newTag ?? etag ?? null };
    return { notModified: false, etag: newTag, snapshot: (await res.json()) as CatalogSnapshot };
  },
  objectDetails: (cid: string, database: string | null, ref: ObjectRef) =>
    json<ObjectDetails>('GET', `/connections/${enc(cid)}/catalog/object`, { query: refQuery(database, ref) }),
  ddl: (cid: string, database: string | null, ref: ObjectRef) =>
    json<DdlResponse>('GET', `/connections/${enc(cid)}/catalog/ddl`, { query: refQuery(database, ref) }),
  objectErrors: (cid: string, ref: ObjectRef) =>
    json<ObjectError[]>('GET', `/connections/${enc(cid)}/catalog/errors`, {
      query: { schema: ref.schema ?? undefined, name: ref.name, type: ref.type },
    }),
  refreshCatalog: (cid: string, database: string | null, schemas: string[] | null) =>
    json<{ version: number }>('POST', `/connections/${enc(cid)}/catalog/refresh`, { body: { database, schemas } }),

  // 3.4 Sessions and execution
  createSession: (req: CreateSessionRequest) => json<SessionInfo>('POST', '/sessions', { body: req }),
  listSessions: () => json<SessionInfo[]>('GET', '/sessions'),
  closeSession: (sid: string, force = false) =>
    json<void>('DELETE', `/sessions/${enc(sid)}`, { query: { force: force ? 'true' : undefined } }),
  changeDatabase: (sid: string, database: string) =>
    json<SessionInfo>('POST', `/sessions/${enc(sid)}/database`, { body: { database } }),
  setTxMode: (sid: string, txMode: TxMode) => json<SessionInfo>('POST', `/sessions/${enc(sid)}/tx-mode`, { body: { txMode } }),
  commit: (sid: string) => json<SessionInfo>('POST', `/sessions/${enc(sid)}/commit`),
  rollback: (sid: string) => json<SessionInfo>('POST', `/sessions/${enc(sid)}/rollback`),
  execute: (sid: string, req: ExecuteRequest) => json<ExecuteResponse>('POST', `/sessions/${enc(sid)}/execute`, { body: req }),
  cancel: (sid: string) => json<{ cancelled: boolean }>('POST', `/sessions/${enc(sid)}/cancel`),
  rows: (xid: string, rs: number, offset: number, limit: number) =>
    json<RowsPage>('GET', `/executions/${enc(xid)}/resultsets/${rs}/rows`, { query: { offset, limit } }),
  cell: (xid: string, rs: number, row: number, col: number) =>
    json<CellResponse>('GET', `/executions/${enc(xid)}/resultsets/${rs}/cell`, { query: { row, col } }),
  /** With a path the engine writes the file and returns {path, rows}; with path null the response is the file. */
  async exportResultSet(xid: string, rs: number, req: ResultSetExportRequest): Promise<{ path: string; rows: number } | FileResponse> {
    const res = await send('POST', `/executions/${enc(xid)}/resultsets/${rs}/export`, { body: req });
    const type = res.headers.get('Content-Type') ?? '';
    if (req.path === null || !type.includes('application/json')) return { blob: await res.blob(), filename: filenameFrom(res) };
    return (await res.json()) as { path: string; rows: number };
  },
  exportQuery: (req: QueryExportRequest) => json<{ exportId: string }>('POST', '/export', { body: req }),
  history: (q: HistoryQuery) =>
    json<HistoryEntry[]>('GET', '/history', {
      query: {
        connectionId: q.connectionId ?? undefined, q: q.q, limit: q.limit ?? 200, before: q.before ?? undefined,
        // M1.5 filters
        status: q.status?.length ? q.status.join(',') : undefined,
        from: q.from ?? undefined,
        to: q.to ?? undefined,
        pinned: q.pinned ? 'true' : undefined,
      },
    }),
  deleteHistory: (id: number) => json<void>('DELETE', `/history/${id}`),
  clearHistory: (connectionId?: string | null) => json<void>('DELETE', '/history', { query: { connectionId } }),
  pinHistory: (id: number, pinned: boolean) => json<HistoryEntry | void>('PUT', `/history/${id}`, { body: { pinned } }),

  // 3.5 SQL services
  diagnostics: (req: DiagnosticsRequest, signal?: AbortSignal) =>
    json<DiagnosticsResponse>('POST', '/sql/diagnostics', { body: req, signal }),

  // ---------- M1.5 ----------
  // 3.7 Saved filters
  listFilters: (connectionId: string, signature?: string | null) =>
    json<SavedFilter[]>('GET', '/filters', { query: { connectionId, signature: signature ?? undefined } }),
  createFilter: (f: SavedFilterInput) => json<SavedFilter>('POST', '/filters', { body: f }),
  updateFilter: (id: string, patch: SavedFilterPatch) => json<SavedFilter>('PUT', `/filters/${enc(id)}`, { body: patch }),
  deleteFilter: (id: string) => json<void>('DELETE', `/filters/${enc(id)}`),

  // 3.8 Describe, explain, sample database
  describe: (sid: string, req: DescribeRequest, signal?: AbortSignal) =>
    json<DescribeResponse>('POST', `/sessions/${enc(sid)}/describe`, { body: req, signal }),
  /** 202; the run streams over WS and ends with `exec.plan` (then `exec.done`). */
  explain: (sid: string, req: ExplainRequest) => json<ExecuteResponse>('POST', `/sessions/${enc(sid)}/explain`, { body: req }),
  createSampleDb: (req: SampleDbRequest = {}) => json<SampleDbResponse>('POST', '/sample-db', { body: req }),

  // 3.9 Designer
  designerTypes: (cid: string, database: string | null) =>
    json<DesignerTypesResponse>('GET', `/connections/${enc(cid)}/designer/types`, { query: { database } }),
  designerTable: (cid: string, database: string | null, schema: string | null, name: string) =>
    json<TableModel>('GET', `/connections/${enc(cid)}/designer/table`, { query: { database, schema, name } }),
  scriptTable: (cid: string, req: TableScriptRequest, signal?: AbortSignal) =>
    json<TableScriptResponse>('POST', `/connections/${enc(cid)}/designer/table/script`, { body: req, signal }),
  designerView: (cid: string, database: string | null, schema: string | null, name: string) =>
    json<ViewModel>('GET', `/connections/${enc(cid)}/designer/view`, { query: { database, schema, name } }),
  scriptView: (cid: string, req: ViewScriptRequest, signal?: AbortSignal) =>
    json<DdlScript>('POST', `/connections/${enc(cid)}/designer/view/script`, { body: req, signal }),
  /** Errors: 409 DDL_FAILED with `detail: DdlFailedDetail`. */
  applyDdl: (cid: string, req: DdlApplyRequest) =>
    json<DdlApplyResponse>('POST', `/connections/${enc(cid)}/designer/apply`, { body: req }),
};

export type Api = typeof api;

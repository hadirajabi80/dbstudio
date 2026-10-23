// Saved queries (Navicat's per-schema "Queries" node): wire types and REST calls of /connections/{cid}/queries
// (engine/src/DbStudio.Core/Queries/QueriesModule.cs). Kept next to the main client (same base URL, token, client id
// and error envelope) so client.ts stays untouched.
import { API_PREFIX, ApiError, errorMessage, getClientConfig, isApiError, type ClientErrorCode } from './client';
import { CLIENT_ID_HEADER, uiClientId } from './clientId';
import type { ApiErrorBody } from './types';

/**
 * A query saved into a schema. `database` / `schema` are the explorer's names of the node it belongs to: the database
 * as the catalog keys it (null on Oracle, which has no database level) and the schema (the user on Oracle, `main` on
 * SQLite). Names are unique per (connection, database, schema), ignoring case.
 */
export interface SavedQuery {
  id: string;
  connectionId: string;
  database: string | null;
  schema: string | null;
  name: string;
  sql: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedQueryInput {
  database: string | null;
  schema: string | null;
  name: string;
  sql: string;
  description?: string | null;
}

/** Absent members are kept; an empty description clears it. */
export interface SavedQueryPatch {
  name?: string;
  sql?: string;
  description?: string;
}

/** Where a saved query lives. */
export interface SavedQueryScope {
  connectionId: string;
  database: string | null;
  schema: string | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const c = getClientConfig();
  if (!c) throw new ApiError('NETWORK', 'The Rowlit engine is not connected yet', 0);
  const headers: Record<string, string> = { Authorization: `Bearer ${c.token}`, [CLIENT_ID_HEADER]: uiClientId() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}${API_PREFIX}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError('NETWORK', `Cannot reach the Rowlit engine (${errorMessage(e)})`, 0);
  }
  const text = res.status === 204 ? '' : await res.text();
  if (!res.ok) {
    let parsed: ApiErrorBody | null = null;
    try {
      parsed = text ? (JSON.parse(text) as ApiErrorBody) : null;
    } catch {
      parsed = null;
    }
    if (parsed?.error?.code) throw new ApiError(parsed.error.code, parsed.error.message, res.status, parsed.error.detail);
    const code: ClientErrorCode = res.status === 401 ? 'UNAUTHORIZED' : res.status === 404 ? 'NOT_FOUND' : 'HTTP';
    throw new ApiError(code, `${res.status} ${res.statusText || 'HTTP error'}`, res.status);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;
const base = (cid: string) => `/connections/${enc(cid)}/queries`;

export const savedQueriesApi = {
  /** Every saved query of the connection (the UI filters by schema itself). */
  list: (cid: string) => request<SavedQuery[]>('GET', base(cid)),
  get: (cid: string, id: string) => request<SavedQuery>('GET', `${base(cid)}/${enc(id)}`),
  create: (cid: string, input: SavedQueryInput) => request<SavedQuery>('POST', base(cid), input),
  update: (cid: string, id: string, patch: SavedQueryPatch) => request<SavedQuery>('PUT', `${base(cid)}/${enc(id)}`, patch),
  remove: (cid: string, id: string) => request<void>('DELETE', `${base(cid)}/${enc(id)}`),
  duplicate: (cid: string, id: string, name?: string) => request<SavedQuery>('POST', `${base(cid)}/${enc(id)}/duplicate`, name ? { name } : {}),
};

/** 400 VALIDATION on `name` because another query of the schema already has it. */
export function isDuplicateNameError(e: unknown): boolean {
  if (!isApiError(e, 'VALIDATION')) return false;
  const d = e.detail as { field?: unknown; reason?: unknown } | null | undefined;
  return !!d && d.field === 'name' && d.reason === 'duplicate';
}

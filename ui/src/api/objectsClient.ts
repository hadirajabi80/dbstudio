// REST calls of the object browser (WP3): the Objects tab list and the Dependencies section. Kept next to the main
// client (same base URL, token, client id and error envelope) so client.ts stays untouched.
import { API_PREFIX, ApiError, errorMessage, getClientConfig, type ClientErrorCode } from './client';
import { CLIENT_ID_HEADER, uiClientId } from './clientId';
import type { ApiErrorBody, CatalogObjectType, ObjectRef } from './types';
import type { DependencyGraph, ObjectListItem } from './types.objects';

type Query = Record<string, string | null | undefined>;

async function getJson<T>(path: string, query: Query, signal?: AbortSignal): Promise<T> {
  const c = getClientConfig();
  if (!c) throw new ApiError('NETWORK', 'The Rowlit engine is not connected yet', 0);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
  const url = `${c.baseUrl}${API_PREFIX}${path}${qs.size ? `?${qs}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}`, [CLIENT_ID_HEADER]: uiClientId() }, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('ABORTED', 'Request aborted', 0);
    throw new ApiError('NETWORK', `Cannot reach the Rowlit engine (${errorMessage(e)})`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = text ? (JSON.parse(text) as ApiErrorBody) : null;
    } catch {
      body = null;
    }
    if (body?.error?.code) throw new ApiError(body.error.code, body.error.message, res.status, body.error.detail);
    const code: ClientErrorCode = res.status === 401 ? 'UNAUTHORIZED' : res.status === 404 ? 'NOT_FOUND' : 'HTTP';
    throw new ApiError(code, `${res.status} ${res.statusText || 'HTTP error'}`, res.status);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export const objectsApi = {
  /** Objects of a schema (null = every user schema of the database), optionally of one type, with statistics. */
  list: (cid: string, database: string | null, schema: string | null, type?: CatalogObjectType | null, signal?: AbortSignal) =>
    getJson<ObjectListItem[]>(`/connections/${enc(cid)}/catalog/objects`, { database, schema, type }, signal),
  /** What an object uses and what uses it (FKs, view/routine/trigger references, triggers). */
  dependencies: (cid: string, database: string | null, ref: Pick<ObjectRef, 'schema' | 'name' | 'type'>, signal?: AbortSignal) =>
    getJson<DependencyGraph>(`/connections/${enc(cid)}/catalog/dependencies`, { database, schema: ref.schema, name: ref.name, type: ref.type }, signal),
};

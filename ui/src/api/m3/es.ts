// `api.es.*`: Elasticsearch / OpenSearch module endpoints (plan-batch3 WP-ES), wire types in ../types.es.ts. Part of the
// initial bundle (api/client.ts): thin request wrappers only. Writes answer 403 READ_ONLY on read-only connections;
// reindex/import/export answer 202 { jobId } (export without a path answers with the file).
import type { M2Http } from '../client';
import type { JobStarted } from '../types';
import type {
  EsAlias, EsAliasesRequest, EsCluster, EsConsoleRequest, EsConsoleResponse, EsCreateIndexRequest, EsDataStream, EsDoc, EsExportRequest,
  EsField, EsImportRequest, EsIndexAction, EsIndexDetail, EsIndexSummary, EsNode, EsPutDocRequest, EsReindexRequest, EsSearchRequest,
  EsSearchResponse, EsSqlRequest, EsSqlResponse, EsSqlTranslateResponse, EsTask, EsTemplate, EsWriteResult,
} from '../types.es';

export function createEsApi(http: M2Http) {
  const { json, enc } = http;
  const p = (cid: string, rest: string) => `/es/${enc(cid)}${rest}`;
  const ix = (cid: string, index: string, rest = '') => p(cid, `/indices/${enc(index)}${rest}`);
  const get = <T>(cid: string, rest: string, query?: Record<string, string | number | boolean | null | undefined>, signal?: AbortSignal) =>
    json<T>('GET', p(cid, rest), { query, signal });
  const post = <T>(cid: string, rest: string, body: unknown, signal?: AbortSignal) => json<T>('POST', p(cid, rest), { body, signal });
  return {
    cluster: (cid: string) => get<EsCluster>(cid, '/cluster'),
    nodes: (cid: string) => get<EsNode[]>(cid, '/nodes'),
    indices: (cid: string, hidden = false) => get<EsIndexSummary[]>(cid, '/indices', { hidden }),
    index: (cid: string, index: string) => json<EsIndexDetail>('GET', ix(cid, index)),
    fields: (cid: string, index: string, signal?: AbortSignal) => json<EsField[]>('GET', ix(cid, index, '/fields'), { signal }),
    createIndex: (cid: string, body: EsCreateIndexRequest) => post<void>(cid, '/indices', body),
    deleteIndex: (cid: string, index: string) => json<void>('DELETE', ix(cid, index)),
    indexAction: (cid: string, index: string, action: EsIndexAction) => json<unknown>('POST', ix(cid, index, `/actions/${action}`)),
    putSettings: (cid: string, index: string, settings: unknown) => json<void>('PUT', ix(cid, index, '/settings'), { body: { settings } }),
    putMappings: (cid: string, index: string, mappings: unknown) => json<void>('PUT', ix(cid, index, '/mappings'), { body: { mappings } }),
    aliases: (cid: string) => get<EsAlias[]>(cid, '/aliases'),
    updateAliases: (cid: string, body: EsAliasesRequest) => post<void>(cid, '/aliases', body),
    dataStreams: (cid: string) => get<EsDataStream[]>(cid, '/datastreams'),
    templates: (cid: string) => get<EsTemplate[]>(cid, '/templates'),
    search: (cid: string, body: EsSearchRequest, signal?: AbortSignal) => post<EsSearchResponse>(cid, '/search', body, signal),
    doc: (cid: string, index: string, id: string, routing?: string | null) =>
      json<EsDoc>('GET', ix(cid, index, `/docs/${enc(id)}`), { query: { routing } }),
    putDoc: (cid: string, index: string, id: string, body: EsPutDocRequest) => json<EsWriteResult>('PUT', ix(cid, index, `/docs/${enc(id)}`), { body }),
    createDoc: (cid: string, index: string, body: EsPutDocRequest) => json<EsWriteResult>('POST', ix(cid, index, '/docs'), { body }),
    deleteDoc: (cid: string, index: string, id: string, cc?: { ifSeqNo?: number | null; ifPrimaryTerm?: number | null; routing?: string | null }) =>
      json<EsWriteResult>('DELETE', ix(cid, index, `/docs/${enc(id)}`), { query: cc }),
    sql: (cid: string, body: EsSqlRequest, signal?: AbortSignal) => post<EsSqlResponse>(cid, '/sql', body, signal),
    sqlClose: (cid: string, cursor: string) => post<void>(cid, '/sql/close', { cursor }),
    sqlTranslate: (cid: string, query: string) => post<EsSqlTranslateResponse>(cid, '/sql/translate', { query }),
    console: (cid: string, body: EsConsoleRequest, signal?: AbortSignal) => post<EsConsoleResponse>(cid, '/console', body, signal),
    tasks: (cid: string, actions?: string) => get<EsTask[]>(cid, '/tasks', { actions, detailed: true }),
    cancelTask: (cid: string, taskId: string) => post<void>(cid, `/tasks/${enc(taskId)}/cancel`, {}),
    reindex: (cid: string, body: EsReindexRequest) => post<JobStarted>(cid, '/reindex', body),
    importDocs: (cid: string, body: EsImportRequest) => post<JobStarted>(cid, '/import', body),
    /** With `path`: 202 { jobId }; without: the file (Response). */
    exportDocs: (cid: string, body: EsExportRequest) => http.send('POST', p(cid, '/export'), { body }),
  };
}

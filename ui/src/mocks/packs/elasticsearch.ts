// Elasticsearch / OpenSearch mock pack (plan-batch3 WP-ES): provider entry (form spec mirrors EsProvider), the sample
// connection (folder "Batch 3") and the `/es/{cid}/…` routes over an in-memory cluster (ui/src/es/mock: the shop
// indices of seed-elasticsearch.ndjson, a data stream, templates, 3 nodes), jobs (reindex/import/export with progress)
// and the `es.tasks` stream. Hosts matching /fail|nowhere/ answer 503 like the engine does when a cluster is down.
import { http, HttpResponse, type RequestHandler } from 'msw';
import type { ConnectionProfile, ProviderInfo, StreamKind } from '../../api/types';
import type {
  EsAliasesRequest, EsConsoleRequest, EsCreateIndexRequest, EsExportRequest, EsImportRequest, EsPutDocRequest, EsReindexRequest, EsSearchRequest, EsSqlRequest,
} from '../../api/types.es';
import { isPlainObject } from '../../es/json';
import { EsMock, EsMockError } from '../../es/mock/engine';
import type { M2MockContext } from '../m2';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"). */
export const elasticsearchConnections: ConnectionProfile[] = [
  { id: 'c_es', name: 'Elasticsearch Dev', providerId: 'elasticsearch', color: null, folder: 'Batch 3', readOnly: false,
      props: { url: 'http://es-dev:9200', auth: 'none', flavor: 'auto' },
      hasPassword: false, savePassword: false, createdAt: PACK_NOW, lastUsedAt: null },
];

export const elasticsearchProvider: ProviderInfo = {
  id: 'elasticsearch',
  displayName: 'Elasticsearch / OpenSearch',
  dialect: null,
  kind: 'search',
  formSpec: {
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'http://localhost:9200', help: 'One or more node URLs, comma separated (https://node1:9200,https://node2:9200).' },
      { key: 'auth', label: 'Authentication', type: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'basic', label: 'User and password' }, { value: 'apiKey', label: 'API key' }, { value: 'bearer', label: 'Bearer token' }] },
      { key: 'user', label: 'User', type: 'text', visibleWhen: { auth: 'basic' } },
      { key: 'password', label: 'Password', type: 'password', visibleWhen: { auth: 'basic' } },
      { key: 'apiKey', label: 'API key', type: 'password', visibleWhen: { auth: 'apiKey' }, help: 'The encoded key, or id:api_key.' },
      { key: 'token', label: 'Bearer token', type: 'password', visibleWhen: { auth: 'bearer' } },
      { key: 'tlsSkipVerify', label: 'Skip TLS verification', type: 'bool', default: false, help: 'Accept any server certificate (self-signed development clusters).' },
      { key: 'caFile', label: 'CA certificate', type: 'file', fileFilter: '*.pem;*.crt;*.cer' },
      { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 10 },
      { key: 'flavor', label: 'Flavor', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Detect' }, { value: 'elasticsearch', label: 'Elasticsearch' }, { value: 'opensearch', label: 'OpenSearch' }] },
    ],
  },
};

const P = '*/api/v1/es/:cid';
const TASKS_STREAM: StreamKind = 'es.tasks';

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

function esError(e: EsMockError): HttpError {
  const status = e.status === 404 ? 404 : e.status === 409 ? 409 : e.status === 401 || e.status === 403 ? 403 : 422;
  const code = status === 404 ? 'NOT_FOUND' : status === 403 ? 'PRIVILEGE' : 'PROVIDER_ERROR';
  return new HttpError(status, code, `${e.esType}: ${e.message}`, { status: e.status, esType: e.esType, rootCause: null });
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new Error('Cancelled'));
  });
});

/** NDJSON / JSON array / CSV text → documents. */
function parseFile(text: string, format: string, delimiter = ','): Record<string, unknown>[] {
  if (format === 'json') {
    const v = JSON.parse(text) as unknown;
    return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (format === 'csv') {
    const head = lines[0]?.split(delimiter).map((h) => h.trim()) ?? [];
    return lines.slice(1).map((l) => Object.fromEntries(l.split(delimiter).map((v, i) => {
      const n = Number(v);
      return [head[i] ?? `col${i + 1}`, v !== '' && Number.isFinite(n) ? n : v];
    })));
  }
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    const v = JSON.parse(l) as Record<string, unknown>;
    if (isPlainObject(v) && Object.keys(v).length === 1 && ['index', 'create'].includes(Object.keys(v)[0])) continue;
    out.push(v);
  }
  return out;
}

function exportText(docs: { index: string; id: string; source: Record<string, unknown> }[], req: EsExportRequest): string {
  const pickFields = (s: Record<string, unknown>) => (req.fields?.length ? Object.fromEntries(req.fields.map((f) => [f, s[f]])) : s);
  if (req.format === 'csv') {
    const cols = req.fields?.length ? req.fields : [...new Set(docs.slice(0, 1000).flatMap((d) => Object.keys(d.source)))];
    const cell = (v: unknown) => {
      const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return `${['_id', ...cols].join(',')}\n${docs.map((d) => [d.id, ...cols.map((c) => d.source[c])].map(cell).join(',')).join('\n')}\n`;
  }
  const item = (d: (typeof docs)[number]) => (req.includeMeta ? { _index: d.index, _id: d.id, _source: pickFields(d.source) } : pickFields(d.source));
  return req.format === 'json' ? JSON.stringify(docs.map(item), null, 2) : `${docs.map((d) => JSON.stringify(item(d))).join('\n')}\n`;
}

function createHandlers(ctx: M2MockContext): RequestHandler[] {
  const es = new EsMock();

  ctx.streams.register(TASKS_STREAM, ({ push, signal, params }) => {
    const tick = () => push([{ at: new Date().toISOString(), tasks: es.listTasks() }]);
    tick();
    const t = setInterval(tick, Math.max(1000, Number(params.intervalMs ?? 2000)));
    signal.addEventListener('abort', () => clearInterval(t));
  });

  const route = <T,>(fn: (a: { cid: string; p: Record<string, string>; body: T; url: URL; readOnly: boolean }) => unknown) =>
    async ({ params, request }: { params: Record<string, string | readonly string[] | undefined>; request: Request }) => {
      const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, decodeURIComponent(String(v ?? ''))]));
      const conn = ctx.engine.conn(p.cid);
      if (!conn || conn.providerId !== 'elasticsearch') return err(400, 'VALIDATION', `Connection '${p.cid}' is not an Elasticsearch connection.`);
      if (/fail|nowhere/i.test(String(conn.props.url ?? ''))) return err(503, 'SOURCE_UNAVAILABLE', `Cannot reach ${String(conn.props.url)}: connection refused`);
      ctx.clients.get(p.cid);
      let body = {} as T;
      if (request.method !== 'GET' && request.headers.get('content-type')?.includes('json')) body = (await request.json().catch(() => ({}))) as T;
      try {
        const r = await fn({ cid: p.cid, p, body, url: new URL(request.url), readOnly: !!conn.readOnly });
        if (r instanceof Response) return r;
        return r === undefined ? new HttpResponse(null, { status: 204 }) : ctx.ok(r as never);
      } catch (e) {
        if (e instanceof EsMockError) {
          const h = esError(e);
          return err(h.status, h.code, h.message, h.detail);
        }
        if (e instanceof HttpError) return err(e.status, e.code, e.message, e.detail);
        throw e;
      }
    };

  const guard = (a: { cid: string; readOnly: boolean }, action: string) => {
    if (a.readOnly) throw new HttpError(403, 'READ_ONLY', `The connection '${ctx.engine.conn(a.cid)?.name ?? a.cid}' is read-only: ${action} is not allowed.`, { action });
  };
  const started = (jobId: string) => HttpResponse.json({ jobId }, { status: 202 });

  return [
    http.get(`${P}/cluster`, route(() => es.cluster())),
    http.get(`${P}/nodes`, route(() => es.nodes())),
    http.get(`${P}/indices`, route(({ url }) => es.listIndices(url.searchParams.get('hidden') === 'true'))),
    http.post(`${P}/indices`, route<EsCreateIndexRequest>((a) => {
      guard(a, `creating index '${a.body.name}'`);
      const body = (isPlainObject(a.body.body) ? a.body.body : {}) as Record<string, unknown>;
      es.createIndex(a.body.name, body, a.body.shards ?? 1, a.body.replicas ?? 1);
      return undefined;
    })),
    http.get(`${P}/indices/:index`, route(({ p }) => es.detail(p.index))),
    http.delete(`${P}/indices/:index`, route((a) => {
      guard(a, `deleting index '${a.p.index}'`);
      es.deleteIndex(a.p.index);
      return undefined;
    })),
    http.post(`${P}/indices/:index/actions/:action`, route((a) => {
      if (a.p.action !== 'refresh' && a.p.action !== 'clearcache') guard(a, `${a.p.action} on '${a.p.index}'`);
      const ixs = es.resolve(a.p.index);
      if (a.p.action === 'open' || a.p.action === 'close') ixs.forEach((ix) => (ix.status = a.p.action === 'open' ? 'open' : 'close'));
      else if (!['refresh', 'flush', 'forcemerge', 'clearcache'].includes(a.p.action)) throw new HttpError(400, 'VALIDATION', `Unknown index action '${a.p.action}'.`, { field: 'action' });
      return { acknowledged: true, _shards: { total: 2, successful: 2, failed: 0 } };
    })),
    http.put(`${P}/indices/:index/settings`, route<{ settings: Record<string, unknown> }>((a) => {
      guard(a, `changing the settings of '${a.p.index}'`);
      es.putSettings(a.p.index, a.body.settings ?? {});
      return undefined;
    })),
    http.put(`${P}/indices/:index/mappings`, route<{ mappings: Record<string, unknown> }>((a) => {
      guard(a, `changing the mapping of '${a.p.index}'`);
      es.putMapping(a.p.index, a.body.mappings ?? {});
      return undefined;
    })),
    http.get(`${P}/indices/:index/fields`, route(({ p }) => es.fieldsOf(p.index))),
    http.get(`${P}/aliases`, route(() => es.aliases())),
    http.post(`${P}/aliases`, route<EsAliasesRequest>((a) => {
      guard(a, 'changing aliases');
      for (const x of a.body.actions ?? []) {
        if (x.add) es.applyAlias({ add: { index: x.add.index, alias: x.add.alias, is_write_index: x.add.isWriteIndex ?? undefined, filter: x.add.filter } });
        if (x.remove) es.applyAlias({ remove: { index: x.remove.index, alias: x.remove.alias } });
      }
      return undefined;
    })),
    http.get(`${P}/datastreams`, route(() => es.dataStreams())),
    http.get(`${P}/templates`, route(() => es.templates())),
    http.post(`${P}/search`, route<EsSearchRequest>(({ body }) =>
      es.searchNormalised(body.index, (isPlainObject(body.body) ? body.body : {}) as Record<string, unknown>, body))),
    http.get(`${P}/indices/:index/docs/:id`, route(({ p }) => {
      const ix = es.resolve(p.index)[0];
      const d = ix?.docs.get(p.id);
      return { index: ix?.name ?? p.index, id: p.id, found: !!d, seqNo: d?.seqNo ?? null, primaryTerm: d?.primaryTerm ?? null, version: d?.version ?? null, routing: null, source: d?.source ?? null };
    })),
    http.put(`${P}/indices/:index/docs/:id`, route<EsPutDocRequest>((a) => {
      guard(a, `writing document '${a.p.id}'`);
      return es.putDoc(a.p.index, a.p.id, a.body.source as Record<string, unknown>, { ifSeqNo: a.body.ifSeqNo, ifPrimaryTerm: a.body.ifPrimaryTerm, create: a.body.create });
    })),
    http.post(`${P}/indices/:index/docs`, route<EsPutDocRequest>((a) => {
      guard(a, 'indexing a document');
      return es.putDoc(a.p.index, null, a.body.source as Record<string, unknown>, {});
    })),
    http.delete(`${P}/indices/:index/docs/:id`, route((a) => {
      guard(a, `deleting document '${a.p.id}'`);
      const q = a.url.searchParams;
      return es.deleteDoc(a.p.index, a.p.id, { ifSeqNo: q.has('ifSeqNo') ? Number(q.get('ifSeqNo')) : null, ifPrimaryTerm: q.has('ifPrimaryTerm') ? Number(q.get('ifPrimaryTerm')) : null });
    })),
    http.post(`${P}/sql`, route<EsSqlRequest>(({ body }) => (body.cursor ? es.sqlNext(body.cursor) : es.sql(body.query, body.fetchSize ?? 1000)))),
    http.post(`${P}/sql/close`, route<{ cursor: string }>(({ body }) => {
      es.cursors.delete(body.cursor);
      return undefined;
    })),
    http.post(`${P}/sql/translate`, route<{ query: string }>(({ body }) => ({ dsl: es.translate(body.query) }))),
    http.post(`${P}/console`, route<EsConsoleRequest>((a) => {
      const method = a.body.method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].includes(method)) throw new HttpError(400, 'VALIDATION', `Method ${method} is not supported (GET, POST, PUT, DELETE, HEAD).`, { field: 'method' });
      if (/^\w+:\/\/|\.\.|[\r\n\\#]/.test(a.body.path)) throw new HttpError(400, 'VALIDATION', 'The path must be relative to the cluster (no scheme, host or ..).', { field: 'path' });
      try {
        return es.console(method, a.body.path, a.body.body ?? null, a.readOnly);
      } catch (e) {
        if ((e as { readOnly?: boolean }).readOnly) throw new HttpError(403, 'READ_ONLY', (e as Error).message, { action: `${method} ${a.body.path}` });
        throw e;
      }
    })),
    http.get(`${P}/tasks`, route(() => es.listTasks())),
    http.post(`${P}/tasks/:taskId/cancel`, route((a) => {
      guard(a, 'cancelling a task');
      if (!es.cancelTask(a.p.taskId)) throw new HttpError(404, 'NOT_FOUND', `Task '${a.p.taskId}' was not found.`);
      return undefined;
    })),
    http.post(`${P}/reindex`, route<EsReindexRequest>((a) => {
      guard(a, 'reindex');
      const docs = es.docsOf(a.body.source, a.body.query);
      const list = a.body.maxDocs ? docs.slice(0, a.body.maxDocs) : docs;
      if (!es.writeTarget(a.body.dest)) {
        const src = es.resolve(a.body.source)[0];
        es.createIndex(a.body.dest, src ? { mappings: structuredClone(src.mappings) } : {}, 1, 1);
      }
      const task = es.startTask('indices:data/write/reindex', `reindex from [${a.body.source}] to [${a.body.dest}]`, list.length);
      return started(ctx.jobs.start('es.reindex', async (report, signal) => {
        const t0 = Date.now();
        let created = 0;
        let updated = 0;
        try {
          for (let i = 0; i < list.length; i += 100) {
            if (task.cancelled) throw new Error('Cancelled');
            for (const d of list.slice(i, i + 100)) {
              const r = es.putDoc(a.body.dest, d.id, d.source, {});
              if (r.result === 'created') created++;
              else updated++;
            }
            task.status = { ...task.status, created, updated, batches: task.status.batches + 1 };
            report(Math.min(list.length, i + 100), list.length, `${created} created, ${updated} updated`);
            await sleep(60, signal);
          }
        } finally {
          es.tasks.delete(task.id);
        }
        return { taskId: task.id, total: list.length, created, updated, deleted: 0, versionConflicts: 0, failures: [], tookMs: Date.now() - t0 };
      }));
    })),
    http.post(`${P}/import`, route<EsImportRequest>((a) => {
      guard(a, 'import');
      if (!a.body.upload && a.body.path) throw new HttpError(400, 'VALIDATION', 'The mock engine reads uploads only (no file paths).', { field: 'path' });
      let docs: Record<string, unknown>[];
      try {
        docs = parseFile(a.body.upload ?? '', a.body.format, a.body.csv?.delimiter ?? ',');
      } catch (e) {
        throw new HttpError(400, 'VALIDATION', `The file is not valid ${a.body.format.toUpperCase()}: ${(e as Error).message}`, { field: 'upload' });
      }
      const size = Math.max(1, a.body.batchSize ?? 1000);
      return started(ctx.jobs.start('es.import', async (report, signal) => {
        const t0 = Date.now();
        let indexed = 0;
        let failed = 0;
        const errors: string[] = [];
        for (let i = 0; i < docs.length; i += size) {
          for (const d of docs.slice(i, i + size)) {
            try {
              const id = a.body.idField ? String(d[a.body.idField] ?? '') || null : null;
              es.putDoc(a.body.index, id, d, {});
              indexed++;
            } catch (e) {
              failed++;
              if (errors.length < 20) errors.push((e as Error).message);
            }
          }
          report(Math.min(docs.length, i + size), docs.length);
          await sleep(40, signal);
        }
        return { indexed, failed, errors, tookMs: Date.now() - t0 };
      }));
    })),
    http.post(`${P}/export`, route<EsExportRequest>((a) => {
      const docs = es.docsOf(a.body.index, a.body.query);
      const list = a.body.max ? docs.slice(0, a.body.max) : docs;
      const text = exportText(list, a.body);
      if (!a.body.path) {
        return new HttpResponse(text, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${a.body.index}.${a.body.format}"` } });
      }
      return started(ctx.jobs.start('es.export', async (report, signal) => {
        for (let i = 0; i < list.length; i += 500) {
          report(Math.min(list.length, i + 500), list.length);
          await sleep(30, signal);
        }
        return { path: a.body.path, docs: list.length };
      }));
    })),
  ];
}

export const elasticsearchPack: MockProviderPack = {
  providers: [elasticsearchProvider],
  // fresh copies per mock engine: tests flip readOnly on the engine's connection object
  get connections() {
    return elasticsearchConnections.map((c) => ({ ...c, props: { ...c.props } }));
  },
  extraObjects: {},
  handlers: (ctx) => createHandlers(ctx),
};

// MSW request handlers that front the in-memory MockEngine (section 3 REST contract).
import { delay, http, HttpResponse, type JsonBodyType } from 'msw';
import type {
  ConnectionInput, CreateSessionRequest, ExecuteRequest, ObjectRef, ResultSetExportRequest, Settings, TestConnectionRequest, TxMode,
} from '../api/types';
import { serializeRows } from '../lib/serialize';
import { MockEngine } from './engine';
import { createM15Handlers } from './m15/m15Handlers';

const P = '*/api/v1';

function err(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function refFrom(url: URL): ObjectRef {
  return {
    database: url.searchParams.get('database') || null,
    schema: url.searchParams.get('schema') || null,
    name: url.searchParams.get('name') ?? '',
    type: (url.searchParams.get('type') ?? 'table') as ObjectRef['type'],
  };
}

export function createHandlers(engine: MockEngine) {
  const wait = () => (engine.opts.latency ? delay(engine.opts.latency) : Promise.resolve());
  const ok = async (body: JsonBodyType, init?: ResponseInit) => {
    await wait();
    return HttpResponse.json(body, init);
  };

  return [
    http.all(`${P}/*`, ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (!auth?.startsWith('Bearer ') || auth.length <= 7) return err(401, 'UNAUTHORIZED', 'Missing token');
      return undefined; // fall through to the specific handler
    }),
    http.get(`${P}/health`, () => ok({ status: 'ok', version: '0.1.0-mock', pid: 1, dev: true })),
    http.get(`${P}/providers`, () => ok(engine.providers())),
    http.get(`${P}/settings`, () => ok(engine.settings)),
    http.put(`${P}/settings`, async ({ request }) => {
      const p = (await request.json()) as Partial<Settings>;
      engine.settings = {
        ...engine.settings, ...p,
        editor: { ...engine.settings.editor, ...p.editor }, results: { ...engine.settings.results, ...p.results }, ui: { ...engine.settings.ui, ...p.ui },
      };
      return ok(engine.settings);
    }),

    // connections
    http.get(`${P}/connections`, () => ok(engine.connections)),
    http.post(`${P}/connections/test`, async ({ request }) => {
      const body = (await request.json()) as TestConnectionRequest;
      await delay(engine.opts.latency || 250);
      return HttpResponse.json(engine.test(body.profile));
    }),
    http.post(`${P}/connections`, async ({ request }) => ok(engine.createConnection((await request.json()) as ConnectionInput), { status: 201 })),
    http.put(`${P}/connections/:id`, async ({ request, params }) => {
      const c = engine.updateConnection(String(params.id), (await request.json()) as ConnectionInput);
      return c ? ok(c) : err(404, 'NOT_FOUND', 'Connection not found');
    }),
    http.delete(`${P}/connections/:id`, ({ params }) => {
      engine.deleteConnection(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),

    // catalog
    http.get(`${P}/connections/:id/catalog/databases`, ({ params }) => {
      const id = String(params.id);
      return engine.conn(id) ? ok(engine.databases(id)) : err(404, 'NOT_FOUND', 'Connection not found');
    }),
    http.get(`${P}/connections/:id/catalog/schemas`, ({ params, request }) => {
      const id = String(params.id);
      if (!engine.conn(id)) return err(404, 'NOT_FOUND', 'Connection not found');
      return ok(engine.schemas(id, new URL(request.url).searchParams.get('database') || null));
    }),
    http.get(`${P}/connections/:id/catalog/object`, ({ params, request }) => ok(engine.details(String(params.id), refFrom(new URL(request.url))))),
    http.get(`${P}/connections/:id/catalog/ddl`, ({ params, request }) => ok(engine.ddl(String(params.id), refFrom(new URL(request.url))))),
    http.get(`${P}/connections/:id/catalog/errors`, () => ok([])),
    http.post(`${P}/connections/:id/catalog/refresh`, ({ params }) => ok({ version: engine.schemaVersion(String(params.id), null) })),
    http.get(`${P}/connections/:id/catalog`, async ({ params, request }) => {
      const id = String(params.id);
      if (!engine.conn(id)) return err(404, 'NOT_FOUND', 'Connection not found');
      const url = new URL(request.url);
      const schemas = url.searchParams.get('schemas')?.split(',').filter(Boolean) ?? null;
      const db = url.searchParams.get('database') || null;
      const etag = `"v${engine.schemaVersion(id, schemas)}"`;
      if (request.headers.get('If-None-Match') === etag) return new HttpResponse(null, { status: 304, headers: { ETag: etag } });
      await wait();
      return HttpResponse.json(engine.catalog(id, db, schemas), { headers: { ETag: etag } });
    }),

    // sessions
    http.post(`${P}/sessions`, async ({ request }) => {
      const b = (await request.json()) as CreateSessionRequest;
      const s = engine.createSession(b.connectionId, b.database, b.txMode);
      return s ? ok(s) : err(404, 'NOT_FOUND', 'Connection not found');
    }),
    http.get(`${P}/sessions`, () => ok([...engine.sessions.values()].map((s) => engine.info(s)))),
    http.delete(`${P}/sessions/:sid`, ({ params, request }) => {
      const s = engine.sessions.get(String(params.sid));
      if (!s) return err(404, 'NOT_FOUND', 'Session not found');
      if (s.txOpen && new URL(request.url).searchParams.get('force') !== 'true') return err(409, 'TX_OPEN', 'Transaction is open');
      engine.sessions.delete(s.sessionId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${P}/sessions/:sid/database`, async ({ params, request }) => {
      const s = engine.sessions.get(String(params.sid));
      if (!s) return err(404, 'NOT_FOUND', 'Session not found');
      s.database = ((await request.json()) as { database: string }).database;
      engine.changed(s);
      return ok(engine.info(s));
    }),
    http.post(`${P}/sessions/:sid/tx-mode`, async ({ params, request }) => {
      const s = engine.sessions.get(String(params.sid));
      if (!s) return err(404, 'NOT_FOUND', 'Session not found');
      const mode = ((await request.json()) as { txMode: TxMode }).txMode;
      if (mode === 'auto' && s.txOpen) return err(409, 'TX_OPEN', 'Commit or roll back first');
      s.txMode = mode;
      engine.changed(s);
      return ok(engine.info(s));
    }),
    http.post(`${P}/sessions/:sid/commit`, ({ params }) => {
      const s = engine.sessions.get(String(params.sid));
      if (!s) return err(404, 'NOT_FOUND', 'Session not found');
      s.txOpen = false;
      engine.changed(s);
      return ok(engine.info(s));
    }),
    http.post(`${P}/sessions/:sid/rollback`, ({ params }) => {
      const s = engine.sessions.get(String(params.sid));
      if (!s) return err(404, 'NOT_FOUND', 'Session not found');
      s.txOpen = false;
      engine.changed(s);
      return ok(engine.info(s));
    }),
    http.post(`${P}/sessions/:sid/execute`, async ({ params, request }) => {
      const r = engine.execute(String(params.sid), (await request.json()) as ExecuteRequest);
      if ('error' in r) return err(r.code === 'SESSION_BUSY' ? 409 : r.code === 'READ_ONLY' ? 403 : 404, r.code, r.error);
      return HttpResponse.json({ executionId: r.executionId, startedAt: new Date().toISOString() }, { status: 202 });
    }),
    http.post(`${P}/sessions/:sid/cancel`, ({ params }) => ok({ cancelled: engine.cancel(String(params.sid)) })),

    // results
    http.get(`${P}/executions/:xid/resultsets/:rs/rows`, ({ params, request }) => {
      const url = new URL(request.url);
      const page = engine.rowsPage(String(params.xid), Number(params.rs), Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 1000));
      return page ? ok(page) : err(404, 'NOT_FOUND', 'Result set no longer available');
    }),
    http.get(`${P}/executions/:xid/resultsets/:rs/cell`, ({ params, request }) => {
      const url = new URL(request.url);
      const c = engine.cell(String(params.xid), Number(params.rs), Number(url.searchParams.get('row')), Number(url.searchParams.get('col')));
      return c ? ok(c) : err(404, 'NOT_FOUND', 'Cell not available');
    }),
    http.post(`${P}/executions/:xid/resultsets/:rs/export`, async ({ params, request }) => {
      const body = (await request.json()) as ResultSetExportRequest;
      const set = engine.resultSet(String(params.xid), Number(params.rs));
      if (!set) return err(404, 'NOT_FOUND', 'Result set no longer available');
      const text = serializeRows(body.format === 'sql-insert' ? 'sql-insert' : body.format, set.columns, set.rows, { header: body.options.header ?? true });
      if (body.path) return ok({ path: body.path, rows: set.rows.length });
      const ext = body.format === 'sql-insert' ? 'sql' : body.format;
      return new HttpResponse(text, {
        headers: { 'Content-Type': body.format === 'json' ? 'application/octet-stream' : 'text/plain', 'Content-Disposition': `attachment; filename="result.${ext}"` },
      });
    }),

    // history
    http.get(`${P}/history`, ({ request }) => {
      const url = new URL(request.url);
      const q = url.searchParams.get('q')?.toLowerCase();
      const cid = url.searchParams.get('connectionId');
      // M1.5 filters (3.7)
      const status = url.searchParams.get('status')?.split(',').filter(Boolean);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const pinned = url.searchParams.get('pinned') === 'true';
      return ok(engine.history.filter((h) => (!q || h.sql.toLowerCase().includes(q)) && (!cid || h.connectionId === cid)
        && (!status?.length || status.includes(h.status)) && (!from || h.startedAt >= from) && (!to || h.startedAt <= to) && (!pinned || h.pinned))
        .slice(0, Number(url.searchParams.get('limit') ?? 200)));
    }),
    http.put(`${P}/history/:id`, async ({ params, request }) => {
      const h = engine.history.find((x) => x.id === Number(params.id));
      if (!h) return err(404, 'NOT_FOUND', 'Not found');
      h.pinned = ((await request.json()) as { pinned: boolean }).pinned;
      return ok(h);
    }),
    http.delete(`${P}/history/:id`, ({ params }) => {
      engine.history = engine.history.filter((x) => x.id !== Number(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${P}/history`, ({ request }) => {
      const cid = new URL(request.url).searchParams.get('connectionId');
      engine.history = engine.history.filter((x) => x.pinned || (cid && x.connectionId !== cid));
      return new HttpResponse(null, { status: 204 });
    }),

    // M1.5: sample database (3.8)
    http.post(`${P}/sample-db`, () => {
      const path = String.raw`C:\Users\me\AppData\Roaming\DbStudio\sample\shop.sqlite`;
      const existing = engine.connections.find((c) => c.name === 'Sample: Shop');
      const profile = existing ?? engine.createConnection({ name: 'Sample: Shop', providerId: 'sqlite', color: null, folder: null, readOnly: false, props: { path }, savePassword: false, password: null });
      return ok({ path, connectionId: profile.id, profile, created: !existing });
    }),

    // sql services
    http.post(`${P}/sql/diagnostics`, async ({ request }) => {
      const b = (await request.json()) as { sql: string };
      const diagnostics: unknown[] = [];
      b.sql.split('\n').forEach((line, i) => {
        const m = /\b(FORM|SELEC|FRMO|WHER)\b/i.exec(line);
        if (m) diagnostics.push({ line: i + 1, col: m.index + 1, endLine: i + 1, endCol: m.index + 1 + m[0].length, severity: 'error', code: 'MOCK01', message: `Incorrect syntax near '${m[0]}'.` });
      });
      return ok({ diagnostics, engine: 'mock' });
    }),

    // M1.5: explain, describe, designer, query export
    ...createM15Handlers(engine),
  ];
}

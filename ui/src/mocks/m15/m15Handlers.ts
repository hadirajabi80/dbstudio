// M1.5 routes for the mock engine (logic-15): explain (exec.plan streamed over the FakeSocket bus from the plan
// fixtures), describe, the table/view designer (types, model, script, apply) and query export. Included by
// createHandlers(), so `npm run dev:mock` and the MSW test servers both serve them.
import { http, HttpResponse } from 'msw';
import type {
  DdlApplyRequest, DescribeRequest, ExplainRequest, QueryExportRequest, TableScriptRequest, ViewScriptRequest, WsEvent,
} from '../../api/types';
import type { MockEngine } from '../engine';
import { stripComments } from '../engine';
import applyFailed from '../fixtures/m15/designer/apply-ddl-failed.json';
import applyOk from '../fixtures/m15/designer/apply-ok.json';
import scriptAddColumn from '../fixtures/m15/designer/sqlite-script-add-column.json';
import scriptCreate from '../fixtures/m15/designer/sqlite-script-create.json';
import scriptRebuild from '../fixtures/m15/designer/sqlite-script-rebuild.json';
import tableCustomers from '../fixtures/m15/designer/sqlite-table-customers.json';
import tableOrderLines from '../fixtures/m15/designer/sqlite-table-orderlines.json';
import tableOrders from '../fixtures/m15/designer/sqlite-table-orders.json';
import designerTypes from '../fixtures/m15/designer/sqlite-types.json';
import viewModel from '../fixtures/m15/designer/sqlite-view-customerordertotals.json';
import viewScript from '../fixtures/m15/designer/sqlite-view-script.json';
import describeJoin from '../fixtures/m15/describe/sqlite-join.json';
import describeProducts from '../fixtures/m15/describe/sqlite-products.json';
import planOracleEstimated from '../fixtures/m15/plans/oracle-estimated.json';
import planSqliteActual from '../fixtures/m15/plans/sqlite-actual.json';
import planSqliteEstimated from '../fixtures/m15/plans/sqlite-estimated.json';
import planSqlServerActual from '../fixtures/m15/plans/sqlserver-actual.json';
import planSqlServerEstimated from '../fixtures/m15/plans/sqlserver-estimated.json';
import pgDesignerTypes from '../fixtures/m15/designer/pgsql-types.json';
import planPgActual from '../fixtures/m15/plans/pgsql-actual.json';
import planPgEstimated from '../fixtures/m15/plans/pgsql-estimated.json';
import { pgTableModel, scriptPgTable, scriptPgView } from './pgDesigner';

const P = '*/api/v1';

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, ...(detail !== undefined ? { detail } : {}) } }, { status });
}

const PLANS: Record<string, Record<string, unknown>> = {
  'sqlite:estimated': planSqliteEstimated, 'sqlite:actual': planSqliteActual,
  'sqlserver:estimated': planSqlServerEstimated, 'sqlserver:actual': planSqlServerActual,
  'oracle:estimated': planOracleEstimated, 'oracle:actual': planOracleEstimated,
  'postgresql:estimated': planPgEstimated, 'postgresql:actual': planPgActual,
};

const TABLES: Record<string, unknown> = { customers: tableCustomers, orders: tableOrders, orderlines: tableOrderLines };

/** Statements that change data (the mock's read-only rule, like MockEngine.execute). */
const WRITES = /^\s*(with\b[\s\S]*?\)\s*)?(insert|update|delete|merge|create|drop|alter|truncate|replace)\b/i;

let seq = 0;

export function createM15Handlers(engine: MockEngine) {
  const isPg = (cid: string) => engine.conn(cid)?.providerId === 'postgresql';
  const emitLater = (events: Omit<WsEvent, 'ts'>[]) => {
    setTimeout(() => {
      for (const ev of events) engine.emit(ev as WsEvent);
    }, 0);
  };

  return [
    // 3.8 explain: 202, then exec.started → exec.plan → exec.done over the socket.
    http.post(`${P}/sessions/:sid/explain`, async ({ params, request }) => {
      const s = engine.sessions.get(String(params.sid));
      if (!s) return err(404, 'NOT_FOUND', 'Session not found');
      const conn = engine.conn(s.connectionId);
      const body = (await request.json()) as ExplainRequest;
      if (body.mode === 'actual' && conn?.readOnly && !body.confirmedDestructive && WRITES.test(stripComments(body.sql))) {
        return err(403, 'READ_ONLY', `Connection “${conn.name}” is read-only; the statement modifies data`);
      }
      const plan = PLANS[`${conn?.providerId ?? 'sqlite'}:${body.mode}`] ?? planSqliteEstimated;
      const executionId = `x_plan${++seq}`;
      emitLater([
        { type: 'exec.started', executionId, sessionId: s.sessionId, batchCount: 1 } as Omit<WsEvent, 'ts'>,
        { ...plan, type: 'exec.plan', executionId, mode: body.mode } as Omit<WsEvent, 'ts'>,
        { type: 'exec.done', executionId, sessionId: s.sessionId, status: 'ok', elapsedMs: 3, resultSets: 0, rowsAffected: 0, txOpen: s.txOpen } as Omit<WsEvent, 'ts'>,
      ]);
      return HttpResponse.json({ executionId, startedAt: new Date().toISOString() }, { status: 202 });
    }),

    // 3.8 describe: result columns without running the query.
    http.post(`${P}/sessions/:sid/describe`, async ({ params, request }) => {
      if (!engine.sessions.get(String(params.sid))) return err(404, 'NOT_FOUND', 'Session not found');
      const body = (await request.json()) as DescribeRequest;
      return HttpResponse.json((/\bjoin\b/i.test(body.sql) ? describeJoin : describeProducts).response);
    }),

    // 3.9 designer
    http.get(`${P}/connections/:id/designer/types`, ({ params }) =>
      engine.conn(String(params.id)) ? HttpResponse.json(isPg(String(params.id)) ? pgDesignerTypes : designerTypes) : err(404, 'NOT_FOUND', 'Connection not found')),
    http.get(`${P}/connections/:id/designer/table`, ({ params, request }) => {
      const cid = String(params.id);
      if (!engine.conn(cid)) return err(404, 'NOT_FOUND', 'Connection not found');
      const name = new URL(request.url).searchParams.get('name') ?? '';
      if (isPg(cid)) {
        const schema = new URL(request.url).searchParams.get('schema') || 'public';
        const d = engine.details(cid, { database: null, schema, name, type: 'table' });
        if (!d.columns.length) return err(404, 'NOT_FOUND', `relation "${schema}.${name}" does not exist`);
        const fks = d.foreignKeys.map((f) => ({ name: f.name, columns: f.columns, refSchema: f.refSchema, refTable: f.refTable, refColumns: f.refColumns, onDelete: 'NO ACTION' as const, onUpdate: 'NO ACTION' as const }));
        return HttpResponse.json(pgTableModel(schema, name, d.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, pk: c.isPk, identity: c.isIdentity, comment: c.comment, default: c.default })), fks, null));
      }
      const t = TABLES[name.toLowerCase()];
      return t ? HttpResponse.json(t) : HttpResponse.json({ ...tableCustomers, name });
    }),
    http.post(`${P}/connections/:id/designer/table/script`, async ({ params, request }) => {
      const body = (await request.json()) as TableScriptRequest;
      if (isPg(String(params.id))) return HttpResponse.json(scriptPgTable(body));
      if (!body.original) return HttpResponse.json(scriptCreate.response);
      const more = (body.desired?.columns?.length ?? 0) > (body.original.columns?.length ?? 0);
      return HttpResponse.json((more ? scriptAddColumn : scriptRebuild).response);
    }),
    http.get(`${P}/connections/:id/designer/view`, ({ params, request }) => {
      if (!engine.conn(String(params.id))) return err(404, 'NOT_FOUND', 'Connection not found');
      const name = new URL(request.url).searchParams.get('name') ?? viewModel.name;
      if (isPg(String(params.id))) {
        const schema = new URL(request.url).searchParams.get('schema') || 'public';
        const ddl = engine.ddl(String(params.id), { database: null, schema, name, type: 'view' }).ddl;
        const body = ddl.replace(/^CREATE (OR REPLACE )?VIEW [^\n]+\n/i, '').replace(/;\s*$/, '');
        return HttpResponse.json({ schema, name, body, options: { schemaBinding: false, checkOption: false, force: false }, ddl });
      }
      return HttpResponse.json({ ...viewModel, name });
    }),
    http.post(`${P}/connections/:id/designer/view/script`, async ({ params, request }) => {
      const body = (await request.json()) as ViewScriptRequest;
      if (isPg(String(params.id))) return HttpResponse.json(scriptPgView(body));
      const r = viewScript.response;
      return HttpResponse.json(body.name === viewScript.request.name ? r : { ...r, statements: r.statements.map((st) => ({ ...st, sql: st.sql.split(viewScript.request.name).join(body.name) })) });
    }),
    // Apply: one transaction; a statement containing a syntax error fails the whole script (DDL_FAILED, rolled back).
    http.post(`${P}/connections/:id/designer/apply`, async ({ params, request }) => {
      const cid = String(params.id);
      if (!engine.conn(cid)) return err(404, 'NOT_FOUND', 'Connection not found');
      const body = (await request.json()) as DdlApplyRequest;
      const bad = body.statements.findIndex((sql) => /\bBEGINX\b|\bSELEC\b|\bFROMM\b|syntax error/i.test(sql));
      if (bad >= 0) {
        const f = applyFailed.error;
        return err(409, f.code, `Statement ${bad + 1} failed. All changes were rolled back.`, { ...f.detail, failedIndex: bad, executed: bad });
      }
      engine.emit({ type: 'catalog.changed', connectionId: cid, database: body.database ?? null, schemas: [engine.defaultSchema(cid)], version: Date.now() % 100000 } as WsEvent);
      return HttpResponse.json({ ...applyOk, executed: body.statements.length });
    }),

    // 3.6 export of a whole query: the file is "written" and export.done arrives over the socket.
    http.post(`${P}/export`, async ({ request }) => {
      const body = (await request.json()) as QueryExportRequest;
      if (!engine.sessions.get(body.sessionId)) return err(404, 'NOT_FOUND', 'Session not found');
      const exportId = `e_${++seq}`;
      emitLater([
        { type: 'export.progress', exportId, rows: 500 } as Omit<WsEvent, 'ts'>,
        { type: 'export.done', exportId, path: body.path, rows: 1000, status: 'ok', error: null } as Omit<WsEvent, 'ts'>,
      ]);
      return HttpResponse.json({ exportId }, { status: 202 });
    }),
  ];
}

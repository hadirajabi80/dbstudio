// Saved queries mock routes (/connections/{cid}/queries, engine Core/Queries/QueriesModule.cs): an in-memory store per
// MockEngine with a few seeded queries, the same validation (unique name per schema, ignoring case) and error envelope.
import { http, HttpResponse, type JsonBodyType, type RequestHandler } from 'msw';
import type { SavedQuery, SavedQueryInput, SavedQueryPatch } from '../api/savedQueries';
import type { MockEngine } from './engine';

const P = '*/api/v1';

const stores = new WeakMap<MockEngine, SavedQuery[]>();
let seq = 0;

const at = (day: number, hour: number) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:12:00.000Z`;

function seed(): SavedQuery[] {
  const q = (id: string, connectionId: string, database: string | null, schema: string, name: string, sql: string, description: string | null, day: number): SavedQuery => ({
    id, connectionId, database, schema, name, sql, description, createdAt: at(day, 9), updatedAt: at(day + 2, 15),
  });
  return [
    q('q_seed_1', 'c_shop', 'main', 'main', 'Top customers', 'SELECT c.name, SUM(o.total) AS spent\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nORDER BY spent DESC\nLIMIT 10;', 'Best customers by total spend', 3),
    q('q_seed_2', 'c_shop', 'main', 'main', 'Orders this week', "SELECT *\nFROM orders\nWHERE created_at >= date('now', '-7 days');", null, 8),
    q('q_seed_3', 'c_shop', 'main', 'main', 'Low stock', 'SELECT name, stock FROM products WHERE stock < 5 ORDER BY stock;', 'Products to reorder', 12),
    q('q_seed_4', 'c_prod', 'Shop', 'dbo', 'Daily revenue', 'SELECT CAST(OrderDate AS date) AS Day, SUM(Total) AS Revenue\nFROM dbo.Orders\nGROUP BY CAST(OrderDate AS date)\nORDER BY Day DESC;', 'For the morning report', 5),
    q('q_seed_5', 'c_ora', null, 'SHOP', 'Open invoices', 'SELECT * FROM invoices WHERE status = \'OPEN\'', null, 10),
  ];
}

export function savedQueryStore(engine: MockEngine): SavedQuery[] {
  let s = stores.get(engine);
  if (!s) stores.set(engine, (s = seed()));
  return s;
}

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') === (b ?? '');

function clash(list: SavedQuery[], cid: string, database: string | null, schema: string | null, name: string, exceptId?: string) {
  return list.find((q) => q.connectionId === cid && q.id !== exceptId && same(q.database, database) && same(q.schema, schema) && q.name.toLowerCase() === name.toLowerCase());
}

const duplicate = (name: string, id: string, where: string | null) =>
  err(400, 'VALIDATION', `A query named '${name}' already exists${where ? ` in ${where}` : ''}.`, { field: 'name', reason: 'duplicate', id });

const now = () => new Date().toISOString();

export function createSavedQueriesHandlers(engine: MockEngine, ok: (body: JsonBodyType, init?: ResponseInit) => Promise<Response>): RequestHandler[] {
  const conn = (id: string) => engine.conn(id);
  return [
    http.get(`${P}/connections/:id/queries`, ({ params, request }) => {
      const cid = String(params.id);
      if (!conn(cid)) return err(404, 'NOT_FOUND', `Connection '${cid}' was not found.`);
      const url = new URL(request.url);
      const db = url.searchParams.get('database');
      const schema = url.searchParams.get('schema');
      const list = savedQueryStore(engine)
        .filter((q) => q.connectionId === cid && (db === null || same(q.database, db)) && (schema === null || same(q.schema, schema)))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return ok(list as unknown as JsonBodyType);
    }),
    http.get(`${P}/connections/:id/queries/:qid`, ({ params }) => {
      const q = savedQueryStore(engine).find((x) => x.connectionId === String(params.id) && x.id === String(params.qid));
      return q ? ok(q as unknown as JsonBodyType) : err(404, 'NOT_FOUND', `Saved query '${String(params.qid)}' was not found.`);
    }),
    http.post(`${P}/connections/:id/queries`, async ({ params, request }) => {
      const cid = String(params.id);
      if (!conn(cid)) return err(404, 'NOT_FOUND', `Connection '${cid}' was not found.`);
      const b = (await request.json()) as SavedQueryInput;
      const name = (b.name ?? '').trim();
      if (!name) return err(400, 'VALIDATION', 'name is required.', { field: 'name' });
      const list = savedQueryStore(engine);
      const c = clash(list, cid, b.database ?? null, b.schema ?? null, name);
      if (c) return duplicate(c.name, c.id, b.schema ?? b.database ?? null);
      const t = now();
      const q: SavedQuery = {
        id: `q_mock_${++seq}`, connectionId: cid, database: b.database || null, schema: b.schema || null, name, sql: b.sql ?? '',
        description: b.description?.trim() || null, createdAt: t, updatedAt: t,
      };
      list.push(q);
      return ok(q as unknown as JsonBodyType, { status: 201 });
    }),
    http.put(`${P}/connections/:id/queries/:qid`, async ({ params, request }) => {
      const list = savedQueryStore(engine);
      const i = list.findIndex((x) => x.connectionId === String(params.id) && x.id === String(params.qid));
      if (i < 0) return err(404, 'NOT_FOUND', `Saved query '${String(params.qid)}' was not found.`);
      const p = (await request.json()) as SavedQueryPatch;
      const cur = list[i];
      const name = p.name === undefined ? cur.name : p.name.trim();
      if (!name) return err(400, 'VALIDATION', 'name is required.', { field: 'name' });
      const c = clash(list, cur.connectionId, cur.database, cur.schema, name, cur.id);
      if (c) return duplicate(c.name, c.id, cur.schema ?? cur.database);
      const next: SavedQuery = {
        ...cur, name, sql: p.sql ?? cur.sql, description: p.description === undefined ? cur.description : p.description.trim() || null, updatedAt: now(),
      };
      list[i] = next;
      return ok(next as unknown as JsonBodyType);
    }),
    http.post(`${P}/connections/:id/queries/:qid/duplicate`, async ({ params, request }) => {
      const list = savedQueryStore(engine);
      const src = list.find((x) => x.connectionId === String(params.id) && x.id === String(params.qid));
      if (!src) return err(404, 'NOT_FOUND', `Saved query '${String(params.qid)}' was not found.`);
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      let name = body?.name?.trim();
      if (name) {
        const c = clash(list, src.connectionId, src.database, src.schema, name);
        if (c) return duplicate(c.name, c.id, src.schema ?? src.database);
      } else {
        for (let n = 1; ; n++) {
          const candidate = n === 1 ? `${src.name} (copy)` : `${src.name} (copy ${n})`;
          if (!clash(list, src.connectionId, src.database, src.schema, candidate)) { name = candidate; break; }
        }
      }
      const t = now();
      const copy: SavedQuery = { ...src, id: `q_mock_${++seq}`, name: name!, createdAt: t, updatedAt: t };
      list.push(copy);
      return ok(copy as unknown as JsonBodyType, { status: 201 });
    }),
    http.delete(`${P}/connections/:id/queries/:qid`, ({ params }) => {
      const list = savedQueryStore(engine);
      const i = list.findIndex((x) => x.connectionId === String(params.id) && x.id === String(params.qid));
      if (i < 0) return err(404, 'NOT_FOUND', `Saved query '${String(params.qid)}' was not found.`);
      list.splice(i, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

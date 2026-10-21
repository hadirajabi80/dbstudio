// ER diagram mock routes (docs/PLAN-M2.md section 3, owner M2-ER): saved layouts in memory, same contract as the
// engine DiagramStore (one layout per connection + scope key; PUT upserts by id; DELETE 404s on an unknown id).
import { http, HttpResponse, type RequestHandler } from 'msw';
import { layoutScopeKey } from '../../api/er';
import type { DiagramLayout } from '../../api/types';
import { M2_PREFIX, type M2MockContext } from './index';

interface Stored { cid: string; key: string; layout: DiagramLayout }

function validation(message: string, field: string) {
  return HttpResponse.json({ error: { code: 'VALIDATION', message, detail: { field } } }, { status: 400 });
}

/** In-memory layout store (exported for tests that want to inspect or seed it). */
export class MockDiagramStore {
  items: Stored[] = [];

  list(cid: string, database: string | null, scope: string | null): DiagramLayout[] {
    return this.items
      .filter((s) => s.cid === cid && (database == null || (s.layout.scope.database ?? '') === database) && (!scope || s.key === scope))
      .map((s) => s.layout)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(cid: string, layout: DiagramLayout): DiagramLayout {
    const key = layoutScopeKey(layout.scope);
    const saved = { ...layout, updatedAt: new Date().toISOString() };
    this.items = this.items.filter((s) => !(s.cid === cid && (s.layout.id === layout.id || s.key === key)));
    this.items.push({ cid, key, layout: saved });
    return saved;
  }

  delete(cid: string, id: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((s) => !(s.cid === cid && s.layout.id === id));
    return this.items.length < n;
  }
}

export const mockDiagrams = new MockDiagramStore();

export function createErHandlers(ctx: M2MockContext, store: MockDiagramStore = mockDiagrams): RequestHandler[] {
  const known = (cid: string) => ctx.engine.connections.some((c) => c.id === cid);
  const notFound = (cid: string) => HttpResponse.json({ error: { code: 'NOT_FOUND', message: `Connection '${cid}' was not found.` } }, { status: 404 });
  return [
    http.get(`${M2_PREFIX}/connections/:cid/er/layouts`, ({ params, request }) => {
      const cid = String(params.cid);
      if (!known(cid)) return notFound(cid);
      const url = new URL(request.url);
      return ctx.ok(store.list(cid, url.searchParams.get('database'), url.searchParams.get('scope')) as never);
    }),
    http.put(`${M2_PREFIX}/connections/:cid/er/layouts/:id`, async ({ params, request }) => {
      const cid = String(params.cid);
      if (!known(cid)) return notFound(cid);
      const body = (await request.json().catch(() => null)) as Partial<DiagramLayout> | null;
      if (!body || typeof body !== 'object') return validation('A request body is required.', 'body');
      const id = String(params.id);
      if (body.id && body.id !== id) return validation('id in the body must match the id in the path.', 'id');
      const scope = body.scope;
      if (!scope || (!scope.schema === !(scope.tables && scope.tables.length))) return validation('scope must name exactly one of schema or tables.', 'scope');
      if (typeof body.zoom !== 'number' || body.zoom < 0.05 || body.zoom > 4) return validation('zoom must be between 0.05 and 4.', 'zoom');
      const layout: DiagramLayout = {
        id, scope, positions: body.positions ?? {}, hidden: body.hidden ?? [], zoom: body.zoom, pan: body.pan ?? [0, 0],
        updatedAt: '', auto: body.auto, added: body.added, pinned: body.pinned, options: body.options,
      };
      return ctx.ok(store.save(cid, layout) as never);
    }),
    http.delete(`${M2_PREFIX}/connections/:cid/er/layouts/:id`, ({ params }) => {
      const cid = String(params.cid);
      if (!known(cid)) return notFound(cid);
      if (!store.delete(cid, String(params.id))) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: `Diagram layout '${String(params.id)}' was not found.` } }, { status: 404 });
      }
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

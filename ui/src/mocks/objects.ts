// Object browser mock routes (WP3): GET …/catalog/objects and …/catalog/dependencies, derived from the mock catalog
// (FKs both ways) and the stored DDL of every object (names it mentions = what it uses; reversed = what uses it).
import { http, HttpResponse, type JsonBodyType, type RequestHandler } from 'msw';
import type { CatalogObject, CatalogObjectType, ObjectRef } from '../api/types';
import type { DependencyGraph, ObjectDependency, ObjectListItem } from '../api/types.objects';
import type { MockEngine } from './engine';

const P = '*/api/v1';

function notFound(message: string) {
  return HttpResponse.json({ error: { code: 'NOT_FOUND', message } }, { status: 404 });
}

interface Entry { schema: string; obj: CatalogObject }

/** Every object of the requested schema (null = all schemas of the database). */
function entries(engine: MockEngine, cid: string, database: string | null, schema: string | null): Entry[] {
  const names = schema ? [schema] : engine.schemas(cid, database).schemas.map((s) => s.name);
  return engine.catalog(cid, database, names).schemas.flatMap((s) => s.objects.map((obj) => ({ schema: s.name, obj })));
}

const words = (ddl: string) => new Set((ddl.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').match(/[A-Za-z_][\w$#]*/g) ?? []).map((w) => w.toLowerCase()));

/** Deterministic, plausible statistics for objects the fixtures do not size. */
function seeded(name: string, max: number): number {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) % max;
}

export function objectList(engine: MockEngine, cid: string, database: string | null, schema: string | null, type: CatalogObjectType | null): ObjectListItem[] {
  const pg = engine.conn(cid)?.providerId === 'postgresql';
  const seen = new Set<string>();
  return entries(engine, cid, database, schema)
    .filter((e) => !type || e.obj.t === type)
    // one row per routine (overloads share the name), like the engine
    .filter((e) => !seen.has(`${e.schema}|${e.obj.t}|${e.obj.n}`) && !!seen.add(`${e.schema}|${e.obj.t}|${e.obj.n}`))
    .map(({ schema: s, obj }) => {
      const tabular = obj.t === 'table';
      const rows = tabular ? engine.details(cid, { database, schema: s, name: obj.n, type: obj.t }).rowCountEstimate : null;
      const day = 1 + seeded(obj.n, 27);
      return {
        type: obj.t, schema: s, name: obj.n, rowCount: rows, sizeBytes: tabular ? Math.max(8192, (rows ?? 0) * (180 + seeded(obj.n, 220))) : null,
        modified: pg ? null : `2026-0${1 + seeded(obj.n, 9)}-${String(day).padStart(2, '0')}T${String(8 + seeded(obj.n, 10)).padStart(2, '0')}:15:00`,
        created: pg ? null : '2025-01-03T10:00:00',
        comment: obj.cm ?? (obj.t === 'trigger' ? 'on orders' : null),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function dependencyGraph(engine: MockEngine, cid: string, database: string | null, ref: ObjectRef): DependencyGraph | null {
  const all = entries(engine, cid, database, null);
  const root = all.find((e) => e.obj.n.toLowerCase() === ref.name.toLowerCase() && (!ref.schema || e.schema === ref.schema))
    ?? all.find((e) => e.obj.n.toLowerCase() === ref.name.toLowerCase());
  if (!root) return null;
  const rootRef: ObjectRef = { database, schema: root.schema, name: root.obj.n, type: root.obj.t };
  const refOf = (e: Entry): ObjectRef => ({ database, schema: e.schema, name: e.obj.n, type: e.obj.t });
  const uses: ObjectDependency[] = [];
  const usedBy: ObjectDependency[] = [];
  const fkDetail = (n: string, cols: string[], rcols: string[]) => `${n}: ${cols.join(', ')} → ${rcols.join(', ')}`;

  for (const fk of root.obj.fk ?? []) {
    uses.push({ kind: 'fk', object: { database, schema: fk.rs ?? root.schema, name: fk.rt, type: 'table' }, detail: fkDetail(fk.n, fk.cols, fk.rcols), isSchemaBound: null });
  }
  for (const e of all) {
    for (const fk of e.obj.fk ?? []) {
      if (fk.rt.toLowerCase() === root.obj.n.toLowerCase() && (fk.rs ?? e.schema) === root.schema) {
        usedBy.push({ kind: 'fk', object: refOf(e), detail: fkDetail(fk.n, fk.cols, fk.rcols), isSchemaBound: null });
      }
    }
  }
  const ddlOf = (e: Entry) => engine.ddl(cid, refOf(e)).ddl;
  const bodies = all.filter((e) => e.obj.t !== 'table' && e.obj.t !== 'sequence' && e.obj.t !== 'synonym');
  if (root.obj.t !== 'table') {
    const w = words(ddlOf(root));
    for (const e of all) {
      if (e === root || !w.has(e.obj.n.toLowerCase())) continue;
      const onTable = root.obj.t === 'trigger' && e.obj.t === 'table' && /\bON\s+["[`]?(\w+)/i.exec(ddlOf(root))?.[1]?.toLowerCase() === e.obj.n.toLowerCase();
      uses.push({ kind: onTable ? 'trigger' : 'uses', object: refOf(e), detail: onTable ? 'fires on' : null, isSchemaBound: null });
    }
  }
  for (const e of bodies) {
    if (e === root) continue;
    const ddl = ddlOf(e);
    if (!words(ddl).has(root.obj.n.toLowerCase())) continue;
    if (e.obj.t === 'trigger') {
      const on = /\b(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s+["[`]?(\w+)/i.exec(ddl);
      const fires = on?.[3]?.toLowerCase() === root.obj.n.toLowerCase();
      usedBy.push({ kind: fires ? 'trigger' : 'usedBy', object: refOf(e), detail: fires ? `${on![1].toUpperCase()} ${on![2].toUpperCase()}` : null, isSchemaBound: null });
    } else {
      usedBy.push({ kind: 'usedBy', object: refOf(e), detail: null, isSchemaBound: e.obj.t === 'view' ? true : null });
    }
  }
  return { root: rootRef, uses, usedBy };
}

export function createObjectsHandlers(engine: MockEngine, ok: (body: JsonBodyType) => Promise<Response>): RequestHandler[] {
  return [
    http.get(`${P}/connections/:id/catalog/objects`, ({ params, request }) => {
      const id = String(params.id);
      if (!engine.conn(id)) return notFound('Connection not found');
      const url = new URL(request.url);
      const q = (k: string) => url.searchParams.get(k) || null;
      return ok(objectList(engine, id, q('database'), q('schema'), q('type') as CatalogObjectType | null) as unknown as JsonBodyType);
    }),
    http.get(`${P}/connections/:id/catalog/dependencies`, ({ params, request }) => {
      const id = String(params.id);
      if (!engine.conn(id)) return notFound('Connection not found');
      const url = new URL(request.url);
      const q = (k: string) => url.searchParams.get(k) || null;
      const ref: ObjectRef = { database: q('database'), schema: q('schema'), name: q('name') ?? '', type: (q('type') ?? 'table') as CatalogObjectType };
      const g = dependencyGraph(engine, id, ref.database, ref);
      return g ? ok(g as unknown as JsonBodyType) : notFound(`Object ${ref.schema ?? ''}.${ref.name} was not found.`);
    }),
  ];
}

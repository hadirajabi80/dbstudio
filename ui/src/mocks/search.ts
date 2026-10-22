// Mock of the engine's `db.search` stream (Find in database) for `npm run dev:mock` and component tests: names,
// columns and DDL lines of the mock catalog, and (opt-in) the generated fixture rows, sent schema by schema with
// progress items and a final `done` item.
import type { RequestHandler } from 'msw';
import type { CatalogObject, CellValue } from '../api/types';
import type { SearchItem, SearchRequestParams, SearchTargetParams } from '../api/types.search';
import { generateRows, pgShopTables, SHOP_TABLES, type FixtureTable } from './fixtures';
import type { M2MockContext } from './m2';

const CODE_TYPES = new Set(['view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'trigger']);
const rows = new Map<FixtureTable, CellValue[][]>();

function matcher(p: SearchRequestParams): (text: string) => [number, number][] {
  const body = p.regex ? p.term : p.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(p.wholeWord ? `(?<![\\w])(?:${body})(?![\\w])` : body, `g${p.matchCase ? '' : 'i'}`);
  return (text) => {
    const out: [number, number][] = [];
    for (const m of text.matchAll(re)) if (m[0].length) out.push([m.index ?? 0, m[0].length]);
    return out.slice(0, 32);
  };
}

export function createSearchHandlers(ctx: M2MockContext): RequestHandler[] {
  const { engine } = ctx;
  ctx.streams.register('db.search', ({ params, push, end, signal }) => {
    const p = params as unknown as SearchRequestParams;
    let match: (text: string) => [number, number][];
    try {
      match = matcher(p);
    } catch (e) {
      push([{ kind: 'error', connectionId: p.targets?.[0]?.connectionId ?? '', database: null, schema: null, message: `Invalid regular expression: ${String(e)}`, table: null, notice: false }]);
      end('completed');
      return;
    }
    const started = Date.now();
    let hits = 0;
    const allowed = (t: string) => !p.types?.length || p.types.includes(t as never);
    const steps: (() => SearchItem[])[] = [];

    const plan = (target: SearchTargetParams) => {
      const cid = target.connectionId;
      const conn = engine.conn(cid);
      if (!conn) return;
      const dbList = target.database !== undefined && target.database !== null ? [target.database]
        : conn.providerId === 'sqlserver' || conn.providerId === 'postgresql' ? engine.databases(cid).databases.filter((d) => d !== 'master') : [conn.providerId === 'sqlite' ? 'main' : null];
      for (const db of dbList) {
        const schemas = target.objects?.length ? [...new Set(target.objects.map((o) => o.schema ?? engine.defaultSchema(cid)))]
          : target.schema ? [target.schema] : engine.schemas(cid, db).schemas.map((s) => s.name);
        for (const schema of schemas) {
          steps.push(() => {
            const items: SearchItem[] = [{ kind: 'progress', connectionId: cid, database: db, schema, phase: 'code', done: 0, total: schemas.length, table: null }];
            const objects = engine.catalog(cid, db, [schema]).schemas[0]?.objects ?? [];
            const inScope = (o: CatalogObject) => !target.objects?.length || target.objects.some((x) => x.name === o.n && (x.schema ?? schema) === schema);
            const base = { kind: 'hit' as const, connectionId: cid, database: db, schema, column: null, dataType: null, line: null, key: null, more: 0 };
            for (const o of objects) {
              if (!allowed(o.t) || !inScope(o)) continue;
              const object = { name: o.n, type: o.t };
              if (p.in.names) {
                const r = match(o.n);
                if (r.length) items.push({ ...base, object, match: 'name', text: o.n, ranges: r });
              }
              if (p.in.columns) {
                for (const c of o.c ?? []) {
                  const r = match(c[0]);
                  if (r.length) items.push({ ...base, object, match: 'column', text: c[0], ranges: r, column: c[0], dataType: c[1] });
                }
              }
              if (p.in.code && CODE_TYPES.has(o.t)) {
                const ddl = engine.ddl(cid, { database: db, schema, name: o.n, type: o.t });
                if (ddl.source === 'stored') {
                  ddl.ddl.split('\n').forEach((line, i) => {
                    const r = match(line);
                    if (r.length) items.push({ ...base, object, match: 'code', text: line, ranges: r, line: i + 1 });
                  });
                }
              }
            }
            if (p.in.data && (target.schema || target.objects?.length)) {
              const fixtures = conn.providerId === 'postgresql' ? pgShopTables() : SHOP_TABLES;
              for (const o of objects) {
                if (o.t !== 'table' || !inScope(o) || !allowed(o.t)) continue;
                const t = fixtures.find((f) => f.name.toLowerCase() === o.n.toLowerCase());
                if (!t) continue;
                let data = rows.get(t);
                if (!data) rows.set(t, (data = generateRows(t)));
                const keys = t.columns.map((c, i) => ({ c, i })).filter((x) => x.c.pk);
                let n = 0;
                for (const row of data) {
                  if (n >= p.dataRowLimit) break;
                  let rowHit = false;
                  t.columns.forEach((c, i) => {
                    const v = row[i];
                    if (c.kind !== 'string' || typeof v !== 'string') return;
                    const r = match(v);
                    if (!r.length) return;
                    rowHit = true;
                    items.push({
                      ...base, object: { name: o.n, type: 'table' }, match: 'data', text: v, ranges: r, column: (o.c?.[i]?.[0]) ?? c.name, dataType: c.type,
                      key: keys.length ? keys.map((k) => ({ column: (o.c?.[k.i]?.[0]) ?? k.c.name, value: row[k.i] })) : null,
                    });
                  });
                  if (rowHit) n++;
                }
              }
            }
            return items;
          });
        }
      }
    };
    for (const t of p.targets ?? []) plan(t);

    let i = 0;
    const next = () => {
      if (signal.aborted) return;
      if (i >= steps.length) {
        push([{ kind: 'done', hits, truncated: false, elapsedMs: Date.now() - started, connections: new Set((p.targets ?? []).map((t) => t.connectionId)).size }]);
        end('completed');
        return;
      }
      const items = steps[i++]();
      hits += items.filter((x) => x.kind === 'hit').length;
      push(items);
      setTimeout(next, 90);
    };
    // Like the engine: the first batch waits a moment for the UI to subscribe to the stream id.
    setTimeout(next, 150);
  });
  return [];
}

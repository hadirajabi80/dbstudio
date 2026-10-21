// Execute routine: the routine(s) behind a request (from the loaded catalog, else the object details), and running a
// generated call in a console.
import { api } from '../../api/client';
import type { CatalogObject, CatalogParamTuple, QueryParam } from '../../api/types';
import { catalogDatabase, newConsole, runInTab } from '../../app/actions';
import { rememberParams } from '../../store/params';
import { dbKey, useCatalog } from '../../store/catalog';
import { dialectOf, getConnection } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { getActiveConsole, useTabs, type ConsoleTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import { EXECUTABLE_TYPES, specParams, type RoutineCall, type RoutineKind, type RoutineSpec } from './routineSql';
import type { ExecuteRoutineRequest } from './store';

/** One executable routine of a request: an overload, or a package member. */
export interface RoutineChoice {
  id: string;
  label: string;
  spec: RoutineSpec;
}

function signature(spec: RoutineSpec): string {
  return spec.params.map((p) => p.type).join(', ');
}

function choiceOf(spec: RoutineSpec, overloaded: boolean, index: number): RoutineChoice {
  const label = spec.packageName ? `${spec.name}${overloaded ? ` (${signature(spec) || 'no arguments'})` : ''}` : overloaded ? `${spec.name}(${signature(spec)})` : spec.name;
  return { id: `${spec.packageName ?? ''}.${spec.name}#${index}`, label, spec };
}

function specOf(req: ExecuteRoutineRequest, kind: RoutineKind, name: string, tuples: readonly CatalogParamTuple[], packageName: string | null = null, overload?: number): RoutineSpec {
  const { params, returnType } = specParams(tuples);
  return { dialect: dialectOf(req.connectionId), kind, schema: req.ref.schema, packageName, name, params, returnType, overload };
}

/** Catalog objects with the request's name and type (overloads share a name), loading the schema when needed. */
async function catalogObjects(req: ExecuteRoutineRequest): Promise<CatalogObject[]> {
  // The connection's current database (the catalog key of a null database) must be known first.
  await useCatalog.getState().loadDatabases(req.connectionId).catch(() => null);
  const catDb = catalogDatabase(req.connectionId, req.database ?? req.ref.database);
  const cat = useCatalog.getState();
  const key = dbKey(req.connectionId, catDb);
  const schema = req.ref.schema ?? cat.dbs[key]?.defaultSchema ?? null;
  if (!schema) return [];
  if (!useCatalog.getState().dbs[key]?.loaded[schema]) {
    await cat.loadSchema(req.connectionId, catDb, schema).catch(() => undefined);
    // loadSchema returns at once while another caller (the explorer, the editor) is already loading the schema.
    await new Promise<void>((resolve) => {
      const done = () => useCatalog.getState().dbs[key]?.schemaStatus[schema] !== 'loading';
      if (done()) return resolve();
      const timer = setTimeout(() => { unsub(); resolve(); }, 15_000);
      const unsub = useCatalog.subscribe(() => {
        if (!done()) return;
        clearTimeout(timer);
        unsub();
        resolve();
      });
    });
  }
  const objects = useCatalog.getState().dbs[key]?.loaded[schema]?.objects ?? [];
  return objects.filter((o) => o.t === req.ref.type && o.n === req.ref.name);
}

/** The routines a request can execute (one, unless overloaded or a package). */
export async function resolveRoutines(req: ExecuteRoutineRequest): Promise<RoutineChoice[]> {
  const objects = await catalogObjects(req);
  if (req.ref.type === 'package') {
    const members = objects[0]?.members ?? [];
    const names = new Map<string, number>();
    for (const m of members) names.set(m.n, (names.get(m.n) ?? 0) + 1);
    return members.map((m, i) => choiceOf(specOf(req, m.k, m.n, m.p, req.ref.name, m.ov), (names.get(m.n) ?? 0) > 1, i));
  }
  if (!EXECUTABLE_TYPES.has(req.ref.type)) return [];
  const kind = req.ref.type as RoutineKind;
  const withParams = objects.filter((o) => Array.isArray(o.p));
  if (withParams.length) return withParams.map((o, i) => choiceOf(specOf(req, kind, o.n, o.p!), withParams.length > 1, i));
  // Not in the loaded catalog (or loaded without parameters): the object details have them.
  const d = await api.objectDetails(req.connectionId, req.database ?? req.ref.database, req.ref);
  const tuples: CatalogParamTuple[] = d.parameters.map((p) => [
    p.name, p.typeText, (['in', 'out', 'inout', 'return'].includes(p.direction) ? p.direction : 'in') as CatalogParamTuple[2], p.hasDefault ? 1 : 0,
  ]);
  return [choiceOf(specOf(req, kind, req.ref.name, tuples), false, 0)];
}

/** Key for the remembered values of one routine choice. */
export function choiceSignature(c: RoutineChoice): string {
  return signature(c.spec);
}

function consoleOf(id: string | null | undefined): ConsoleTab | undefined {
  const t = id ? useTabs.getState().tabs.find((x) => x.id === id) : undefined;
  return t?.kind === 'console' ? t : undefined;
}

/** A console the call can run in: on the routine's connection and database, and not busy. */
function usableConsole(req: ExecuteRoutineRequest): ConsoleTab | undefined {
  const want = catalogDatabase(req.connectionId, req.database ?? req.ref.database);
  const r = useResults.getState();
  for (const t of [consoleOf(req.fromTabId), getActiveConsole()]) {
    if (!t || t.connectionId !== req.connectionId) continue;
    if (catalogDatabase(req.connectionId, t.database) !== want) continue;
    if (isRunning(r.executions[r.byTab[t.id]])) continue;
    return t;
  }
  return undefined;
}

/**
 * Runs a call: in the console it came from or the active console when that is on the same connection and database
 * (its editor text is left alone), else in a new console that holds the call text, so it can be edited and re-run.
 * The binds are also remembered for the Parameters dialog, which asks for them on a re-run of the text.
 */
export async function runRoutineCall(req: ExecuteRoutineRequest, spec: RoutineSpec, call: RoutineCall): Promise<string | null> {
  const conn = getConnection(req.connectionId);
  if (!conn) {
    toast('error', 'The connection no longer exists');
    return null;
  }
  const named = call.params.filter((p) => !/^\d+$/.test(p.name) && p.direction !== 'out');
  if (named.length) {
    rememberParams(req.connectionId, named.map((p) => ({
      name: p.name, display: p.name, positional: false, kind: p.kind, value: p.value === null ? '' : String(p.value),
    })));
  }
  const batches = [{ sql: call.sql, line: 1, col: 1 }];
  const params: QueryParam[] = call.params;
  const existing = usableConsole(req);
  if (existing) {
    if (useTabs.getState().activeId !== existing.id) useTabs.getState().activate(existing.id);
    await runInTab(existing.id, 'script', batches, { params, plain: true, detached: true });
    return existing.id;
  }
  const id = newConsole(req.connectionId, req.database ?? req.ref.database, call.sql);
  useTabs.getState().rename(id, `Exec: ${spec.name}`);
  await runInTab(id, 'script', batches, { params, plain: true });
  return id;
}


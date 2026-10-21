// Opening ER diagram tabs (docs/PLAN-M2.md section 3): per schema (connection / database / schema node, Ctrl+Alt+E),
// per selected tables (explorer multi-select) and the "related" set of a table (the table + every table one FK hop
// away). Light module: the commands import it, the diagram view itself is lazy.
import { api } from '../../api/client';
import { layoutScopeKey } from '../../api/er';
import type { DiagramScope, ObjectRef } from '../../api/types';
import { catalogDatabase, preloadCatalog } from '../../app/actions';
import { targetOf } from '../../commands/core';
import { isConnectionTarget, isContainerTarget, isObjectTarget, type ObjectTarget } from '../../commands/types';
import { dbKey, useCatalog } from '../../store/catalog';
import { dialectOf, getConnection, hasDatabaseLevel, isRelational, useConnections } from '../../store/connections';
import { getActiveTab, useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { ER_VIEW_ID } from './controllers';
import { relatedTables, tableKey } from './model';
import type { ErTabState } from './store';
import type { SyntheticSpec } from './synthetic';

const TABULAR = new Set(['table', 'view', 'mview']);

/** Where a diagram command applies: its explorer target, else the explorer selection, else the active tab. */
export interface DiagramContext {
  connectionId: string;
  /** Catalog database key. */
  database: string | null;
  schema: string | null;
}

export function diagramContext(args?: unknown): DiagramContext | null {
  const t = targetOf(args);
  let base: { connectionId: string; database: string | null; schema: string | null } | null = null;
  if (isObjectTarget(t)) base = { connectionId: t.connectionId, database: t.database, schema: t.ref.schema };
  else if (isContainerTarget(t)) base = { connectionId: t.connectionId, database: t.database, schema: t.schema };
  else if (isConnectionTarget(t)) base = { connectionId: t.connectionId, database: null, schema: null };
  if (!base) {
    const tab = getActiveTab();
    if (tab?.connectionId) {
      const st = tab.kind === 'view' ? (tab.state as { schema?: string | null; scope?: DiagramScope } | null) : null;
      base = { connectionId: tab.connectionId, database: tab.database, schema: tab.kind === 'object' ? tab.ref.schema : st?.schema ?? st?.scope?.schema ?? null };
    }
  }
  if (!base) {
    const first = useConnections.getState().connections.find((c) => isRelational(c.id));
    if (first) base = { connectionId: first.id, database: null, schema: null };
  }
  if (!base || !getConnection(base.connectionId) || !isRelational(base.connectionId)) return null;
  return { ...base, database: catalogDatabase(base.connectionId, base.database) };
}

function prefixOf(connectionId: string, database: string | null): string {
  const c = getConnection(connectionId);
  return c && hasDatabaseLevel(c.providerId) && database ? database : c?.name ?? connectionId;
}

/** Tab title: `ER: AdventureWorks.Sales`, `ER: Shop (SQLite)` (SQLite main), `ER: orders + 4 related`. */
export function diagramTitle(st: ErTabState, related?: string | null): string {
  if (st.synthetic) return `ER: synthetic ${st.synthetic.tables} tables`;
  const { scope } = st;
  if (scope.schema) {
    const prefix = prefixOf(st.connectionId, st.database);
    if (dialectOf(st.connectionId) === 'sqlite' && scope.schema === 'main') return `ER: ${prefix}`;
    return `ER: ${prefix}.${scope.schema}`;
  }
  const names = (scope.tables ?? []).map((k) => k.slice(k.indexOf('.') + 1));
  if (related) return `ER: ${related} + ${Math.max(0, names.length - 1)} related`;
  return `ER: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
}

/** Opens (or re-activates) the diagram tab of a scope. Key: `${cid}:er.diagram:${scopeKey}`. */
export function openDiagram(st: ErTabState, opts: { title?: string; related?: string | null } = {}): string {
  const key = st.synthetic ? `synthetic:${ER_VIEW_ID}:${st.synthetic.tables}` : `${st.connectionId}:${ER_VIEW_ID}:${layoutScopeKey(st.scope)}`;
  const id = useTabs.getState().openView({
    view: ER_VIEW_ID, title: opts.title ?? diagramTitle(st, opts.related), connectionId: st.synthetic ? null : st.connectionId,
    database: st.database, state: st, key,
  });
  useTabs.getState().requestFocus(id);
  return id;
}

async function defaultSchema(connectionId: string, database: string | null): Promise<string | null> {
  await preloadCatalog(connectionId, database);
  const cat = useCatalog.getState();
  const r = await cat.loadSchemas(connectionId, database);
  const d = useCatalog.getState().dbs[dbKey(connectionId, database)];
  const dialect = dialectOf(connectionId);
  const def = d?.defaultSchema ?? r?.defaultSchema ?? r?.schemas[0]?.name ?? (dialect === 'sqlite' ? 'main' : dialect === 'tsql' ? 'dbo' : null);
  return populatedSchema(def, r?.schemas ?? []);
}

/**
 * The login's default schema, unless it is known to be empty while other schemas hold objects (a database upgraded
 * from SQL Server 2000 gives each user an empty schema of its own name): then dbo / public, else the fullest schema.
 */
export function populatedSchema(def: string | null, schemas: readonly { name: string; objectCount?: number | null }[]): string | null {
  const count = (n: string | null) => schemas.find((s) => s.name === n)?.objectCount;
  if (!def || count(def) !== 0) return def;
  const withObjects = schemas.filter((s) => (s.objectCount ?? 0) > 0);
  if (!withObjects.length) return def;
  const conventional = withObjects.find((s) => s.name === 'dbo' || s.name === 'public');
  return (conventional ?? [...withObjects].sort((a, b) => (b.objectCount ?? 0) - (a.objectCount ?? 0))[0]).name;
}

/** er.open: the schema of the target (connection / database → its default schema). */
export async function openSchemaDiagram(args?: unknown): Promise<string | null> {
  const ctx = diagramContext(args);
  if (!ctx) {
    toast('info', 'Connect to a database first', 'ER diagrams show the tables of a relational connection.');
    return null;
  }
  const schema = ctx.schema ?? (await defaultSchema(ctx.connectionId, ctx.database));
  if (!schema) {
    toast('info', 'This database has no schemas to diagram');
    return null;
  }
  return openDiagram({ connectionId: ctx.connectionId, database: ctx.database, scope: { database: ctx.database, schema } });
}

function tablesOf(t: ObjectTarget): ObjectRef[] {
  return (t.refs?.length ? t.refs : [t.ref]).filter((r) => TABULAR.has(r.type));
}

/** er.openSelected: an explicit table set from the explorer multi-selection. */
export function openSelectedDiagram(t: ObjectTarget): string | null {
  const refs = tablesOf(t);
  if (!refs.length) return null;
  const database = catalogDatabase(t.connectionId, t.database);
  const tables = [...new Set(refs.map((r) => tableKey(r.schema ?? defaultSchemaSync(t.connectionId, database), r.name)))];
  return openDiagram({ connectionId: t.connectionId, database, scope: { database, tables } });
}

function defaultSchemaSync(connectionId: string, database: string | null): string {
  const d = useCatalog.getState().dbs[dbKey(connectionId, database)];
  return d?.defaultSchema ?? (dialectOf(connectionId) === 'sqlite' ? 'main' : '');
}

/**
 * er.openRelated: the table plus every table one FK hop away. Outgoing FKs and incoming FKs of loaded schemas come
 * from the catalog; incoming FKs from schemas that are not loaded come from `objectDetails.referencedBy`.
 */
export async function openRelatedDiagram(t: ObjectTarget): Promise<string | null> {
  const ref = tablesOf(t)[0];
  if (!ref) return null;
  const database = catalogDatabase(t.connectionId, t.database);
  const schema = ref.schema ?? (await defaultSchema(t.connectionId, database)) ?? '';
  await useCatalog.getState().loadSchema(t.connectionId, database, schema);
  const key = tableKey(schema, ref.name);
  let incoming: string[] = [];
  try {
    const details = await api.objectDetails(t.connectionId, database, { ...ref, schema });
    incoming = details.referencedBy.map((r) => tableKey(r.schema ?? schema, r.table));
    for (const fk of details.foreignKeys) incoming.push(tableKey(fk.refSchema ?? schema, fk.refTable));
  } catch {
    // details are optional: the loaded catalog already has the FKs of its schemas
  }
  const d = useCatalog.getState().dbs[dbKey(t.connectionId, database)];
  const tables = relatedTables(Object.values(d?.loaded ?? {}), key, incoming);
  return openDiagram({ connectionId: t.connectionId, database, scope: { database, tables } }, { related: ref.name });
}

/** Dev/QA: a generated catalog (500 tables × 20 columns × 700 FKs by default). */
export function openSyntheticDiagram(spec: SyntheticSpec = { tables: 500, columns: 20, fks: 700 }): string {
  return openDiagram({ connectionId: 'synthetic', database: null, scope: { database: null, schema: 'main' }, synthetic: spec });
}

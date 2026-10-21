// Entry points of the designer package: resolve where a command applies (explorer target, active tab, first
// connection) and open the table/view designer tabs, the procedure wizard, or an "edit object" script (F4).
import { api, errorMessage } from '../api/client';
import type { CatalogObjectType, Dialect, ObjectRef } from '../api/types';
import { catalogDatabase, newConsole, preloadCatalog } from '../app/actions';
import { targetOf } from '../commands/core';
import { isConnectionTarget, isContainerTarget, isObjectTarget, isTabTarget, type ObjectTarget } from '../commands/types';
import { qualifiedName } from '../lib/sql';
import { dbKey, useCatalog } from '../store/catalog';
import { dialectOf, getConnection, useConnections } from '../store/connections';
import { useSessions } from '../store/sessions';
import { getActiveTab, useTabs, type Tab } from '../store/tabs';
import { toast } from '../store/ui';
import { rememberEdit } from './editSession';
import { rewriteForEdit } from './rewrite';
import { useDesignerUi } from './store';

export const TABLE_VIEW = 'designer.table';
export const VIEW_VIEW = 'designer.view';

export interface DesignerContext {
  connectionId: string;
  database: string | null;
  schema: string | null;
  dialect: Dialect;
}

export interface TableDesignerState {
  connectionId: string;
  database: string | null;
  schema: string | null;
  /** Existing table (alter mode); null while designing a new table. */
  name: string | null;
  /** Unsaved work, kept in the workspace so a restart restores it. */
  desired?: unknown;
  original?: unknown;
  preview?: string | null;
}

export interface ViewDesignerState {
  connectionId: string;
  database: string | null;
  schema: string | null;
  name: string | null;
  body?: string;
  newName?: string;
  options?: { schemaBinding: boolean; checkOption: boolean; force: boolean };
}

export function defaultSchemaOf(connectionId: string, database: string | null): string | null {
  const d = useCatalog.getState().dbs[dbKey(connectionId, catalogDatabase(connectionId, database))];
  if (d?.defaultSchema) return d.defaultSchema;
  const dialect = dialectOf(connectionId);
  return dialect === 'sqlite' ? 'main' : dialect === 'tsql' ? 'dbo' : null;
}

function tabContext(t: Tab | undefined): { connectionId: string; database: string | null; schema: string | null } | null {
  if (!t || !t.connectionId) return null;
  if (t.kind === 'object') return { connectionId: t.connectionId, database: t.database, schema: t.ref.schema };
  const st = t.kind === 'view' ? (t.state as { schema?: string | null } | null) : null;
  return { connectionId: t.connectionId, database: t.database, schema: st?.schema ?? null };
}

/** Where a "new …" / "edit" command applies: its target, else the explorer selection, else the active tab, else the first connection. */
export function contextOf(args?: unknown): DesignerContext | null {
  let base: { connectionId: string; database: string | null; schema: string | null } | null = null;
  if (isTabTarget(args)) base = tabContext(useTabs.getState().tabs.find((t) => t.id === args.tabId));
  else {
    const t = targetOf(args);
    if (isObjectTarget(t)) base = { connectionId: t.connectionId, database: t.database, schema: t.ref.schema };
    else if (isContainerTarget(t)) base = { connectionId: t.connectionId, database: t.database, schema: t.schema };
    else if (isConnectionTarget(t)) base = { connectionId: t.connectionId, database: null, schema: null };
  }
  base ??= tabContext(getActiveTab());
  if (!base) {
    const first = useConnections.getState().connections[0];
    if (first) base = { connectionId: first.id, database: null, schema: null };
  }
  if (!base || !getConnection(base.connectionId)) return null;
  return { ...base, schema: base.schema ?? defaultSchemaOf(base.connectionId, base.database), dialect: dialectOf(base.connectionId) };
}

/** The object a command applies to: its target, else the explorer selection, else the active object/designer tab. */
export function objectOf(args?: unknown): ObjectTarget | null {
  if (!isTabTarget(args)) {
    const t = targetOf(args);
    if (isObjectTarget(t)) return t;
  }
  const tab = isTabTarget(args) ? useTabs.getState().tabs.find((t) => t.id === args.tabId) : getActiveTab();
  if (tab?.kind === 'object') return { kind: 'object', connectionId: tab.connectionId, database: tab.database, ref: tab.ref };
  if (tab?.kind === 'view' && tab.connectionId && (tab.view === TABLE_VIEW || tab.view === VIEW_VIEW)) {
    const st = tab.state as TableDesignerState | ViewDesignerState | null;
    if (st?.name) {
      return { kind: 'object', connectionId: tab.connectionId, database: tab.database, ref: { database: tab.database, schema: st.schema, name: st.name, type: tab.view === TABLE_VIEW ? 'table' : 'view' } };
    }
  }
  return null;
}

/**
 * Tab key of a designer tab, so F4 on the same object activates the open designer instead of opening a second one.
 * The database is normalised to the one the catalog uses (a console's "current database" (null) and the explorer's
 * explicit 'main' are the same database), so the key does not depend on where the designer was opened from.
 */
export function designerKey(kind: 'table' | 'view', c: { connectionId: string; database: string | null; schema: string | null }, name: string): string {
  const db = catalogDatabase(c.connectionId, c.database);
  return `${kind}|${c.connectionId}|${db ?? ''}|${c.schema ?? ''}|${name}`;
}

/** Tab titles qualify the name, except SQLite's main and PostgreSQL's public schema (the usual search_path). */
function titleName(dialect: Dialect, schema: string | null, name: string): string {
  if (dialect === 'pgsql') return qualifiedName({ schema, name }, dialect, { defaultSchema: 'public' });
  return qualifiedName({ schema, name }, dialect, { always: dialect !== 'sqlite' });
}

export function tableTitle(dialect: Dialect, schema: string | null, name: string | null): string {
  return name ? `Design: ${titleName(dialect, schema, name)}` : 'New table';
}

export function openTableDesigner(ctx: DesignerContext, name: string | null): string {
  void preloadCatalog(ctx.connectionId, ctx.database);
  return useTabs.getState().openView({
    view: TABLE_VIEW,
    title: tableTitle(ctx.dialect, ctx.schema, name),
    connectionId: ctx.connectionId,
    database: ctx.database,
    state: { connectionId: ctx.connectionId, database: ctx.database, schema: ctx.schema, name } satisfies TableDesignerState,
    key: name ? designerKey('table', ctx, name) : null,
  });
}

export function viewTitle(dialect: Dialect, schema: string | null, name: string | null): string {
  return name ? `View: ${titleName(dialect, schema, name)}` : 'New view';
}

export function openViewDesigner(ctx: DesignerContext, name: string | null): string {
  void preloadCatalog(ctx.connectionId, ctx.database);
  return useTabs.getState().openView({
    view: VIEW_VIEW,
    title: viewTitle(ctx.dialect, ctx.schema, name),
    connectionId: ctx.connectionId,
    database: ctx.database,
    state: { connectionId: ctx.connectionId, database: ctx.database, schema: ctx.schema, name } satisfies ViewDesignerState,
    key: name ? designerKey('view', ctx, name) : null,
  });
}

export function openProcedureWizard(ctx: DesignerContext, opts: { kind?: 'procedure' | 'function' | 'package' | 'trigger'; table?: string | null; packageName?: string | null } = {}): void {
  void preloadCatalog(ctx.connectionId, ctx.database);
  useDesignerUi.getState().openWizard({ ...ctx, kind: opts.kind ?? (ctx.dialect === 'sqlite' ? 'trigger' : 'procedure'), table: opts.table ?? null, packageName: opts.packageName ?? null });
}

const SCRIPT_TYPES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc', 'package', 'trigger', 'type', 'mview']);

/** F4: tables → table designer, views → view designer, routines/packages/triggers → editable script. */
export async function editObject(t: ObjectTarget): Promise<void> {
  const ctx: DesignerContext = { connectionId: t.connectionId, database: t.database, schema: t.ref.schema, dialect: dialectOf(t.connectionId) };
  if (t.ref.type === 'table') {
    openTableDesigner(ctx, t.ref.name);
    return;
  }
  if (t.ref.type === 'view') {
    openViewDesigner(ctx, t.ref.name);
    return;
  }
  if (SCRIPT_TYPES.has(t.ref.type)) {
    await openEditScript(t.connectionId, t.database, t.ref);
    return;
  }
  toast('info', `There is no designer for ${t.ref.type} objects`, 'Open the DDL instead (Enter).');
}

function productVersionOf(connectionId: string): string | null {
  const s = Object.values(useSessions.getState().sessions).find((x) => x.connectionId === connectionId);
  return s?.serverInfo.productVersion ?? null;
}

/** Opens the stored DDL of a routine/package/trigger in an editable console with the re-runnable header. */
export async function openEditScript(connectionId: string, database: string | null, ref: ObjectRef): Promise<string | null> {
  const dialect = dialectOf(connectionId);
  let ddl: string;
  try {
    ddl = (await api.ddl(connectionId, database, ref)).ddl;
  } catch (e) {
    toast('error', `Could not load the definition of ${ref.name}`, errorMessage(e));
    return null;
  }
  const r = rewriteForEdit(ddl, { dialect, type: ref.type, name: ref.name, schema: ref.schema, productVersion: productVersionOf(connectionId) });
  const id = newConsole(connectionId, database, r.text);
  useTabs.getState().rename(id, `Edit: ${ref.name}`);
  // Persisted in the tab too: after a restart the tab still applies atomically and offers "Compare with server".
  rememberEdit(id, { connectionId, database, ref, serverDdl: ddl, dialect });
  toast('info', `Editing ${qualifiedName(ref, dialect, { always: dialect !== 'sqlite' })}`, `${r.note ?? 'Definition loaded'}. Run the script (F5) to apply; “Compare with server” shows your changes.`);
  return id;
}

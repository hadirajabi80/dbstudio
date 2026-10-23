// Saved queries: open, save (Ctrl+S in a bound console), save a console to a schema, rename, duplicate, delete.
// Loaded with the package's commands (a lazy chunk), never by the shell's first paint.
import { errorMessage, isApiError } from '../../api/client';
import { savedQueriesApi, type SavedQuery, type SavedQueryScope } from '../../api/savedQueries';
import { catalogDatabase, copyText, preloadCatalog } from '../../app/actions';
import { getEditor } from '../../app/editors';
import { displayShortcut } from '../../commands/keys';
import { isContainerTarget, isObjectTarget, isSavedQueryTarget, type CommandTarget, type SavedQueryTarget } from '../../commands/types';
import { dbKey, useCatalog } from '../../store/catalog';
import { getConnection, providerKind, schemaIsDatabase } from '../../store/connections';
import { findSavedQuery, freeQueryName, scopeLabel, useSavedQueries } from '../../store/savedQueries';
import { savedQueryTitle, useTabs, type ConsoleTab } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import { useExplorer } from '../Explorer/explorerStore';
import { nodeId } from '../Explorer/tree';
import { useSavedQueryDialog } from './dialogStore';
import { bindingOf, consoleDatabaseFor, suggestedNameFromTitle, targetOfQuery } from './model';

function consoleTab(tabId: string | null | undefined): ConsoleTab | undefined {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return t?.kind === 'console' ? t : undefined;
}

function isRelational(connectionId: string | null | undefined): connectionId is string {
  const c = connectionId ? getConnection(connectionId) : undefined;
  return !!c && providerKind(c.providerId) === 'relational';
}

/** Consoles bound to a saved query. */
export function consolesOf(id: string): ConsoleTab[] {
  return useTabs.getState().tabs.filter((t): t is ConsoleTab => t.kind === 'console' && t.savedQuery?.id === id);
}

/** The default schema of a database in the catalog (single-schema databases: that schema). */
function defaultSchemaOf(connectionId: string, database: string | null): string | null {
  const d = useCatalog.getState().dbs[dbKey(connectionId, database)];
  const list = d?.schemasResp?.schemas;
  return d?.schemasResp?.defaultSchema ?? d?.defaultSchema ?? (list?.length === 1 ? list[0].name : null)
    ?? (getConnection(connectionId)?.providerId === 'sqlite' ? 'main' : null);
}

/** Where an explorer / Objects tab node lives (a schema node, a folder, an object, a saved query). */
export function scopeOfTarget(t: CommandTarget | null | undefined): SavedQueryScope | null {
  if (!t || !('connectionId' in t) || !isRelational(t.connectionId)) return null;
  if (isSavedQueryTarget(t)) return { connectionId: t.connectionId, database: t.database, schema: t.schema };
  if (isContainerTarget(t)) {
    const database = t.database ?? catalogDatabase(t.connectionId, null);
    return { connectionId: t.connectionId, database, schema: t.schema ?? defaultSchemaOf(t.connectionId, database) };
  }
  if (isObjectTarget(t)) {
    const database = t.database ?? catalogDatabase(t.connectionId, null);
    return { connectionId: t.connectionId, database, schema: t.ref.schema ?? defaultSchemaOf(t.connectionId, database) };
  }
  if (t.kind === 'connection') {
    const database = catalogDatabase(t.connectionId, null);
    return { connectionId: t.connectionId, database, schema: defaultSchemaOf(t.connectionId, database) };
  }
  return null;
}

/**
 * Where "Save query to schema…" saves a console by default: the console's database and current schema (Oracle: the
 * session schema), refined by the explorer's selection when that is a schema of the same database.
 */
export function consoleScope(tab: ConsoleTab): SavedQueryScope | null {
  const cid = tab.connectionId;
  if (!isRelational(cid)) return null;
  const oracle = schemaIsDatabase(getConnection(cid)?.providerId); // Oracle and the Batch 3 single-level providers
  const database = catalogDatabase(cid, tab.database);
  let schema = oracle ? tab.database ?? defaultSchemaOf(cid, database) : defaultSchemaOf(cid, database);
  const sel = scopeOfTarget(useExplorer.getState().selectedTarget);
  if (sel && sel.connectionId === cid && (sel.database ?? '') === (database ?? '') && sel.schema) schema = sel.schema;
  return { connectionId: cid, database, schema };
}

/** A console that can be saved to a schema: the tab of a context menu, else the active console. */
export function saveableConsole(tabId?: string | null): ConsoleTab | undefined {
  const tab = consoleTab(tabId ?? useTabs.getState().activeId);
  return tab && isRelational(tab.connectionId) ? tab : undefined;
}

/** "Save query to schema…": the dialog, defaulting to the console's database and schema. */
export function saveConsoleToSchema(tabId?: string | null): boolean {
  const tab = saveableConsole(tabId);
  if (!tab?.connectionId) return false;
  const scope = consoleScope(tab);
  if (!scope) return false;
  void useSavedQueries.getState().ensure(tab.connectionId);
  void preloadCatalog(tab.connectionId, tab.database).catch(() => undefined);
  useSavedQueryDialog.getState().open({ mode: 'save', tabId: tab.id, connectionId: tab.connectionId, scope, name: suggestedNameFromTitle(tab.title) });
  return true;
}

/** The text of a console as the editor has it right now. */
function textOf(tab: ConsoleTab): string {
  return getEditor(tab.id)?.getValue() ?? tab.text;
}

/** Saves a console as a new query of `scope` and binds the console to it ("Query: name"). */
export async function saveConsoleAs(tabId: string, scope: SavedQueryScope, name: string, description: string | null): Promise<SavedQuery> {
  const tab = consoleTab(tabId);
  if (!tab) throw new Error('The console was closed.');
  const sql = textOf(tab);
  const q = await useSavedQueries.getState().create(scope.connectionId, { database: scope.database, schema: scope.schema, name, sql, description });
  useTabs.getState().bindSavedQuery(tabId, bindingOf(q), { savedText: sql });
  toast('success', `Saved query ${q.name}`, `In ${scopeLabel(q)}. ${displayShortcut('Mod+S')} now saves your changes to it.`);
  return q;
}

/** A new, empty query in a schema, opened in a console. */
export async function createQuery(scope: SavedQueryScope, name: string, description: string | null): Promise<SavedQuery> {
  const q = await useSavedQueries.getState().create(scope.connectionId, { database: scope.database, schema: scope.schema, name, sql: '', description });
  openSavedQuery(q);
  revealQuery(q);
  return q;
}

/** "New query…" on a Queries folder, a schema or the Objects tab: asks for the name. */
export function newQueryIn(t: CommandTarget | null | undefined): boolean {
  const scope = scopeOfTarget(t);
  if (!scope) return false;
  void useSavedQueries.getState().ensure(scope.connectionId);
  useSavedQueryDialog.getState().open({ mode: 'new', scope });
  return true;
}

async function resolve(t: SavedQueryTarget): Promise<SavedQuery | null> {
  const known = findSavedQuery(t.id, t.connectionId);
  if (known) return known;
  try {
    return await savedQueriesApi.get(t.connectionId, t.id);
  } catch (e) {
    toast('error', `Could not open the query ${t.name}`, errorMessage(e));
    return null;
  }
}

/**
 * Opens a saved query in a console bound to it (connection, database, schema), or brings its open console to the
 * front.
 */
export function openSavedQuery(t: SavedQueryTarget | SavedQuery): void {
  const open = consolesOf(t.id)[0];
  if (open) {
    useTabs.getState().activate(open.id);
    useTabs.getState().requestFocus(open.id);
    return;
  }
  const show = (q: SavedQuery) => {
    if (consolesOf(q.id)[0]) return openSavedQuery(q);
    const database = consoleDatabaseFor(getConnection(q.connectionId)?.providerId, q);
    const tabs = useTabs.getState();
    const id = tabs.newConsole({ connectionId: q.connectionId, database, text: q.sql, title: savedQueryTitle(q.name) });
    tabs.bindSavedQuery(id, bindingOf(q), { savedText: q.sql });
    void preloadCatalog(q.connectionId, database).catch(() => undefined);
    setTimeout(() => getEditor(id)?.focus(), 50);
  };
  if ('sql' in t) show(t);
  else void resolve(t).then((q) => q && show(q));
}

/** Ctrl+S in a console bound to a saved query: writes the editor text back to the query. */
export async function saveBoundQuery(tabId: string): Promise<boolean> {
  const tab = consoleTab(tabId);
  const b = tab?.savedQuery;
  if (!tab || !b) return false;
  if (tab.connectionId !== b.connectionId) {
    toast('warning', `This console no longer points at the connection of the query ${b.name}`,
      'Switch the connection back to save it, or use Save query to schema… to save a copy here.');
    return false;
  }
  const sql = textOf(tab);
  try {
    const q = await useSavedQueries.getState().update(b.connectionId, b.id, { sql });
    const cur = consoleTab(tabId);
    if (cur?.savedQuery?.id === q.id) useTabs.getState().bindSavedQuery(tabId, bindingOf(q), { savedText: sql, title: cur.title });
    return true;
  } catch (e) {
    if (isApiError(e, 'NOT_FOUND')) {
      toast('error', `The query ${b.name} was deleted`, 'Save it again with Save query to schema….', {
        label: 'Save to schema…', run: () => saveConsoleToSchema(tabId),
      });
      useTabs.getState().bindSavedQuery(tabId, null);
      void useSavedQueries.getState().load(b.connectionId);
    } else toast('error', `The query ${b.name} was not saved`, errorMessage(e));
    return false;
  }
}

/** Rename (and description): the dialog. */
export async function renameSavedQuery(t: SavedQueryTarget): Promise<void> {
  const q = await resolve(t);
  if (q) useSavedQueryDialog.getState().open({ mode: 'rename', query: q });
}

/** After a rename: the bound consoles follow (their title too, unless the user renamed the tab). */
export function applyRename(before: Pick<SavedQuery, 'name'>, q: SavedQuery): void {
  for (const tab of consolesOf(q.id)) {
    const title = tab.title === savedQueryTitle(before.name) ? savedQueryTitle(q.name) : tab.title;
    useTabs.getState().bindSavedQuery(tab.id, bindingOf(q), { savedText: tab.savedText, title });
  }
}

export async function duplicateSavedQuery(t: SavedQueryTarget): Promise<void> {
  try {
    const copy = await useSavedQueries.getState().duplicate(t.connectionId, t.id);
    revealQuery(copy);
    toast('success', `Duplicated as ${copy.name}`);
  } catch (e) {
    toast('error', `Could not duplicate ${t.name}`, errorMessage(e));
  }
}

export async function deleteSavedQuery(t: SavedQueryTarget): Promise<void> {
  const open = consolesOf(t.id);
  const where = scopeLabel(t);
  const ok = await useUi.getState().askConfirm({
    title: 'Delete query',
    message: `Delete the saved query “${t.name}” from ${where}? This cannot be undone.${open.length ? ' Its open console stays open as an ordinary console.' : ''}`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await useSavedQueries.getState().remove(t.connectionId, t.id);
  } catch (e) {
    if (!isApiError(e, 'NOT_FOUND')) {
      toast('error', `Could not delete ${t.name}`, errorMessage(e));
      return;
    }
    void useSavedQueries.getState().load(t.connectionId);
  }
  for (const tab of consolesOf(t.id)) {
    useTabs.getState().bindSavedQuery(tab.id, null);
    if (tab.title === savedQueryTitle(t.name)) useTabs.getState().rename(tab.id, t.name);
  }
  toast('info', `Deleted query ${t.name}`);
}

export async function copyQuerySql(t: SavedQueryTarget): Promise<void> {
  const q = await resolve(t);
  if (q) await copyText(q.sql, 'SQL copied to the clipboard');
}

/** Selects a query in the explorer (its Queries folder expanded), leaving the focus where it is. */
export function revealQuery(q: SavedQuery): void {
  const { connectionId: c, database, schema } = q;
  const s = schema ?? '';
  const ancestors = [nodeId.conn(c), nodeId.db(c, database), nodeId.schema(c, database, s), nodeId.queries(c, database, s)];
  useExplorer.getState().selectNode(nodeId.savedQuery(c, q.id), targetOfQuery(q), ancestors);
}

/** A free name for a new query of the scope ("Query 3"), or the suggestion when it is free. */
export function defaultName(scope: SavedQueryScope, suggestion?: string): string {
  return freeQueryName(useSavedQueries.getState().byConn[scope.connectionId]?.items, scope, suggestion);
}

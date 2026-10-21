// App-level commands that coordinate several stores (run, transactions, tabs, export).
import { api, errorMessage, isApiError } from '../api/client';
import type { ExportFormat, ObjectRef, QueryParam, RunLabel, SessionInfo, SqlBatch, TxMode } from '../api/types';
import { resolveParams } from '../components/ParamsDialog/ParamsDialog';
import { findDestructive } from '../lib/classify';
import { serializeRows, type CopyFormat } from '../lib/serialize';
import { computeView } from '../lib/filter';
import { selectTopSql } from '../lib/sql';
import { getPlatform } from '../platform';
import { effectiveViewportHeight } from './zoom';
import { dbKey, useCatalog } from '../store/catalog';
import { getSourceModule } from '../lib/sources';
import { dialectOf, getConnection, providerKind, useConnections } from '../store/connections';
import { useSourceClients } from '../store/sourceClients';
import { useHistory } from '../store/history';
import { useResults, viewKey } from '../store/results';
import { createExecution, isRunning, type ExecutionState, type ResultSetState } from '../store/resultsReducer';
import { isForeignSession, useSessions } from '../store/sessions';
import { openRoutinesInEditMode, useSettings } from '../store/settings';
import { useTabs, type ConsoleTab } from '../store/tabs';
import { SHORT_WINDOW, toast, useUi } from '../store/ui';
import { displayShortcut } from '../commands/keys';
import { pluralize } from '../components/common/text';
import { getTabView } from '../components/layout/tabViews';
import { runEditTab } from '../designer/editRun';
import { editSessionOf, peekEditSession, rememberEdit } from '../designer/editSession';
import { EDIT_RUN_STOP_REASON, useDesignerUi } from '../designer/store';
import { getEditor } from './editors';
import { interceptRoutineRun, routineEditOf } from '../components/ExecuteRoutine/intercept';
import { runCommand } from '../commands/registry';

let localSeq = 0;

function consoleTab(tabId: string): ConsoleTab | undefined {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return t?.kind === 'console' ? t : undefined;
}

/** Database the tab effectively uses: its own choice, else the connection's current database. */
export function effectiveDatabase(connectionId: string | null, database: string | null): string | null {
  if (!connectionId) return null;
  const c = getConnection(connectionId);
  // M2: Redis/MongoDB/Kafka have no SQL database.
  if (c && providerKind(c.providerId) !== 'relational') return null;
  if (database) return database;
  if (c?.providerId === 'oracle') return null;
  return useCatalog.getState().conns[connectionId]?.databases?.current ?? null;
}

/**
 * Catalog cache key for a tab's database. Oracle has no database level (the tab's "database" is the
 * session's current schema), so its catalog is always keyed by null.
 */
export function catalogDatabase(connectionId: string | null, database: string | null): string | null {
  if (!connectionId) return null;
  const c = getConnection(connectionId);
  if (c?.providerId === 'oracle' || (c && providerKind(c.providerId) !== 'relational')) return null;
  return effectiveDatabase(connectionId, database);
}

export function effectiveMaxRows(tab: ConsoleTab): number {
  return tab.maxRows ?? useSettings.getState().settings.results.maxRows;
}

export interface RunOptions {
  maxRows?: number;
  /**
   * The user explicitly allowed this run to change data. Only ever set from an explicit confirmation (the destructive
   * statement dialog on a writable connection, or the armed read-only override); never implied.
   */
  confirmedDestructive?: boolean;
  /** Bind values already collected (e.g. on a retry); skips the parameters dialog. */
  params?: QueryParam[];
  /** Run the batches as given even in an "Edit:" tab (the atomic designer apply is skipped). */
  plain?: boolean;
  /**
   * The batches are not the console's editor text (Execute routine runs its call in the current console): their
   * error lines are not marked in the editor.
   */
  detached?: boolean;
}

/**
 * READ_ONLY refusal: the engine rejected a statement on a connection marked read-only. There is no one-click
 * "Run anyway": the danger button only enables after ticking "Allow this statement to write to <name>", and Cancel
 * has the focus. Returns true when the user armed and confirmed the override.
 */
export async function askReadOnlyOverride(connectionName: string, detail: string, what = 'statement'): Promise<boolean> {
  const r = await useUi.getState().askConfirmAck({
    title: 'Read-only connection',
    message: `“${connectionName}” is marked read-only, and the engine refused a ${what} that changes data. Change the connection settings to allow writes permanently.`,
    items: [detail],
    confirmLabel: 'Run with writes',
    danger: true,
    ack: { label: `Allow this ${what} to write to “${connectionName}”`, required: true },
  });
  return r.ok && r.ack;
}

export async function runInTab(tabId: string, label: RunLabel, batches: SqlBatch[], opts: RunOptions = {}): Promise<void> {
  const tab = consoleTab(tabId);
  if (!tab) return;
  // F4 "Edit:" consoles on SQLite apply the whole script atomically through the designer (a failing CREATE must not
  // leave the object dropped). The registration is persisted in the tab, so a tab restored after a restart does too.
  if (!opts.plain && peekEditSession(tabId) && (await runEditTab(tabId))) return;
  if (batches.length === 0 || batches.every((b) => !b.sql.trim())) return;
  const ui = useUi.getState();
  if (!tab.connectionId) {
    toast('warning', 'Choose a connection for this console first');
    return;
  }
  const conn = getConnection(tab.connectionId);
  if (!conn) {
    toast('error', 'The connection of this console no longer exists');
    return;
  }
  const running = useResults.getState().executions[useResults.getState().byTab[tabId]];
  if (isRunning(running)) {
    toast('warning', 'A query is already running in this console', 'Cancel it first (Esc) or open another console.');
    return;
  }

  let confirmed = opts.confirmedDestructive ?? false;
  const dialect = dialectOf(conn.id);
  if (!confirmed && !conn.readOnly && useSettings.getState().settings.confirmDestructive) {
    const findings = findDestructive(batches, dialect);
    if (findings.length) {
      const ok = await ui.askConfirm({
        title: 'Run destructive statement?',
        message: `This will modify data on “${conn.name}”. Review what is about to run:`,
        items: findings.map((f) => `Line ${f.line}: ${f.description}`),
        confirmLabel: 'Run anyway',
        danger: true,
      });
      if (!ok) return;
      confirmed = true;
    }
  }

  // Statements with bind parameters (@id, :id, ?, $1) ask for values first; null = the user cancelled.
  const params = opts.params ?? await resolveParams(tabId, conn.id, dialect, batches);
  if (params === null) return;

  const maxRows = opts.maxRows ?? effectiveMaxRows(tab);
  const localId = `l${++localSeq}`;
  useResults.getState().begin(createExecution({
    localId, tabId, connectionId: conn.id, sessionId: useSessions.getState().byTab[tabId] ?? null, label, batches, maxRows,
    confirmedDestructive: confirmed, params: params ?? null, detached: opts.detached,
  }));
  if (!useUi.getState().resultsVisible) useUi.getState().toggle('resultsVisible');
  noteFirstRun(tabId);

  try {
    const session = await useSessions.getState().ensure(tabId, conn.id, effectiveDatabase(conn.id, tab.database), tab.txMode);
    useConnections.getState().touch(conn.id);
    const res = await api.execute(session.sessionId, {
      batches, maxRows, stopOnError: true, label, source: { tabId, title: tab.title },
      ...(confirmed ? { confirmedDestructive: true } : {}),
      ...(params?.length ? { params } : {}),
    });
    useResults.getState().attach(localId, res.executionId);
  } catch (e) {
    if (isApiError(e, 'READ_ONLY') && !confirmed) {
      useResults.getState().fail(localId, errorMessage(e), 'READ_ONLY');
      if (await askReadOnlyOverride(conn.name, errorMessage(e))) {
        await runInTab(tabId, label, batches, { ...opts, confirmedDestructive: true, params: params ?? [] });
      }
      return;
    }
    if (isApiError(e, 'SESSION_LIMIT')) {
      // The toast carries the advice and the action; the message pane shows the engine's text once.
      useResults.getState().fail(localId, errorMessage(e), 'SESSION_LIMIT');
      offerCloseIdle(conn.id, () => void runInTab(tabId, label, batches, { ...opts, confirmedDestructive: confirmed, params: params ?? [] }));
      return;
    }
    const hint = isApiError(e, 'SESSION_BUSY') ? 'The session is busy with another statement.' : undefined;
    useResults.getState().fail(localId, hint ? `${errorMessage(e)} ${hint}` : errorMessage(e), isApiError(e) ? e.code : null);
  }
}

/**
 * Run from toolbar / palette / global shortcut: ask the editor what to run. In an "Edit:" console of a procedure or
 * function, Run without a selection opens Execute routine instead of re-running the CREATE (applying it is Save);
 * `asScript` runs the editor text anyway (the Run button's "Run script" menu item).
 */
export function runActive(label: RunLabel, opts: { asScript?: boolean } = {}): void {
  const tabId = useTabs.getState().activeId;
  if (!tabId || !consoleTab(tabId)) return;
  if (!opts.asScript && routineEditOf(tabId)) {
    const target = getEditor(tabId)?.getRunTarget(label);
    if (target?.label === 'selection') void runInTab(tabId, 'selection', target.batches);
    else interceptRoutineRun(tabId, label);
    return;
  }
  if (peekEditSession(tabId)) {
    void runEditTab(tabId).then((handled) => {
      if (!handled) runTargetOf(tabId, label);
    });
    return;
  }
  runTargetOf(tabId, label);
}

function runTargetOf(tabId: string, label: RunLabel): void {
  const ed = getEditor(tabId);
  const target = ed?.getRunTarget(label);
  if (!target) {
    toast('info', 'Nothing to run');
    return;
  }
  void runInTab(tabId, label, target.batches);
}

export async function rerun(tabId: string, opts: RunOptions = {}): Promise<void> {
  const e = useResults.getState().executions[useResults.getState().byTab[tabId]];
  if (!e) return;
  // A re-run asks again: a write override confirmed for one run is never carried over implicitly.
  await runInTab(tabId, e.label, e.batches, { plain: true, detached: e.detached, ...opts });
}

/**
 * Why the running query of a tab cannot be cancelled, or null when it can (or nothing runs). An "Edit:" console's
 * atomic apply (designer/editRun.ts) is one engine request without a session: it cannot be stopped, so the Stop button
 * is disabled with this reason as its tooltip.
 */
export function cancelBlockedReason(tabId: string | null = useTabs.getState().activeId): string | null {
  return tabId && useDesignerUi.getState().editRunInFlight[tabId] ? EDIT_RUN_STOP_REASON : null;
}

/** Cancel the running query of a tab. Returns the reason when it cannot be cancelled (see cancelBlockedReason). */
export async function cancelTab(tabId: string | null = useTabs.getState().activeId): Promise<string | null> {
  if (!tabId) return null;
  const blocked = cancelBlockedReason(tabId);
  if (blocked) {
    toast('info', 'This change cannot be stopped', `${blocked}.`);
    return blocked;
  }
  const s = useSessions.getState().forTab(tabId);
  const e = useResults.getState().executions[useResults.getState().byTab[tabId]];
  if (!s || !isRunning(e)) return null;
  try {
    await api.cancel(s.sessionId);
  } catch (err) {
    toast('error', 'Cancel failed', errorMessage(err));
  }
  return null;
}

export async function setTxMode(tabId: string, mode: TxMode): Promise<void> {
  const s = useSessions.getState().forTab(tabId);
  if (s?.txOpen && mode === 'auto') {
    toast('warning', 'Commit or roll back the open transaction before switching to Auto-commit');
    return;
  }
  useTabs.getState().setTxMode(tabId, mode);
  try {
    await useSessions.getState().setTxMode(tabId, mode);
  } catch (e) {
    toast('error', 'Could not change transaction mode', errorMessage(e));
  }
}

export async function commitTab(tabId: string | null = useTabs.getState().activeId): Promise<void> {
  if (!tabId) return;
  try {
    await useSessions.getState().commit(tabId);
    toast('success', 'Transaction committed');
  } catch (e) {
    toast('error', 'Commit failed', errorMessage(e));
  }
}

export async function rollbackTab(tabId: string | null = useTabs.getState().activeId): Promise<void> {
  if (!tabId) return;
  try {
    await useSessions.getState().rollback(tabId);
    toast('info', 'Transaction rolled back');
  } catch (e) {
    toast('error', 'Rollback failed', errorMessage(e));
  }
}

/** Switch a console to another connection/database. Closes the old session (asking first when a tx is open). */
export async function switchConnection(tabId: string, connectionId: string | null, database: string | null = null): Promise<void> {
  const tab = consoleTab(tabId);
  if (!tab) return;
  const s = useSessions.getState().forTab(tabId);
  if (s && s.connectionId !== connectionId) {
    if (s.txOpen) {
      const ok = await useUi.getState().askConfirm({
        title: 'Open transaction',
        message: 'This console has an uncommitted transaction. Switching connection rolls it back.',
        confirmLabel: 'Roll back and switch',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await useSessions.getState().close(tabId, true);
    } catch (e) {
      console.warn('[tabs] closing old session failed', e);
    }
    useResults.getState().clearTab(tabId);
  }
  useTabs.getState().setConnection(tabId, connectionId, database);
  if (connectionId) void preloadCatalog(connectionId, database);
}

export async function switchDatabase(tabId: string, database: string | null): Promise<void> {
  const tab = consoleTab(tabId);
  if (!tab) return;
  useTabs.getState().setDatabase(tabId, database);
  if (tab.connectionId) void preloadCatalog(tab.connectionId, database);
  if (database && useSessions.getState().forTab(tabId)) {
    try {
      await useSessions.getState().changeDatabase(tabId, database);
    } catch (e) {
      toast('error', 'Could not change database', errorMessage(e));
    }
  }
}

export async function preloadCatalog(connectionId: string, database: string | null): Promise<void> {
  // M2: non-relational sources have no SQL catalog (their module loads its own data).
  const c = getConnection(connectionId);
  if (c && providerKind(c.providerId) !== 'relational') return;
  const cat = useCatalog.getState();
  await cat.loadDatabases(connectionId);
  await cat.ensureDefault(connectionId, catalogDatabase(connectionId, database));
}

export async function closeTab(tabId: string): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const s = useSessions.getState().forTab(tabId);
  const exec = useResults.getState().executions[useResults.getState().byTab[tabId]];
  if (s?.txOpen || isRunning(exec)) {
    const ok = await useUi.getState().askConfirm({
      title: s?.txOpen ? 'Uncommitted transaction' : 'Query running',
      message: s?.txOpen
        ? `“${tab.title}” has an open transaction. Closing the console rolls it back.`
        : `A query is still running in “${tab.title}”. Closing the console cancels it.`,
      confirmLabel: s?.txOpen ? 'Roll back and close' : 'Cancel and close',
      danger: true,
    });
    if (!ok) return;
  } else if (tab.kind === 'console' && tab.filePath && tab.text !== tab.savedText) {
    const ok = await useUi.getState().askConfirm({
      title: 'Unsaved changes',
      message: `“${tab.title}” has changes that are not saved to ${tab.filePath}.`,
      confirmLabel: 'Close without saving',
      danger: true,
    });
    if (!ok) return;
  } else if (tab.kind === 'view') {
    const def = getTabView(tab.view);
    if (def?.beforeClose) {
      if (!(await def.beforeClose(tab))) return;
    } else if (tab.dirty) {
      const ok = await useUi.getState().askConfirm({
        title: 'Discard changes?',
        message: `“${tab.title}” has changes that were not applied.`,
        confirmLabel: 'Discard and close',
        danger: true,
      });
      if (!ok) return;
    }
  }
  useTabs.getState().close(tabId);
  if (tab.kind === 'view') getTabView(tab.view)?.onClosed?.(tab);
  useResults.getState().clearTab(tabId);
  if (s) {
    try {
      await useSessions.getState().close(tabId, true);
    } catch (e) {
      console.warn('[tabs] session close failed', e);
    }
  }
}

export function newConsole(connectionId?: string | null, database?: string | null, text?: string): string {
  const active = useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId);
  const cid = connectionId === undefined ? active?.connectionId ?? useConnections.getState().connections[0]?.id ?? null : connectionId;
  const db = database === undefined ? (active?.connectionId === cid ? active?.database ?? null : null) : database;
  const id = useTabs.getState().newConsole({ connectionId: cid, database: db, text });
  if (cid) void preloadCatalog(cid, db);
  setTimeout(() => getEditor(id)?.focus(), 50);
  return id;
}

export function selectTop(connectionId: string, database: string | null, ref: ObjectRef, n = 1000): void {
  const dialect = dialectOf(connectionId);
  const defaultSchema = useCatalog.getState().dbs[dbKey(connectionId, catalogDatabase(connectionId, database))]?.defaultSchema ?? null;
  const sql = selectTopSql(ref, dialect, n, defaultSchema);
  const id = useTabs.getState().newConsole({ connectionId, database, text: sql, title: ref.name });
  void preloadCatalog(connectionId, database);
  void runInTab(id, 'statement', [{ sql: sql.replace(/;\s*$/, ''), line: 1, col: 1 }]);
}

export function openObject(connectionId: string, database: string | null, ref: ObjectRef, column?: string | null): void {
  useTabs.getState().openObject(connectionId, database, ref, column);
}

/** Types "Open procedures and functions in edit mode" opens in an F4 "Edit:" console (the designer's script edit path). */
const EDIT_ON_OPEN = new Set<string>(['proc', 'func', 'tablefunc', 'package', 'trigger']);

/**
 * The default "open" of an object (explorer double-click / Enter, Ctrl+P Enter). With "Open procedures and functions
 * in edit mode" on, routines (and packages and triggers, which take the same script edit path) open in their "Edit:"
 * console, and an already open one comes to the front; everything else, and every object with the setting off, opens
 * the read-only object tab. Explicit commands (Edit / F4, Open DDL) do not come through here.
 */
export function activateObject(connectionId: string, database: string | null, ref: ObjectRef, column?: string | null): void {
  if (!column && EDIT_ON_OPEN.has(ref.type) && openRoutinesInEditMode()) {
    const open = useTabs.getState().tabs.find((t) => {
      const e = t.kind === 'console' ? peekEditSession(t.id) : undefined;
      return !!e && e.connectionId === connectionId && e.ref.type === ref.type && e.ref.name === ref.name && (e.ref.schema ?? null) === (ref.schema ?? null);
    });
    if (open) {
      useTabs.getState().activate(open.id);
      return;
    }
    if (runCommand('designer.edit', { kind: 'object', connectionId, database, ref })) return;
  }
  openObject(connectionId, database, ref, column);
}

export function reopenSql(sql: string, connectionId: string | null, database: string | null): void {
  newConsole(connectionId, database, sql);
}

export function insertIntoActiveEditor(text: string): void {
  const ed = getEditor(useTabs.getState().activeId);
  if (ed) {
    ed.insertText(text);
    ed.focus();
  }
}

// ---------------- results: copy & export ----------------

export function visibleRows(exec: ExecutionState, rs: ResultSetState) {
  const view = useResults.getState().views[viewKey(exec.localId, rs.id)];
  const idx = view ? computeView(rs.rows, rs.columns, view) : null;
  if (!idx) return rs.rows.toArray();
  return Array.from(idx, (i) => rs.rows.get(i)!);
}

export async function copyText(text: string, what = 'Copied to clipboard'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', what);
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('success', what);
  }
}

const EXT: Record<ExportFormat, string> = { csv: 'csv', json: 'json', 'sql-insert': 'sql' };
const MIME: Record<ExportFormat, string> = { csv: 'text/csv', json: 'application/json', 'sql-insert': 'application/sql' };

/** Export a result set: engine-side via ResultStore when possible, else from the rows the UI already has. */
export async function exportResultSet(exec: ExecutionState, rs: ResultSetState, format: ExportFormat): Promise<void> {
  const platform = getPlatform();
  const base = (rs.columns.find((c) => c.table)?.table ?? `result_${rs.id + 1}`).replace(/[^\w.-]+/g, '_');
  const name = `${base}.${EXT[format]}`;
  const filters = [{ name: format.toUpperCase(), extensions: [EXT[format]] }];
  const nullAs = format === 'csv' ? '' : undefined;
  const view = useResults.getState().views[viewKey(exec.localId, rs.id)];
  const hasView = !!view && (view.quickFilter || view.filter || view.sort.length);
  try {
    if (exec.executionId && !hasView) {
      if (platform.hasFileSystem) {
        const path = await platform.showSaveDialog({ title: 'Export result set', defaultPath: name, filters });
        if (!path) return;
        const r = await api.exportResultSet(exec.executionId, rs.id, { format, path, options: { header: true, nullAs } });
        toast('success', `Exported ${pluralize('rows' in r ? r.rows : rs.rowCount, 'row')}`, 'path' in r ? r.path : undefined);
        return;
      }
      const r = await api.exportResultSet(exec.executionId, rs.id, { format, path: null, options: { header: true, nullAs } });
      if ('blob' in r) {
        await platform.saveFile({ suggestedName: r.filename ?? name, content: r.blob, mime: MIME[format] });
        toast('success', `Exported ${r.filename ?? name}`);
        return;
      }
    }
  } catch (e) {
    console.warn('[export] engine export failed, falling back to client-side export', e);
  }
  const fmt: CopyFormat = format === 'sql-insert' ? 'sql-insert' : format;
  const content = serializeRows(fmt, rs.columns, visibleRows(exec, rs), { dialect: dialectOf(exec.connectionId), header: true });
  const saved = await platform.saveFile({ suggestedName: name, content, mime: MIME[format], filters });
  if (saved) toast('success', `Exported ${saved}`);
}

// ---------------- files ----------------

export async function openSqlFile(): Promise<void> {
  const f = await getPlatform().openTextFile({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] });
  if (!f) return;
  const id = newConsole(undefined, undefined, f.content);
  useTabs.getState().markSaved(id, f.path, f.name);
}

export const OBJECT_NOUN: Record<string, string> = {
  proc: 'procedure', func: 'function', tablefunc: 'function', view: 'view', mview: 'materialized view',
  trigger: 'trigger', package: 'package', type: 'type', table: 'table',
};

/**
 * Ctrl+S in an F4 "Edit:" console: save the object's changes to the database, like SSMS / Navicat / DataGrip (the
 * console holds CREATE OR ALTER / CREATE OR REPLACE / DROP+CREATE for the object). SQLite views and triggers take the
 * atomic apply (runEditTab); everything else runs the whole script on the tab's session. Saving the text to a .sql
 * file stays on Save as (Ctrl+Shift+S).
 */
export async function saveEditToDatabase(tabId: string): Promise<void> {
  const edit = editSessionOf(tabId);
  const tab = consoleTab(tabId);
  if (!edit || !tab) return;
  const noun = OBJECT_NOUN[edit.ref.type] ?? edit.ref.type;
  if (tab.connectionId !== edit.connectionId) {
    toast('warning', `This console no longer points at ${edit.ref.name}'s connection`, 'Switch the connection back to save, or use Save as… to write a .sql file.');
    return;
  }
  if (await runEditTab(tabId)) return; // SQLite view/trigger: atomic apply with its own toasts
  // The whole CREATE / ALTER, never just the selection: a selected statement must not be "saved" on its own.
  const target = getEditor(tabId)?.getRunTarget('script', { ignoreSelection: true });
  if (!target) {
    toast('info', 'Nothing to save');
    return;
  }
  const before = useResults.getState().byTab[tabId];
  // The text being saved: the "unsaved changes" dot of the toolbar's Save button compares with it.
  const savedText = getEditor(tabId)?.getValue() ?? tab.text;
  await runInTab(tabId, 'script', target.batches);
  const id = useResults.getState().byTab[tabId];
  if (!id || id === before) return; // did not start (cancelled confirm, no connection…): runInTab already said why
  const settle = (e: ExecutionState | undefined): boolean => {
    if (!e || isRunning(e)) return false;
    if (e.status === 'ok') {
      toast('success', `Saved ${noun} ${edit.ref.name}`, 'The changes were applied to the database.');
      // Only the object's schema, revalidated in place: the explorer keeps its rows (no full refresh, no flash).
      void useCatalog.getState().revalidate(edit.connectionId, catalogDatabase(edit.connectionId, edit.ref.database ?? edit.database), [edit.ref.schema]);
      // New "Compare with server" baseline.
      void api.ddl(edit.connectionId, edit.database, edit.ref)
        .then((d) => { if (peekEditSession(tabId)) rememberEdit(tabId, { ...edit, serverDdl: d.ddl, savedText }); })
        .catch(() => { if (peekEditSession(tabId)) rememberEdit(tabId, { ...edit, savedText }); });
    } else if (e.status === 'error') {
      toast('error', `${edit.ref.name} was not saved`, 'The database reported an error; see Messages for the line.');
    }
    return true;
  };
  if (settle(useResults.getState().executions[id])) return;
  const unsub = useResults.subscribe((s) => { if (settle(s.executions[id])) unsub(); });
}

export async function saveActiveFile(saveAs = false): Promise<void> {
  const tab = consoleTab(useTabs.getState().activeId ?? '');
  if (!tab) return;
  const p = getPlatform();
  if (p.hasFileSystem) {
    let path = saveAs ? null : tab.filePath;
    if (!path) path = await p.showSaveDialog({ title: 'Save SQL file', defaultPath: `${tab.title}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (!path) return;
    await p.writeTextFile(path, tab.text);
    useTabs.getState().markSaved(tab.id, path, path.split(/[\\/]/).pop());
  } else {
    await p.saveFile({ suggestedName: tab.title.endsWith('.sql') ? tab.title : `${tab.title}.sql`, content: tab.text, mime: 'application/sql' });
    useTabs.getState().markSaved(tab.id, null);
  }
}

export function refreshHistorySoon(): void {
  useHistory.getState().reloadSoon();
}

// ---------------- M1.5: connections, onboarding ----------------

/** Idle consoles (no running query, no open transaction) holding a session on the connection. */
export function idleSessionTabs(connectionId: string): string[] {
  const { sessions, byTab } = useSessions.getState();
  const active = useTabs.getState().activeId;
  return Object.entries(byTab)
    .filter(([tabId, sid]) => {
      const s = sessions[sid];
      if (!s || s.connectionId !== connectionId || s.txOpen || s.state === 'executing' || tabId === active) return false;
      return !isRunning(useResults.getState().executions[useResults.getState().byTab[tabId]]);
    })
    .map(([tabId]) => tabId);
}

/** Sessions on the connection no open tab owns and that are safe to close (no transaction, not running). */
export function releasableOrphans(connectionId: string): string[] {
  return useSessions.getState().orphans(connectionId).filter((s) => !s.txOpen && s.state !== 'executing').map((s) => s.sessionId);
}

/**
 * SESSION_LIMIT: offer to release the sessions of idle consoles and unused (orphaned) sessions on that connection,
 * then run again (`rerun`).
 */
export function offerCloseIdle(connectionId: string, rerun?: () => void): void {
  const idle = idleSessionTabs(connectionId);
  const orphans = releasableOrphans(connectionId);
  const n = idle.length + orphans.length;
  const limit = useSettings.getState().settings.connections.maxSessionsPerProfile;
  const held = [idle.length ? pluralize(idle.length, 'idle console') : '', orphans.length ? pluralize(orphans.length, 'unused session') : '']
    .filter(Boolean).join(' and ');
  const conn = getConnection(connectionId)?.name ?? 'this connection';
  toast('warning', `Session limit reached (${limit} per connection)`,
    n ? `${held} on “${conn}” hold a session.` : `Close a console on “${conn}” first.`,
    n
      ? {
          label: rerun ? `Release ${pluralize(n, 'unused session')} and run again` : `Release ${pluralize(n, 'unused session')}`,
          run: () => {
            void Promise.all([
              ...idle.map((t) => useSessions.getState().close(t, true).catch(() => undefined)),
              ...orphans.map((sid) => useSessions.getState().closeSession(sid, false).catch(() => undefined)),
            ]).then(() => {
              if (rerun) rerun();
              else toast('success', `Released ${pluralize(n, 'session')}`, 'Run the statement again.');
            });
          },
        }
      : undefined);
}

/** Short windows: after the first run of a console, give the results 60 % of the height (unless the user chose). */
function noteFirstRun(tabId: string): void {
  if (typeof window === 'undefined' || effectiveViewportHeight() >= SHORT_WINDOW) return;
  const ui = useUi.getState();
  if (ui.tabSplits[tabId] === undefined) ui.setTabSplit(tabId, 0.6);
}

/**
 * Sessions this window may close: everything except those another live window uses (isForeignSession). Disconnect
 * and Disconnect all only ever close these (useSessions.closeConnection), so they alone count for the
 * open-transaction prompt, the enablement of the commands and the toast.
 */
export function ownSessions(connectionId?: string): SessionInfo[] {
  return Object.values(useSessions.getState().sessions).filter(
    (s) => !isForeignSession(s) && (!connectionId || s.connectionId === connectionId),
  );
}

/** "1 console has an uncommitted transaction" / "2 sessions have uncommitted transactions" (consoles when all are). */
function uncommittedText(withTx: SessionInfo[]): string {
  const owned = new Set(Object.values(useSessions.getState().byTab));
  const n = withTx.length;
  const noun = withTx.every((s) => owned.has(s.sessionId)) ? 'console' : 'session';
  return n === 1 ? `1 ${noun} has an uncommitted transaction` : `${pluralize(n, noun)} have uncommitted transactions`;
}

/** Explorer "Disconnect": closes this window's sessions of the connection and drops its cached catalog. */
export async function disconnectConnection(connectionId: string): Promise<void> {
  const conn = getConnection(connectionId);
  if (conn && providerKind(conn.providerId) !== 'relational') {
    // M2: close the engine's source client (its streams end) and let the module drop cached data.
    try {
      await useSourceClients.getState().close(connectionId);
    } catch (e) {
      toast('error', `Could not disconnect ${conn.name}`, errorMessage(e));
      return;
    }
    getSourceModule(conn.providerId)?.onDisconnect?.(connectionId);
    toast('info', `Disconnected ${conn.name}`);
    return;
  }
  const withTx = ownSessions(connectionId).filter((s) => s.txOpen);
  if (withTx.length) {
    const ok = await useUi.getState().askConfirm({
      title: 'Open transactions',
      message: `${uncommittedText(withTx)} on “${conn?.name ?? 'this connection'}”. Disconnecting rolls ${withTx.length === 1 ? 'it' : 'them'} back.`,
      confirmLabel: 'Roll back and disconnect',
      danger: true,
    });
    if (!ok) return;
  }
  const n = await useSessions.getState().closeConnection(connectionId, true);
  useCatalog.getState().forget(connectionId);
  toast('info', `Disconnected ${conn?.name ?? ''}`.trim(), n ? `${pluralize(n, 'session')} closed` : undefined);
}

/** Connections ▸ Disconnect all: this window's sessions and cached catalogs (another window's sessions stay open). */
export async function disconnectAll(): Promise<void> {
  const mine = ownSessions();
  const ids = [...new Set(mine.map((s) => s.connectionId))];
  const cached = Object.keys(useCatalog.getState().conns);
  const all = [...new Set([...ids, ...cached, ...Object.keys(useSourceClients.getState().clients)])];
  if (!all.length) return;
  const withTx = mine.filter((s) => s.txOpen);
  if (withTx.length) {
    const ok = await useUi.getState().askConfirm({
      title: 'Disconnect all',
      message: `${uncommittedText(withTx)}. Disconnecting rolls ${withTx.length === 1 ? 'it' : 'them'} back.`,
      confirmLabel: 'Roll back and disconnect',
      danger: true,
    });
    if (!ok) return;
  }
  const closed = await Promise.all(ids.map((cid) => useSessions.getState().closeConnection(cid, true)));
  for (const cid of all) useCatalog.getState().forget(cid);
  // M2: source clients too.
  await Promise.all(Object.keys(useSourceClients.getState().clients).map((cid) => useSourceClients.getState().close(cid).catch(() => undefined)));
  const nSessions = closed.reduce((a, b) => a + b, 0);
  toast('info', `Disconnected ${pluralize(all.length, 'connection')}`, nSessions ? `${pluralize(nSessions, 'session')} closed` : undefined);
}

/** Explorer folder "Connect all": loads every connection of the folder in parallel (per-root spinners). */
export function connectAllInFolder(folder: string): string[] {
  const list = useConnections.getState().connections.filter((c) => (c.folder ?? '') === folder);
  for (const c of list) void preloadCatalog(c.id, null);
  return list.map((c) => c.id);
}

/** Onboarding: "Try the sample database" (POST /sample-db) → console with a runnable query. */
export async function openSampleDatabase(): Promise<void> {
  try {
    const r = await api.createSampleDb({});
    await useConnections.getState().load();
    const cid = r.connectionId ?? r.profile?.id;
    if (!cid) throw new Error('The engine did not return the sample connection');
    const sql = [
      'SELECT c.FirstName, c.LastName, c.City, COUNT(o.Id) AS Orders, SUM(o.Total) AS Revenue',
      'FROM Customers c',
      'LEFT JOIN Orders o ON o.CustomerId = c.Id',
      'GROUP BY c.Id, c.FirstName, c.LastName, c.City',
      'ORDER BY Revenue DESC;',
      '',
      `-- Sample "Shop" database: Customers, Orders, OrderLines, Products, Countries.`,
      `-- ${displayShortcut('Mod+Enter')} runs the statement under the cursor, ${displayShortcut('Mod+P')} jumps to a table.`,
      '',
    ].join('\n');
    const id = useTabs.getState().newConsole({ connectionId: cid, database: null, text: sql, title: 'Sample: Shop' });
    void preloadCatalog(cid, null);
    useUi.getState().showDock('explorer');
    setTimeout(() => getEditor(id)?.focus(), 80);
    toast('success', r.created === false ? 'Opened the sample database' : 'Created the sample database', r.path);
  } catch (e) {
    toast('error', 'Could not create the sample database', errorMessage(e));
  }
}

/** Onboarding: "Open a SQLite file" — native picker in Electron, connection dialog with SQLite preselected in the browser. */
export async function openSqliteFile(): Promise<void> {
  const p = getPlatform();
  if (!p.hasFileSystem) {
    useUi.getState().openConnectionDialog({ mode: 'new', providerId: 'sqlite', connectAfter: true });
    return;
  }
  const path = await p.showOpenDialog({
    title: 'Open a SQLite database',
    filters: [{ name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (!path) return;
  const existing = useConnections.getState().connections.find((c) => c.providerId === 'sqlite' && c.props.path === path);
  try {
    const conn = existing ?? (await useConnections.getState().save({
      name: path.split(/[\\/]/).pop()!.replace(/\.(db|sqlite3?|db3)$/i, '') || 'SQLite',
      providerId: 'sqlite', color: null, folder: null, readOnly: false, props: { path }, savePassword: false, password: null,
    }));
    newConsole(conn.id, null);
    useUi.getState().showDock('explorer');
  } catch (e) {
    toast('error', 'Could not open the SQLite file', errorMessage(e));
  }
}

/**
 * Open a console on a connection (welcome screen, explorer, connection dialog "Connect"). M2: Redis/MongoDB/Kafka
 * open their module's default workspace instead (Redis browser, Mongo documents, Kafka overview) and return ''.
 */
export function connectAndOpen(connectionId: string): string {
  const conn = getConnection(connectionId);
  if (conn && providerKind(conn.providerId) !== 'relational') {
    const mod = getSourceModule(conn.providerId);
    if (mod) mod.defaultWorkspace(connectionId);
    else toast('info', `${conn.name}: support for this source is not available in this build`);
    useUi.getState().showDock('explorer');
    return '';
  }
  const id = newConsole(connectionId, null);
  useUi.getState().showDock('explorer');
  return id;
}

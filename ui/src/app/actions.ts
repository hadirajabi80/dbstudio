// App-level commands that coordinate several stores (run, transactions, tabs, export).
import { api, errorMessage, isApiError } from '../api/client';
import type { ExportFormat, ObjectRef, RunLabel, SqlBatch, TxMode } from '../api/types';
import { findDestructive } from '../lib/classify';
import { serializeRows, type CopyFormat } from '../lib/serialize';
import { computeView } from '../lib/filter';
import { selectTopSql } from '../lib/sql';
import { getPlatform } from '../platform';
import { dbKey, useCatalog } from '../store/catalog';
import { dialectOf, getConnection, useConnections } from '../store/connections';
import { useHistory } from '../store/history';
import { useResults, viewKey } from '../store/results';
import { createExecution, isRunning, type ExecutionState, type ResultSetState } from '../store/resultsReducer';
import { useSessions } from '../store/sessions';
import { useSettings } from '../store/settings';
import { useTabs, type ConsoleTab } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import { getEditor } from './editors';

let localSeq = 0;

function consoleTab(tabId: string): ConsoleTab | undefined {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return t?.kind === 'console' ? t : undefined;
}

/** Database the tab effectively uses: its own choice, else the connection's current database. */
export function effectiveDatabase(connectionId: string | null, database: string | null): string | null {
  if (!connectionId) return null;
  if (database) return database;
  const c = getConnection(connectionId);
  if (c?.providerId === 'oracle') return null;
  return useCatalog.getState().conns[connectionId]?.databases?.current ?? null;
}

/**
 * Catalog cache key for a tab's database. Oracle has no database level (the tab's "database" is the
 * session's current schema), so its catalog is always keyed by null.
 */
export function catalogDatabase(connectionId: string | null, database: string | null): string | null {
  if (!connectionId) return null;
  if (getConnection(connectionId)?.providerId === 'oracle') return null;
  return effectiveDatabase(connectionId, database);
}

export function effectiveMaxRows(tab: ConsoleTab): number {
  return tab.maxRows ?? useSettings.getState().settings.results.maxRows;
}

export interface RunOptions {
  maxRows?: number;
  confirmedDestructive?: boolean;
}

export async function runInTab(tabId: string, label: RunLabel, batches: SqlBatch[], opts: RunOptions = {}): Promise<void> {
  const tab = consoleTab(tabId);
  if (!tab) return;
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

  const maxRows = opts.maxRows ?? effectiveMaxRows(tab);
  const localId = `l${++localSeq}`;
  useResults.getState().begin(createExecution({
    localId, tabId, connectionId: conn.id, sessionId: useSessions.getState().byTab[tabId] ?? null, label, batches, maxRows,
    confirmedDestructive: confirmed,
  }));
  if (!useUi.getState().resultsVisible) useUi.getState().toggle('resultsVisible');

  try {
    const session = await useSessions.getState().ensure(tabId, conn.id, effectiveDatabase(conn.id, tab.database), tab.txMode);
    useConnections.getState().touch(conn.id);
    const res = await api.execute(session.sessionId, {
      batches, maxRows, stopOnError: true, label, source: { tabId, title: tab.title },
      ...(confirmed ? { confirmedDestructive: true } : {}),
    });
    useResults.getState().attach(localId, res.executionId);
  } catch (e) {
    if (isApiError(e, 'READ_ONLY') && !confirmed) {
      useResults.getState().fail(localId, errorMessage(e), 'READ_ONLY');
      const ok = await useUi.getState().askConfirm({
        title: 'Read-only connection',
        message: `“${conn.name}” is marked read-only and the engine refused a statement that changes data.`,
        items: [errorMessage(e)],
        confirmLabel: 'Run anyway',
        danger: true,
      });
      if (ok) await runInTab(tabId, label, batches, { ...opts, confirmedDestructive: true });
      return;
    }
    const hint = isApiError(e, 'SESSION_BUSY') ? 'The session is busy with another statement.' : undefined;
    useResults.getState().fail(localId, hint ? `${errorMessage(e)} ${hint}` : errorMessage(e), isApiError(e) ? e.code : null);
  }
}

/** Run from toolbar / palette / global shortcut: ask the editor what to run. */
export function runActive(label: RunLabel): void {
  const tabId = useTabs.getState().activeId;
  if (!tabId || !consoleTab(tabId)) return;
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
  await runInTab(tabId, e.label, e.batches, { confirmedDestructive: e.confirmedDestructive, ...opts });
}

export async function cancelTab(tabId: string | null = useTabs.getState().activeId): Promise<void> {
  if (!tabId) return;
  const s = useSessions.getState().forTab(tabId);
  const e = useResults.getState().executions[useResults.getState().byTab[tabId]];
  if (!s || !isRunning(e)) return;
  try {
    await api.cancel(s.sessionId);
  } catch (err) {
    toast('error', 'Cancel failed', errorMessage(err));
  }
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
  }
  useTabs.getState().close(tabId);
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
        toast('success', `Exported ${'rows' in r ? r.rows : rs.rowCount} rows`, 'path' in r ? r.path : undefined);
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

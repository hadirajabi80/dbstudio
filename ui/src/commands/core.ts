// Shell commands owned by WP-J (file, tabs, view, query, connections, explorer, history, help).
// Other packages register theirs from their own commands.ts (auto-loaded by ./index.ts).
import { api } from '../api/client';
import type { HistoryEntry, SessionInfo } from '../api/types';
import {
  cancelTab, catalogDatabase, closeTab, commitTab, connectAllInFolder, copyText, disconnectAll, disconnectConnection,
  insertIntoActiveEditor, newConsole, openObject, openSampleDatabase, openSqlFile, openSqliteFile, reopenSql, rerun, rollbackTab,
  runActive, saveActiveFile, selectTop, setTxMode,
} from '../app/actions';
import { getEditor } from '../app/editors';
import { useExplorer } from '../components/Explorer/explorerStore';
import { isTabular, qualifiedName } from '../lib/sql';
import { getPlatform } from '../platform';
import { dbKey, useCatalog } from '../store/catalog';
import { dialectOf, getConnection, useConnections } from '../store/connections';
import { useHistory } from '../store/history';
import { useResults } from '../store/results';
import { isRunning } from '../store/resultsReducer';
import { useSessions } from '../store/sessions';
import { useSettings } from '../store/settings';
import { getActiveConsole, useTabs } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import { currentTheme } from '../theme/useTheme';
import { aliasCommand, registerCommand, runCommand, type Command } from './registry';
import {
  isConnectionTarget, isContainerTarget, isObjectTarget, isTabTarget, type CommandTarget, type ObjectTarget,
} from './types';

// ---------- helpers ----------

/** Target for explorer commands: the context-menu args, else the explorer selection. */
export function targetOf(args: unknown): CommandTarget | null {
  if (args && typeof args === 'object' && 'kind' in args) return args as CommandTarget;
  return useExplorer.getState().selectedTarget;
}

export function objectTargetOf(args: unknown): ObjectTarget | null {
  const t = targetOf(args);
  return isObjectTarget(t) ? t : null;
}

function connectionIdOf(args: unknown): string | null {
  const t = targetOf(args);
  if (t && 'connectionId' in t) return t.connectionId;
  return null;
}

const consoleWithConnection = () => {
  const t = getActiveConsole();
  return t?.connectionId ? t : undefined;
};

const runningInActive = () => {
  const t = getActiveConsole();
  if (!t) return false;
  const r = useResults.getState();
  return isRunning(r.executions[r.byTab[t.id]]);
};

function tabIdOf(args: unknown): string | null {
  return isTabTarget(args) ? args.tabId : useTabs.getState().activeId;
}

let zoom = 1;
function setZoom(z: number) {
  zoom = Math.max(0.6, Math.min(2, Math.round(z * 10) / 10));
  (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
}

function anchorOf(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width ? { left: r.left, top: r.top, bottom: r.bottom } : null;
}

function isEntry(a: unknown): boolean {
  return !!a && typeof a === 'object' && typeof (a as HistoryEntry).sql === 'string' && typeof (a as HistoryEntry).id === 'number';
}

function sessionOf(a: unknown): SessionInfo | undefined {
  const sid = a && typeof a === 'object' ? (a as { sessionId?: unknown }).sessionId : undefined;
  return typeof sid === 'string' ? useSessions.getState().sessions[sid] : undefined;
}

// ---------- the list ----------

export const CORE_COMMANDS: Command<never>[] = [
  // File
  { id: 'file.newConsole', title: 'New query console', category: 'File', shortcut: 'Mod+N', altShortcuts: ['Mod+T'], icon: 'SquareTerminal', run: () => void newConsole() },
  { id: 'file.newConnection', title: 'New connection…', category: 'File', shortcut: 'Mod+Shift+N', icon: 'Plus', run: () => useUi.getState().openConnectionDialog({ mode: 'new', connectAfter: true }) },
  { id: 'file.open', title: 'Open SQL file…', category: 'File', shortcut: 'Mod+O', icon: 'FolderOpen', run: () => void openSqlFile() },
  { id: 'file.openSqlite', title: 'Open a SQLite database file…', category: 'File', icon: 'File', run: () => void openSqliteFile() },
  { id: 'file.sampleDb', title: 'Open the sample database', category: 'File', keywords: 'try demo shop', icon: 'Sparkles', run: () => void openSampleDatabase() },
  { id: 'file.save', title: 'Save', category: 'File', shortcut: 'Mod+S', when: () => !!getActiveConsole(), run: () => void saveActiveFile(false) },
  { id: 'file.saveAs', title: 'Save as…', category: 'File', shortcut: 'Mod+Shift+S', when: () => !!getActiveConsole(), run: () => void saveActiveFile(true) },

  // Tabs
  {
    id: 'tab.close', title: 'Close tab', category: 'Tabs', shortcut: 'Mod+W', when: (a?: unknown) => !!tabIdOf(a),
    run: (a?: unknown) => { const id = tabIdOf(a); if (id) void closeTab(id); },
  },
  {
    id: 'tab.closeOthers', title: 'Close other tabs', category: 'Tabs', when: (a?: unknown) => !!tabIdOf(a) && useTabs.getState().tabs.length > 1,
    run: (a?: unknown) => {
      const id = tabIdOf(a);
      if (id) for (const t of useTabs.getState().tabs.filter((x) => x.id !== id)) void closeTab(t.id);
    },
  },
  {
    id: 'tab.rename', title: 'Rename tab', category: 'Tabs', when: (a?: unknown) => useTabs.getState().tabs.find((t) => t.id === tabIdOf(a))?.kind === 'console',
    run: (a?: unknown) => useUi.getState().setRenamingTab(tabIdOf(a)),
  },
  { id: 'tab.reopenClosed', title: 'Reopen closed tab', category: 'Tabs', shortcut: 'Mod+Shift+T', when: () => useTabs.getState().closed.length > 0, run: () => void useTabs.getState().reopenClosed() },
  {
    id: 'tab.duplicate', title: 'Duplicate console', category: 'Tabs',
    when: (a?: unknown) => useTabs.getState().tabs.find((t) => t.id === tabIdOf(a))?.kind === 'console',
    run: (a?: unknown) => {
      const t = useTabs.getState().tabs.find((x) => x.id === tabIdOf(a));
      if (t?.kind === 'console') newConsole(t.connectionId, t.database, t.text);
    },
  },
  { id: 'tab.mruNext', title: 'Switch to previously used tab', category: 'Tabs', shortcut: 'MacCtrl+Tab', when: () => useTabs.getState().tabs.length > 1, run: () => useTabs.getState().activateMru(1) },
  { id: 'tab.mruPrev', title: 'Switch tabs (reverse order of use)', category: 'Tabs', shortcut: 'MacCtrl+Shift+Tab', when: () => useTabs.getState().tabs.length > 1, run: () => useTabs.getState().activateMru(-1) },
  { id: 'tab.next', title: 'Next tab', category: 'Tabs', shortcut: 'Mod+PageDown', altShortcuts: ['Mod+Alt+ArrowRight'], run: () => useTabs.getState().activateRelative(1) },
  { id: 'tab.prev', title: 'Previous tab', category: 'Tabs', shortcut: 'Mod+PageUp', altShortcuts: ['Mod+Alt+ArrowLeft'], run: () => useTabs.getState().activateRelative(-1) },
  ...Array.from({ length: 9 }, (_, i): Command<never> => ({
    id: `tab.goto${i + 1}`, title: i === 8 ? 'Go to last tab' : `Go to tab ${i + 1}`, category: 'Tabs', shortcut: `Mod+${i + 1}`, palette: false,
    run: () => useTabs.getState().activateIndex(i),
  })),

  // View
  { id: 'view.commandPalette', title: 'Command palette…', category: 'View', shortcut: 'Mod+Shift+P', icon: 'Command', run: () => useUi.getState().openPalette('commands') },
  { id: 'view.goToObject', title: 'Go to database object…', category: 'View', shortcut: 'Mod+P', keywords: 'quick open search table', icon: 'Search', run: () => useUi.getState().openPalette('objects') },
  { id: 'view.shortcuts', title: 'Keyboard shortcuts', category: 'Help', shortcut: 'F1', altShortcuts: ['Mod+K Mod+S'], keywords: 'keys keybindings help', icon: 'Keyboard', run: () => useUi.getState().setShortcutsOpen(true) },
  { id: 'view.toggleSidebar', title: 'Toggle side panel', category: 'View', shortcut: 'Mod+B', icon: 'PanelLeft', run: () => useUi.getState().toggle('explorerVisible') },
  { id: 'view.explorer', title: 'Show database explorer', category: 'View', shortcut: 'Mod+Shift+E', icon: 'Database', run: () => { useUi.getState().showDock('explorer'); useExplorer.getState().focusTree(); } },
  { id: 'view.history', title: 'Show query history', category: 'View', shortcut: 'Mod+Shift+H', icon: 'History', run: () => useUi.getState().showDock('history', true) },
  { id: 'connections.showActive', title: 'Show active connections', category: 'Connections', keywords: 'sessions', icon: 'Activity', run: () => useUi.getState().showDock('connections') },
  { id: 'view.toggleResults', title: 'Toggle results pane', category: 'View', shortcut: 'Mod+R', run: () => useUi.getState().toggle('resultsVisible') },
  { id: 'view.maximizeResults', title: 'Maximize / restore results pane', category: 'View', shortcut: 'Mod+Shift+R', run: () => useUi.getState().setResultsMaximized(!useUi.getState().resultsMaximized) },
  { id: 'view.focusEditor', title: 'Focus editor', category: 'View', when: () => !!getActiveConsole(), run: () => getEditor(useTabs.getState().activeId)?.focus() },
  { id: 'view.zoomIn', title: 'Zoom in', category: 'View', shortcut: 'Mod+=', run: () => setZoom(zoom + 0.1) },
  { id: 'view.zoomOut', title: 'Zoom out', category: 'View', shortcut: 'Mod+-', run: () => setZoom(zoom - 0.1) },
  { id: 'view.zoomReset', title: 'Reset zoom', category: 'View', shortcut: 'Mod+0', run: () => setZoom(1) },
  { id: 'view.settings', title: 'Settings…', category: 'Preferences', shortcut: 'Mod+,', icon: 'Settings', keywords: 'preferences options', run: () => useUi.getState().setSettingsOpen(true) },
  { id: 'view.toggleTheme', title: 'Toggle light / dark theme', category: 'Preferences', run: () => useSettings.getState().update({ theme: currentTheme() === 'dark' ? 'light' : 'dark' }) },
  { id: 'view.themeLight', title: 'Theme: Light', category: 'Preferences', run: () => useSettings.getState().update({ theme: 'light' }) },
  { id: 'view.themeDark', title: 'Theme: Dark', category: 'Preferences', run: () => useSettings.getState().update({ theme: 'dark' }) },
  { id: 'view.themeSystem', title: 'Theme: Follow system', category: 'Preferences', run: () => useSettings.getState().update({ theme: 'system' }) },
  {
    id: 'view.toggleDensity', title: 'Toggle compact density', category: 'Preferences', keywords: 'row height grid',
    run: () => useSettings.getState().update({ grid: { density: useSettings.getState().settings.grid.density === 'compact' ? 'comfortable' : 'compact' } }),
  },
  {
    id: 'prefs.toggleConfirmDestructive', title: 'Toggle confirmation of destructive statements', category: 'Preferences',
    run: () => {
      const v = !useSettings.getState().settings.confirmDestructive;
      useSettings.getState().update({ confirmDestructive: v });
      toast('info', v ? 'Destructive statements will ask for confirmation' : 'Destructive-statement confirmation is off');
    },
  },

  // Query
  { id: 'run.statement', title: 'Run statement at cursor / selection', category: 'Query', shortcut: 'Mod+Enter', icon: 'Play', when: () => !!consoleWithConnection() && !runningInActive(), run: () => runActive('statement') },
  { id: 'run.script', title: 'Run script', category: 'Query', shortcut: 'F5', altShortcuts: ['Mod+Shift+Enter'], icon: 'ListEnd', when: () => !!consoleWithConnection() && !runningInActive(), run: () => runActive('script') },
  { id: 'run.cancel', title: 'Cancel running query', category: 'Query', shortcut: 'Shift+F5', icon: 'CircleStop', when: () => runningInActive(), run: () => void cancelTab() },
  { id: 'run.multi', title: 'Run on multiple connections…', category: 'Query', shortcut: 'Mod+Alt+Enter', icon: 'Layers', keywords: 'parity compare', when: () => !!getActiveConsole(), run: () => useUi.getState().openMultiRun(getActiveConsole()!.id) },
  {
    id: 'run.rerunNoLimit', title: 'Re-run last query without row limit', category: 'Query',
    when: () => { const t = getActiveConsole(); return !!t && !!useResults.getState().byTab[t.id]; },
    run: () => { const t = getActiveConsole(); if (t) void rerun(t.id, { maxRows: 0 }); },
  },
  {
    id: 'tx.commit', title: 'Commit transaction', category: 'Transaction', shortcut: 'Mod+Alt+C', icon: 'GitCommitHorizontal',
    when: () => { const t = getActiveConsole(); return !!t && !!useSessions.getState().forTab(t.id)?.txOpen; },
    run: () => void commitTab(),
  },
  {
    id: 'tx.rollback', title: 'Roll back transaction', category: 'Transaction', shortcut: 'Mod+Alt+Z', icon: 'RotateCcw',
    when: () => { const t = getActiveConsole(); return !!t && !!useSessions.getState().forTab(t.id)?.txOpen; },
    run: () => void rollbackTab(),
  },
  {
    id: 'tx.toggleMode', title: 'Toggle auto-commit / manual transaction', category: 'Transaction', when: () => !!consoleWithConnection(),
    run: () => {
      const t = getActiveConsole()!;
      const mode = useSessions.getState().forTab(t.id)?.txMode ?? t.txMode;
      void setTxMode(t.id, mode === 'auto' ? 'manual' : 'auto');
    },
  },

  // Connections
  {
    id: 'connections.change', title: 'Change connection…', category: 'Connections', shortcut: 'Mod+Shift+K', icon: 'Plug',
    when: () => !!getActiveConsole(),
    run: () => useUi.getState().openSwitcher({ tabId: getActiveConsole()!.id, mode: 'connection', anchor: anchorOf('.console:not([style*="none"]) .conn-pill') }),
  },
  {
    id: 'connections.changeDatabase', title: 'Change database…', category: 'Connections', shortcut: 'Mod+Shift+D', icon: 'Database',
    when: () => { const t = consoleWithConnection(); return !!t && getConnection(t.connectionId)?.providerId !== 'sqlite'; },
    run: () => useUi.getState().openSwitcher({ tabId: getActiveConsole()!.id, mode: 'database', anchor: anchorOf('.console:not([style*="none"]) .db-pill') }),
  },
  {
    id: 'connections.openConsole', title: 'Open console', category: 'Connections', icon: 'SquareTerminal', when: (a?: unknown) => !!connectionIdOf(a),
    run: (a?: unknown) => {
      const t = targetOf(a);
      if (!t || !('connectionId' in t)) return;
      newConsole(t.connectionId, isObjectTarget(t) || isContainerTarget(t) ? t.database : null);
    },
  },
  {
    id: 'connections.edit', title: 'Edit connection…', category: 'Connections', icon: 'Pencil', when: (a?: unknown) => !!connectionIdOf(a),
    run: (a?: unknown) => useUi.getState().openConnectionDialog({ mode: 'edit', id: connectionIdOf(a)! }),
  },
  {
    id: 'connections.duplicate', title: 'Duplicate connection…', category: 'Connections', icon: 'Copy', when: (a?: unknown) => !!connectionIdOf(a),
    run: (a?: unknown) => useUi.getState().openConnectionDialog({ mode: 'duplicate', id: connectionIdOf(a)! }),
  },
  {
    id: 'connections.disconnect', title: 'Disconnect', category: 'Connections', icon: 'Unplug',
    when: (a?: unknown) => {
      const cid = connectionIdOf(a);
      return !!cid && (!!useCatalog.getState().conns[cid] || Object.values(useSessions.getState().sessions).some((s) => s.connectionId === cid));
    },
    run: (a?: unknown) => void disconnectConnection(connectionIdOf(a)!),
  },
  {
    id: 'connections.disconnectAll', title: 'Disconnect all', category: 'Connections', icon: 'Unplug',
    when: () => Object.keys(useSessions.getState().sessions).length > 0 || Object.keys(useCatalog.getState().conns).length > 0,
    run: () => void disconnectAll(),
  },
  {
    id: 'connections.connectFolder', title: 'Connect all in folder', category: 'Connections', palette: false,
    when: (a?: unknown) => !!a && typeof a === 'object' && typeof (a as { folder?: unknown }).folder === 'string',
    run: (a?: unknown) => {
      const ids = connectAllInFolder((a as { folder: string }).folder);
      useExplorer.getState().expandAll(ids.map((id) => `c:${id}`));
    },
  },
  {
    id: 'connections.newInFolder', title: 'New connection in folder…', category: 'Connections', palette: false,
    run: (a?: unknown) => useUi.getState().openConnectionDialog({ mode: 'new', folder: (a as { folder?: string } | undefined)?.folder ?? null, connectAfter: true }),
  },
  {
    id: 'connections.delete', title: 'Delete connection…', category: 'Connections', icon: 'Trash2', when: (a?: unknown) => !!connectionIdOf(a),
    run: async (a?: unknown) => {
      const cid = connectionIdOf(a)!;
      const c = getConnection(cid);
      const ok = await useUi.getState().askConfirm({ title: 'Delete connection', message: `Delete “${c?.name ?? cid}”? Its saved password is removed too.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await useSessions.getState().closeConnection(cid, true);
        await useConnections.getState().remove(cid);
        useCatalog.getState().forget(cid);
      } catch (e) {
        toast('error', 'Delete failed', e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    id: 'connections.refreshCatalog', title: 'Refresh catalog', category: 'Database', icon: 'RefreshCw',
    when: (a?: unknown) => !!connectionIdOf(a) || !!consoleWithConnection(),
    run: async (a?: unknown) => {
      const t = targetOf(a);
      const cat = useCatalog.getState();
      if (t && 'connectionId' in t) {
        if (isObjectTarget(t) && t.ref.schema) await cat.loadSchema(t.connectionId, t.database, t.ref.schema, true);
        else if (isContainerTarget(t) && t.schema) await cat.loadSchema(t.connectionId, t.database, t.schema, true);
        else if (isContainerTarget(t)) await cat.refresh(t.connectionId, t.database);
        else await cat.refresh(t.connectionId);
      } else {
        const c = consoleWithConnection();
        if (c?.connectionId) await cat.refresh(c.connectionId, catalogDatabase(c.connectionId, c.database));
      }
      toast('info', 'Catalog refreshed');
    },
  },

  // Explorer object actions
  {
    id: 'explorer.selectTop', title: 'Select top 1000 rows', category: 'Database', icon: 'Rows3', keywords: 'preview data',
    when: (a?: unknown) => { const t = objectTargetOf(a); return !!t && isTabular(t.ref.type); },
    run: (a?: unknown) => { const t = objectTargetOf(a)!; selectTop(t.connectionId, t.database, t.ref, 1000); },
  },
  {
    id: 'explorer.openDdl', title: 'Open DDL / details', category: 'Database', icon: 'FileCode2', keywords: 'definition script',
    when: (a?: unknown) => !!objectTargetOf(a),
    run: (a?: unknown) => { const t = objectTargetOf(a)!; openObject(t.connectionId, t.database, t.ref); },
  },
  {
    id: 'explorer.copyName', title: 'Copy name', category: 'Database', icon: 'Copy', when: (a?: unknown) => !!targetOf(a),
    run: (a?: unknown) => {
      const t = targetOf(a);
      if (isObjectTarget(t)) {
        const def = useCatalog.getState().dbs[dbKey(t.connectionId, t.database)]?.defaultSchema ?? null;
        void copyText(qualifiedName(t.ref, dialectOf(t.connectionId), { defaultSchema: def }));
      } else if (isContainerTarget(t)) void copyText(t.schema ?? t.database ?? '');
      else if (isConnectionTarget(t)) void copyText(getConnection(t.connectionId)?.name ?? '');
    },
  },
  {
    id: 'explorer.copyQualifiedName', title: 'Copy qualified name', category: 'Database', when: (a?: unknown) => !!objectTargetOf(a),
    run: (a?: unknown) => { const t = objectTargetOf(a)!; void copyText(qualifiedName(t.ref, dialectOf(t.connectionId), { always: true })); },
  },
  { id: 'explorer.focusFilter', title: 'Filter explorer', category: 'Database', shortcut: 'Mod+F', scope: 'explorer', run: () => useExplorer.getState().focusFilter() },
  { id: 'explorer.refresh', title: 'Refresh selected node', category: 'Database', shortcut: 'F5', scope: 'explorer', palette: false, run: () => void runCommand('connections.refreshCatalog') },
  { id: 'explorer.collapseAll', title: 'Collapse all explorer nodes', category: 'Database', icon: 'ChevronsDownUp', run: () => useExplorer.getState().collapseAll() },

  // History
  { id: 'history.focusFilter', title: 'Search query history', category: 'History', shortcut: 'Mod+F', scope: 'history', run: () => useHistory.getState().requestFocus() },
  { id: 'history.reload', title: 'Reload query history', category: 'History', icon: 'RefreshCw', run: () => void useHistory.getState().load() },
  {
    id: 'history.clear', title: 'Clear query history…', category: 'History', icon: 'Trash',
    run: async () => {
      const ok = await useUi.getState().askConfirm({ title: 'Clear history', message: 'Delete all unpinned history entries?', confirmLabel: 'Clear', danger: true });
      if (ok) void useHistory.getState().clear();
    },
  },

  // History entries (context menu of a history item; args: HistoryEntry)
  { id: 'history.openEntry', title: 'Open in new console', category: 'History', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => { const h = a as HistoryEntry; reopenSql(h.sql, h.connectionId, h.database); } },
  { id: 'history.insertEntry', title: 'Insert into current editor', category: 'History', palette: false, when: (a?: unknown) => isEntry(a) && !!getActiveConsole(), run: (a?: unknown) => insertIntoActiveEditor((a as HistoryEntry).sql) },
  { id: 'history.copyEntry', title: 'Copy SQL', category: 'History', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => void copyText((a as HistoryEntry).sql) },
  { id: 'history.togglePin', title: 'Pin / unpin', category: 'History', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => void useHistory.getState().togglePin((a as HistoryEntry).id).catch(() => toast('error', 'Pin failed')) },
  { id: 'history.deleteEntry', title: 'Delete entry', category: 'History', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => void useHistory.getState().remove((a as HistoryEntry).id).catch(() => toast('error', 'Delete failed')) },

  // Sessions (active connections panel; args: { sessionId })
  {
    id: 'sessions.cancel', title: 'Cancel running query', category: 'Connections', palette: false,
    when: (a?: unknown) => { const s = sessionOf(a); return !!s && s.state === 'executing'; },
    run: async (a?: unknown) => { const s = sessionOf(a); if (s) await api.cancel(s.sessionId).catch((e) => toast('error', 'Cancel failed', String(e))); },
  },
  {
    id: 'sessions.disconnect', title: 'Close session', category: 'Connections', palette: false, when: (a?: unknown) => !!sessionOf(a),
    run: async (a?: unknown) => {
      const s = sessionOf(a)!;
      if (s.txOpen) {
        const ok = await useUi.getState().askConfirm({ title: 'Open transaction', message: 'This session has an uncommitted transaction. Closing it rolls the transaction back.', confirmLabel: 'Roll back and close', danger: true });
        if (!ok) return;
      }
      const tab = useSessions.getState().tabOf(s.sessionId);
      await useSessions.getState().closeSession(s.sessionId, true);
      if (tab) useResults.getState().clearTab(tab);
    },
  },

  // Help
  { id: 'help.about', title: 'About DbStudio', category: 'Help', icon: 'Info', run: () => toast('info', `DbStudio ${getPlatform().appVersion}`, 'A fast desktop client for SQL Server, Oracle and SQLite.') },
  {
    id: 'help.welcome', title: 'Show welcome screen', category: 'Help', icon: 'House',
    run: () => useTabs.getState().openView({ view: 'welcome', title: 'Welcome', key: 'welcome' }),
  },
];

/** M1 native-menu ids (bridge.ts MenuCommand) → registry ids. */
export const LEGACY_IDS: Record<string, string> = {
  newConnection: 'file.newConnection', newQueryTab: 'file.newConsole', openFile: 'file.open', saveFile: 'file.save',
  saveFileAs: 'file.saveAs', closeTab: 'tab.close', runStatement: 'run.statement', runScript: 'run.script', cancel: 'run.cancel',
  commit: 'tx.commit', rollback: 'tx.rollback', toggleResults: 'view.toggleResults', toggleExplorer: 'view.toggleSidebar',
  commandPalette: 'view.commandPalette', toggleTheme: 'view.toggleTheme', showHistory: 'view.history', zoomIn: 'view.zoomIn',
  zoomOut: 'view.zoomOut', zoomReset: 'view.zoomReset', about: 'help.about', goToObject: 'view.goToObject',
};

export function registerCoreCommands(): void {
  for (const c of CORE_COMMANDS) registerCommand(c);
  for (const [a, t] of Object.entries(LEGACY_IDS)) aliasCommand(a, t);
}


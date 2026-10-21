// Shell commands owned by WP-J (file, tabs, view, query, connections, explorer, history, help).
// Other packages register theirs from their own commands.ts (auto-loaded by ./index.ts).
import { api } from '../api/client';
import type { HistoryEntry, SessionInfo } from '../api/types';
import {
  cancelTab, catalogDatabase, closeTab, commitTab, connectAllInFolder, connectAndOpen, copyText, disconnectAll, disconnectConnection,
  insertIntoActiveEditor, newConsole, openObject, openSampleDatabase, openSqlFile, openSqliteFile, reopenSql, rerun, rollbackTab,
  ownSessions, runActive, saveActiveFile, saveEditToDatabase, selectTop, setTxMode,
} from '../app/actions';
import { canDrop, copyDdl, dropObject, generateSqlInto, truncateTable, type SqlTemplate } from '../app/objectActions';
import { checkForUpdatesNow } from '../app/updates';
import { currentZoom, setZoom } from '../app/zoom';
import { peekEditSession } from '../designer/editSession';
import { pluralize } from '../components/common/text';
import { useExplorer } from '../components/Explorer/explorerStore';
import { cycleRegion, focusEditorRegion, focusExplorer, focusResults } from '../components/layout/regions';
import { isTabular, qualifiedName } from '../lib/sql';
import { getPlatform } from '../platform';
import { dbKey, useCatalog } from '../store/catalog';
import { dialectOf, getConnection, kindOf, providerKind, useConnections } from '../store/connections';
import { sourceClientOpen, useSourceClients } from '../store/sourceClients';
import { useHistory } from '../store/history';
import { useResults } from '../store/results';
import { isRunning } from '../store/resultsReducer';
import { isForeignSession, useSessions } from '../store/sessions';
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

/** The other tabs of the tab's editor group. */
function siblingTabIds(id: string | null): string[] {
  if (!id) return [];
  const s = useTabs.getState();
  const group = s.groups.find((g) => g.tabIds.includes(id));
  return (group ? group.tabIds : s.tabs.map((t) => t.id)).filter((x) => x !== id);
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

/** The session a command targets; never one another live window is using (listed read-only, logic-r1-03). */
function sessionOf(a: unknown): SessionInfo | undefined {
  const sid = a && typeof a === 'object' ? (a as { sessionId?: unknown }).sessionId : undefined;
  const s = typeof sid === 'string' ? useSessions.getState().sessions[sid] : undefined;
  return s && !isForeignSession(s) ? s : undefined;
}

// ---------- the list ----------

export const CORE_COMMANDS: Command<never>[] = [
  // File
  { id: 'file.newConsole', title: 'New query console', category: 'File', shortcut: 'Mod+N', altShortcuts: ['Mod+T'], icon: 'SquareTerminal', run: () => void newConsole() },
  { id: 'file.newConnection', title: 'New connection…', category: 'File', shortcut: 'Mod+Shift+N', icon: 'Plus', run: () => useUi.getState().openConnectionDialog({ mode: 'new', connectAfter: true }) },
  { id: 'file.open', title: 'Open SQL file…', category: 'File', shortcut: 'Mod+O', icon: 'FolderOpen', run: () => void openSqlFile() },
  { id: 'file.openSqlite', title: 'Open a SQLite database file…', category: 'File', icon: 'File', run: () => void openSqliteFile() },
  { id: 'file.sampleDb', title: 'Open the sample database', category: 'File', keywords: 'try demo shop', icon: 'Sparkles', run: () => void openSampleDatabase() },
  {
    // In an F4 "Edit:" console (procedure, function, view, trigger…) Save writes the object to the database, like
    // SSMS / Navicat / DataGrip; elsewhere it saves the .sql file. Save as… always writes a file.
    id: 'file.save', title: 'Save', category: 'File', icon: 'Save', shortcut: 'Mod+S', when: () => !!getActiveConsole(),
    run: () => {
      const t = getActiveConsole();
      if (t && peekEditSession(t.id)) void saveEditToDatabase(t.id);
      else void saveActiveFile(false);
    },
  },
  { id: 'file.saveAs', title: 'Save as…', category: 'File', icon: 'Save', shortcut: 'Mod+Shift+S', when: () => !!getActiveConsole(), run: () => void saveActiveFile(true) },

  // Tabs
  {
    id: 'tab.close', title: 'Close tab', category: 'Tabs', icon: 'X', shortcut: 'Mod+W', when: (a?: unknown) => !!tabIdOf(a),
    run: (a?: unknown) => { const id = tabIdOf(a); if (id) void closeTab(id); },
  },
  {
    // With split editor groups, "other tabs" are the other tabs of the tab's group.
    id: 'tab.closeOthers', title: 'Close other tabs', category: 'Tabs', icon: 'X', when: (a?: unknown) => siblingTabIds(tabIdOf(a)).length > 0,
    run: (a?: unknown) => {
      for (const id of siblingTabIds(tabIdOf(a))) void closeTab(id);
    },
  },
  {
    id: 'tab.rename', title: 'Rename tab', category: 'Tabs', icon: 'TextCursorInput', when: (a?: unknown) => useTabs.getState().tabs.find((t) => t.id === tabIdOf(a))?.kind === 'console',
    run: (a?: unknown) => useUi.getState().setRenamingTab(tabIdOf(a)),
  },
  { id: 'tab.reopenClosed', title: 'Reopen closed tab', category: 'Tabs', icon: 'Undo2', shortcut: 'Mod+Shift+T', when: () => useTabs.getState().closed.length > 0, run: () => void useTabs.getState().reopenClosed() },
  {
    id: 'tab.duplicate', title: 'Duplicate console', category: 'Tabs', icon: 'Copy',
    when: (a?: unknown) => useTabs.getState().tabs.find((t) => t.id === tabIdOf(a))?.kind === 'console',
    run: (a?: unknown) => {
      const t = useTabs.getState().tabs.find((x) => x.id === tabIdOf(a));
      if (t?.kind === 'console') newConsole(t.connectionId, t.database, t.text);
    },
  },
  { id: 'tab.mruNext', title: 'Switch to previously used tab', category: 'Tabs', icon: 'ArrowRightLeft', shortcut: 'MacCtrl+Tab', when: () => useTabs.getState().tabs.length > 1, run: () => useTabs.getState().activateMru(1) },
  { id: 'tab.mruPrev', title: 'Switch tabs (reverse order of use)', category: 'Tabs', icon: 'ArrowRightLeft', shortcut: 'MacCtrl+Shift+Tab', when: () => useTabs.getState().tabs.length > 1, run: () => useTabs.getState().activateMru(-1) },
  { id: 'tab.next', title: 'Next tab', category: 'Tabs', icon: 'ArrowRightLeft', shortcut: 'Mod+PageDown', altShortcuts: ['Mod+Alt+ArrowRight'], run: () => useTabs.getState().activateRelative(1) },
  { id: 'tab.prev', title: 'Previous tab', category: 'Tabs', icon: 'ArrowRightLeft', shortcut: 'Mod+PageUp', altShortcuts: ['Mod+Alt+ArrowLeft'], run: () => useTabs.getState().activateRelative(-1) },
  ...Array.from({ length: 9 }, (_, i): Command<never> => ({
    id: `tab.goto${i + 1}`, title: i === 8 ? 'Go to last tab' : `Go to tab ${i + 1}`, category: 'Tabs', shortcut: `Mod+${i + 1}`, palette: false,
    run: () => useTabs.getState().activateIndex(i),
  })),

  // View
  { id: 'view.commandPalette', title: 'Command palette…', category: 'View', shortcut: 'Mod+Shift+P', icon: 'Command', run: () => useUi.getState().openPalette('commands') },
  { id: 'view.goToObject', title: 'Go to database object…', category: 'View', shortcut: 'Mod+P', keywords: 'quick open search table', icon: 'Search', run: () => useUi.getState().openPalette('objects') },
  { id: 'view.shortcuts', title: 'Keyboard shortcuts', category: 'Help', shortcut: 'F1', altShortcuts: ['Mod+K Mod+S'], keywords: 'keys keybindings help', icon: 'Keyboard', run: () => useUi.getState().setShortcutsOpen(true) },
  { id: 'view.toggleSidebar', title: 'Toggle side panel', category: 'View', shortcut: 'Mod+B', icon: 'PanelLeft', run: () => useUi.getState().toggle('explorerVisible') },
  // Showing a panel focuses its search box (type to filter right away); Alt+1 focuses the explorer tree itself.
  { id: 'view.explorer', title: 'Show database explorer', category: 'View', shortcut: 'Mod+Shift+E', icon: 'Database', run: () => { useUi.getState().showDock('explorer'); useExplorer.getState().focusFilter(); } },
  {
    id: 'view.history', title: 'Show query history', category: 'View', shortcut: 'Mod+Shift+H', icon: 'History',
    run: () => {
      const ui = useUi.getState();
      const showing = ui.explorerVisible && ui.dock === 'history';
      ui.showDock('history', true);
      if (!showing) useHistory.getState().requestFocus();
    },
  },
  { id: 'connections.showActive', title: 'Show active connections', category: 'Connections', keywords: 'sessions', icon: 'Activity', run: () => useUi.getState().showDock('connections') },
  { id: 'view.toggleResults', title: 'Toggle results pane', category: 'View', icon: 'Rows2', shortcut: 'Mod+R', run: () => useUi.getState().toggle('resultsVisible') },
  { id: 'view.maximizeResults', title: 'Maximize / restore results pane', category: 'View', icon: 'Maximize2', shortcut: 'Mod+Shift+R', run: () => useUi.getState().setResultsMaximized(!useUi.getState().resultsMaximized) },
  // Keyboard regions: Alt+1/2/3 and F6 / Shift+F6 (dock → editor → results → status bar).
  { id: 'view.focusExplorer', title: 'Focus explorer', category: 'View', shortcut: 'Alt+1', icon: 'Database', keywords: 'tree side panel keyboard', run: () => void focusExplorer() },
  { id: 'view.focusEditor', title: 'Focus editor', category: 'View', shortcut: 'Alt+2', icon: 'SquareTerminal', keywords: 'keyboard', when: () => useTabs.getState().tabs.length > 0, run: () => void focusEditorRegion() },
  { id: 'view.focusResults', title: 'Focus results', category: 'View', shortcut: 'Alt+3', icon: 'Rows3', keywords: 'grid keyboard result set', when: () => !!getActiveConsole(), run: () => void focusResults() },
  { id: 'view.nextRegion', title: 'Focus next region', category: 'View', shortcut: 'F6', keywords: 'keyboard panel cycle', icon: 'ArrowRightLeft', run: () => cycleRegion(1) },
  { id: 'view.prevRegion', title: 'Focus previous region', category: 'View', shortcut: 'Shift+F6', keywords: 'keyboard panel cycle', icon: 'ArrowRightLeft', run: () => cycleRegion(-1) },
  { id: 'view.zoomIn', title: 'Zoom in', category: 'View', shortcut: 'Mod+=', icon: 'ZoomIn', run: () => setZoom(currentZoom() + 0.1) },
  { id: 'view.zoomOut', title: 'Zoom out', category: 'View', shortcut: 'Mod+-', icon: 'ZoomOut', run: () => setZoom(currentZoom() - 0.1) },
  { id: 'view.zoomReset', title: 'Reset zoom', category: 'View', shortcut: 'Mod+0', icon: 'Search', run: () => setZoom(1) },
  { id: 'view.settings', title: 'Settings…', category: 'Preferences', shortcut: 'Mod+,', icon: 'Settings', keywords: 'preferences options', run: () => useUi.getState().setSettingsOpen(true) },
  { id: 'view.toggleTheme', title: 'Toggle light / dark theme', category: 'Preferences', icon: 'SunMoon', run: () => useSettings.getState().update({ theme: currentTheme() === 'dark' ? 'light' : 'dark' }) },
  { id: 'view.themeLight', title: 'Theme: Light', category: 'Preferences', icon: 'Sun', run: () => useSettings.getState().update({ theme: 'light' }) },
  { id: 'view.themeDark', title: 'Theme: Dark', category: 'Preferences', icon: 'Moon', run: () => useSettings.getState().update({ theme: 'dark' }) },
  { id: 'view.themeSystem', title: 'Theme: Follow system', category: 'Preferences', icon: 'Monitor', run: () => useSettings.getState().update({ theme: 'system' }) },
  {
    id: 'view.toggleDensity', title: 'Toggle compact density', category: 'Preferences', icon: 'Rows3', keywords: 'row height grid',
    run: () => useSettings.getState().update({ grid: { density: useSettings.getState().settings.grid.density === 'compact' ? 'comfortable' : 'compact' } }),
  },
  {
    id: 'prefs.toggleConfirmDestructive', title: 'Toggle confirmation of destructive statements', category: 'Preferences', icon: 'ShieldAlert',
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
    id: 'run.rerunNoLimit', title: 'Re-run last query without row limit', category: 'Query', icon: 'RefreshCw',
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
    id: 'tx.toggleMode', title: 'Toggle auto-commit / manual transaction', category: 'Transaction', icon: 'ArrowRightLeft', when: () => !!consoleWithConnection(),
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
    when: () => {
      const t = consoleWithConnection();
      const p = t ? getConnection(t.connectionId)?.providerId : undefined;
      // Databases (SQL Server, PostgreSQL) or Oracle schemas; never SQLite or a non-relational source.
      return !!p && p !== 'sqlite' && providerKind(p) === 'relational';
    },
    run: () => useUi.getState().openSwitcher({ tabId: getActiveConsole()!.id, mode: 'database', anchor: anchorOf('.console:not([style*="none"]) .db-pill') }),
  },
  {
    // M2: Redis/MongoDB/Kafka connections open their module's default workspace (browser, documents, overview).
    id: 'connections.openWorkspace', title: 'Open', category: 'Connections', icon: 'PanelsTopLeft', palette: false,
    when: (a?: unknown) => { const cid = connectionIdOf(a); return !!cid && kindOf(cid) !== 'relational'; },
    run: (a?: unknown) => void connectAndOpen(connectionIdOf(a)!),
  },
  {
    id: 'connections.openConsole', title: 'Open console', category: 'Connections', icon: 'SquareTerminal',
    // M2: consoles only on relational connections.
    when: (a?: unknown) => { const cid = connectionIdOf(a); return !!cid && kindOf(cid) === 'relational'; },
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
      // Only what Disconnect closes: the cached catalog and this window's sessions (not another window's).
      return !!cid && (!!useCatalog.getState().conns[cid] || ownSessions(cid).length > 0 || sourceClientOpen(cid));
    },
    run: (a?: unknown) => void disconnectConnection(connectionIdOf(a)!),
  },
  {
    id: 'connections.disconnectAll', title: 'Disconnect all', category: 'Connections', icon: 'Unplug',
    when: () => ownSessions().length > 0 || Object.keys(useCatalog.getState().conns).length > 0 || Object.keys(useSourceClients.getState().clients).length > 0,
    run: () => void disconnectAll(),
  },
  {
    id: 'connections.connectFolder', title: 'Connect all in folder', category: 'Connections', icon: 'Plug', palette: false,
    when: (a?: unknown) => !!a && typeof a === 'object' && typeof (a as { folder?: unknown }).folder === 'string',
    run: (a?: unknown) => {
      const ids = connectAllInFolder((a as { folder: string }).folder);
      useExplorer.getState().expandAll(ids.map((id) => `c:${id}`));
    },
  },
  {
    id: 'connections.newInFolder', title: 'New connection in folder…', category: 'Connections', icon: 'Plus', palette: false,
    run: (a?: unknown) => useUi.getState().openConnectionDialog({ mode: 'new', folder: (a as { folder?: string } | undefined)?.folder ?? null, connectAfter: true }),
  },
  {
    id: 'connections.delete', title: 'Delete connection…', category: 'Connections', icon: 'Trash2', danger: true, when: (a?: unknown) => !!connectionIdOf(a),
    run: async (a?: unknown) => {
      const cid = connectionIdOf(a)!;
      const c = getConnection(cid);
      // Engine-wide list: sessions of reloaded windows and of other open windows are rolled back too (force delete).
      await useSessions.getState().refreshAll();
      const { sessions, byTab } = useSessions.getState();
      const tabs = useTabs.getState().tabs.filter((t) => t.connectionId === cid);
      const consoles = tabs.filter((t) => t.kind === 'console');
      const txOf = (tabId: string) => !!sessions[byTab[tabId]]?.txOpen;
      const owned = new Set(Object.values(byTab));
      const strayTx = Object.values(sessions).filter((s) => s.connectionId === cid && s.txOpen && !owned.has(s.sessionId));
      const nTx = consoles.filter((t) => txOf(t.id)).length + strayTx.length;
      const items = [
        ...consoles.map((t) => `Console “${t.title}”${txOf(t.id) ? ' — uncommitted transaction, rolled back' : ''}`),
        ...strayTx.map((s) => (isForeignSession(s)
          ? `Session ${s.label ?? s.sessionId} in another window — its uncommitted transaction will be rolled back`
          : `Session ${s.label ?? s.sessionId} — uncommitted transaction, rolled back`)),
        ...tabs.filter((t) => t.kind !== 'console').map((t) => `Tab “${t.title}” (closed)`),
      ];
      const parts = [`Delete “${c?.name ?? cid}”? Its saved password is removed too.`];
      const n = consoles.length;
      if (n) parts.push(`${n === 1 ? '1 console uses' : `${n.toLocaleString()} consoles use`} it and ${n === 1 ? 'stays' : 'stay'} open without a connection.`);
      if (nTx) parts.push(`${pluralize(nTx, 'open transaction')} will be rolled back.`);
      const ok = await useUi.getState().askConfirm({
        title: 'Delete connection', message: parts.join(' '), items: items.length ? items : undefined,
        confirmLabel: nTx ? 'Roll back and delete' : 'Delete', danger: true,
      });
      if (!ok) return;
      try {
        await useSessions.getState().closeConnection(cid, true);
        await useConnections.getState().remove(cid, { force: true });
        useCatalog.getState().forget(cid);
        useExplorer.getState().forgetConnection(cid);
        for (const t of tabs) {
          if (t.kind === 'console') {
            useTabs.getState().setConnection(t.id, null);
            useResults.getState().clearTab(t.id);
          } else useTabs.getState().close(t.id);
        }
        toast('info', `Deleted ${c?.name ?? 'the connection'}`);
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
    id: 'explorer.copyQualifiedName', title: 'Copy qualified name', category: 'Database', icon: 'ClipboardCopy', when: (a?: unknown) => !!objectTargetOf(a),
    run: (a?: unknown) => { const t = objectTargetOf(a)!; void copyText(qualifiedName(t.ref, dialectOf(t.connectionId), { always: true })); },
  },
  {
    id: 'explorer.copyDdl', title: 'Copy DDL', category: 'Database', icon: 'ClipboardCopy', keywords: 'create script definition clipboard',
    when: (a?: unknown) => !!objectTargetOf(a),
    run: (a?: unknown) => { const t = objectTargetOf(a)!; void copyDdl(t.connectionId, t.database, t.ref); },
  },
  ...(['select', 'insert', 'update', 'delete'] as SqlTemplate[]).map((k): Command<never> => ({
    id: `explorer.generate${k[0].toUpperCase()}${k.slice(1)}`, title: `Generate ${k.toUpperCase()} statement`, category: 'Database',
    icon: k === 'select' ? 'Search' : k === 'insert' ? 'Plus' : k === 'update' ? 'Pencil' : 'Trash2', keywords: 'generate sql template statement',
    when: (a?: unknown) => { const t = objectTargetOf(a); return !!t && isTabular(t.ref.type) && (k === 'select' || t.ref.type !== 'mview'); },
    run: (a?: unknown) => { const t = objectTargetOf(a)!; generateSqlInto(k, t.connectionId, t.database, t.ref); },
  })),
  {
    id: 'explorer.truncate', title: 'Truncate table…', category: 'Database', icon: 'Eraser', keywords: 'empty delete all rows', danger: true,
    when: (a?: unknown) => { const t = objectTargetOf(a); return !!t && t.ref.type === 'table' && !getConnection(t.connectionId)?.readOnly; },
    run: (a?: unknown) => { const t = objectTargetOf(a)!; void truncateTable(t.connectionId, t.database, t.ref); },
  },
  {
    id: 'explorer.drop', title: 'Drop…', category: 'Database', icon: 'Trash2', keywords: 'delete remove object table view', danger: true,
    when: (a?: unknown) => { const t = objectTargetOf(a); return !!t && canDrop(t.ref.type, dialectOf(t.connectionId)) && !getConnection(t.connectionId)?.readOnly; },
    run: (a?: unknown) => { const t = objectTargetOf(a)!; void dropObject(t.connectionId, t.database, t.ref); },
  },
  { id: 'explorer.focusFilter', title: 'Filter explorer', category: 'Database', icon: 'Filter', shortcut: 'Mod+F', scope: 'explorer', run: () => useExplorer.getState().focusFilter() },
  { id: 'explorer.refresh', title: 'Refresh selected node', category: 'Database', icon: 'RefreshCw', shortcut: 'F5', scope: 'explorer', palette: false, run: () => void runCommand('connections.refreshCatalog') },
  { id: 'explorer.collapseAll', title: 'Collapse all explorer nodes', category: 'Database', icon: 'ChevronsDownUp', run: () => useExplorer.getState().collapseAll() },

  // History
  { id: 'history.focusFilter', title: 'Search query history', category: 'History', icon: 'Search', shortcut: 'Mod+F', scope: 'history', run: () => useHistory.getState().requestFocus() },
  { id: 'history.reload', title: 'Reload query history', category: 'History', icon: 'RefreshCw', run: () => void useHistory.getState().load() },
  {
    id: 'history.clear', title: 'Clear query history…', category: 'History', icon: 'Trash', danger: true,
    run: async () => {
      const ok = await useUi.getState().askConfirm({ title: 'Clear history', message: 'Delete all unpinned history entries?', confirmLabel: 'Clear', danger: true });
      if (ok) void useHistory.getState().clear();
    },
  },

  // History entries (context menu of a history item; args: HistoryEntry)
  { id: 'history.openEntry', title: 'Open in new console', category: 'History', icon: 'SquareTerminal', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => { const h = a as HistoryEntry; reopenSql(h.sql, h.connectionId, h.database); } },
  { id: 'history.insertEntry', title: 'Insert into current editor', category: 'History', icon: 'TextCursorInput', palette: false, when: (a?: unknown) => isEntry(a) && !!getActiveConsole(), run: (a?: unknown) => insertIntoActiveEditor((a as HistoryEntry).sql) },
  { id: 'history.copyEntry', title: 'Copy SQL', category: 'History', icon: 'Copy', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => void copyText((a as HistoryEntry).sql) },
  { id: 'history.togglePin', title: 'Pin / unpin', category: 'History', icon: 'Pin', palette: false, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => void useHistory.getState().togglePin((a as HistoryEntry).id).catch(() => toast('error', 'Pin failed')) },
  { id: 'history.deleteEntry', title: 'Delete entry', category: 'History', icon: 'Trash2', palette: false, danger: true, when: (a?: unknown) => isEntry(a), run: (a?: unknown) => void useHistory.getState().remove((a as HistoryEntry).id).catch(() => toast('error', 'Delete failed')) },

  // Sessions (active connections panel; args: { sessionId })
  {
    id: 'sessions.cancel', title: 'Cancel query in session', category: 'Connections', icon: 'CircleStop', palette: false,
    when: (a?: unknown) => { const s = sessionOf(a); return !!s && s.state === 'executing'; },
    run: async (a?: unknown) => { const s = sessionOf(a); if (s) await api.cancel(s.sessionId).catch((e) => toast('error', 'Cancel failed', String(e))); },
  },
  {
    id: 'sessions.disconnect', title: 'Close session', category: 'Connections', icon: 'X', palette: false, when: (a?: unknown) => !!sessionOf(a),
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
  {
    // Unused sessions left by a reload or crash (Connections panel): roll their transaction back and close them.
    id: 'sessions.rollbackClose', title: 'Roll back and close session', category: 'Connections', icon: 'RotateCcw', palette: false, danger: true,
    when: (a?: unknown) => !!sessionOf(a)?.txOpen,
    run: async (a?: unknown) => {
      const s = sessionOf(a)!;
      const conn = getConnection(s.connectionId);
      const ok = await useUi.getState().askConfirm({
        title: 'Roll back and close?',
        message: `The session on “${conn?.name ?? s.connectionId}” has an uncommitted transaction. Its changes are discarded.`,
        confirmLabel: 'Roll back and close', danger: true,
      });
      if (!ok) return;
      try {
        await useSessions.getState().closeSession(s.sessionId, true);
        toast('info', 'Transaction rolled back and session closed');
      } catch (e) {
        toast('error', 'Could not close the session', e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    id: 'sessions.closeOrphans', title: 'Close unused sessions', category: 'Connections', icon: 'Unplug', keywords: 'orphan leaked reload sessions',
    when: () => useSessions.getState().orphans().some((s) => !s.txOpen && s.state !== 'executing'),
    run: async () => {
      const list = useSessions.getState().orphans().filter((s) => !s.txOpen && s.state !== 'executing');
      await Promise.all(list.map((s) => useSessions.getState().closeSession(s.sessionId, false).catch(() => undefined)));
      toast('info', `Closed ${pluralize(list.length, 'unused session')}`);
    },
  },

  // Help
  { id: 'help.about', title: 'About DbStudio', category: 'Help', icon: 'Info', run: () => toast('info', `DbStudio ${getPlatform().appVersion}`, 'A fast desktop client for SQL Server, Oracle and SQLite.') },
  {
    id: 'help.checkForUpdates', title: 'Check for Updates…', category: 'Help', icon: 'RefreshCw', keywords: 'update upgrade new version release',
    run: () => checkForUpdatesNow(),
  },
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


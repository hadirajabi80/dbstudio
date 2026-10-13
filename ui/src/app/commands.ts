// Command registry used by the command palette, global shortcuts and the native (Electron) menu.
import type { MenuCommand } from '../platform/bridge';
import { getPlatform } from '../platform';
import { useCatalog } from '../store/catalog';
import { useSettings } from '../store/settings';
import { useTabs } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import {
  cancelTab, catalogDatabase, closeTab, commitTab, newConsole, openSqlFile, rerun, rollbackTab, runActive, saveActiveFile,
} from './actions';
import { getEditor } from './editors';
import { currentTheme } from '../theme/useTheme';

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Display string, e.g. "Ctrl+Shift+P". */
  keys?: string;
  run: () => void;
  enabled?: () => boolean;
}

const activeConsole = () => {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return t?.kind === 'console' ? t : undefined;
};

let zoom = 1;
function setZoom(z: number) {
  zoom = Math.max(0.6, Math.min(2, Math.round(z * 10) / 10));
  (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
}

export const COMMANDS: Command[] = [
  { id: 'newQueryTab', title: 'New query console', category: 'File', keys: 'Ctrl+N', run: () => void newConsole() },
  { id: 'newConnection', title: 'New connection…', category: 'File', keys: 'Ctrl+Shift+N', run: () => useUi.getState().openConnectionDialog({ mode: 'new' }) },
  { id: 'openFile', title: 'Open SQL file…', category: 'File', keys: 'Ctrl+O', run: () => void openSqlFile() },
  { id: 'saveFile', title: 'Save', category: 'File', keys: 'Ctrl+S', run: () => void saveActiveFile(false), enabled: () => !!activeConsole() },
  { id: 'saveFileAs', title: 'Save as…', category: 'File', keys: 'Ctrl+Shift+S', run: () => void saveActiveFile(true), enabled: () => !!activeConsole() },
  {
    id: 'closeTab', title: 'Close tab', category: 'File', keys: 'Ctrl+W',
    run: () => {
      const id = useTabs.getState().activeId;
      if (id) void closeTab(id);
    },
  },
  { id: 'runStatement', title: 'Run statement at cursor / selection', category: 'Query', keys: 'Ctrl+Enter', run: () => runActive('statement'), enabled: () => !!activeConsole() },
  { id: 'runScript', title: 'Run script', category: 'Query', keys: 'F5', run: () => runActive('script'), enabled: () => !!activeConsole() },
  { id: 'cancel', title: 'Cancel running query', category: 'Query', keys: 'Shift+F5', run: () => void cancelTab() },
  {
    id: 'rerunNoLimit', title: 'Re-run last query without row limit', category: 'Query',
    run: () => {
      const t = activeConsole();
      if (t) void rerun(t.id, { maxRows: 0 });
    },
  },
  { id: 'commit', title: 'Commit transaction', category: 'Transaction', run: () => void commitTab() },
  { id: 'rollback', title: 'Roll back transaction', category: 'Transaction', run: () => void rollbackTab() },
  { id: 'toggleExplorer', title: 'Toggle database explorer', category: 'View', keys: 'Ctrl+B', run: () => useUi.getState().toggle('explorerVisible') },
  { id: 'toggleResults', title: 'Toggle results pane', category: 'View', keys: 'Ctrl+R', run: () => useUi.getState().toggle('resultsVisible') },
  { id: 'showHistory', title: 'Toggle query history', category: 'View', keys: 'Ctrl+Shift+H', run: () => useUi.getState().toggle('historyVisible') },
  { id: 'commandPalette', title: 'Command palette', category: 'View', keys: 'Ctrl+Shift+P', run: () => useUi.getState().openPalette('commands') },
  { id: 'goToObject', title: 'Go to database object…', category: 'View', keys: 'Ctrl+P', run: () => useUi.getState().openPalette('objects') },
  { id: 'nextTab', title: 'Next tab', category: 'View', keys: 'Ctrl+Tab', run: () => useTabs.getState().activateRelative(1) },
  { id: 'prevTab', title: 'Previous tab', category: 'View', keys: 'Ctrl+Shift+Tab', run: () => useTabs.getState().activateRelative(-1) },
  { id: 'focusEditor', title: 'Focus editor', category: 'View', keys: 'Esc', run: () => getEditor(useTabs.getState().activeId)?.focus() },
  {
    id: 'toggleTheme', title: 'Toggle light / dark theme', category: 'Preferences',
    run: () => useSettings.getState().update({ theme: currentTheme() === 'dark' ? 'light' : 'dark' }),
  },
  { id: 'themeLight', title: 'Theme: Light', category: 'Preferences', run: () => useSettings.getState().update({ theme: 'light' }) },
  { id: 'themeDark', title: 'Theme: Dark', category: 'Preferences', run: () => useSettings.getState().update({ theme: 'dark' }) },
  { id: 'themeSystem', title: 'Theme: Follow system', category: 'Preferences', run: () => useSettings.getState().update({ theme: 'system' }) },
  {
    id: 'toggleConfirmDestructive', title: 'Toggle confirmation of destructive statements', category: 'Preferences',
    run: () => {
      const v = !useSettings.getState().settings.confirmDestructive;
      useSettings.getState().update({ confirmDestructive: v });
      toast('info', v ? 'Destructive statements will ask for confirmation' : 'Destructive-statement confirmation is off');
    },
  },
  {
    id: 'refreshCatalog', title: 'Refresh catalog of the current connection', category: 'Database',
    run: () => {
      const t = activeConsole();
      if (t?.connectionId) void useCatalog.getState().refresh(t.connectionId, catalogDatabase(t.connectionId, t.database));
    },
    enabled: () => !!activeConsole()?.connectionId,
  },
  { id: 'zoomIn', title: 'Zoom in', category: 'View', keys: 'Ctrl+=', run: () => setZoom(zoom + 0.1) },
  { id: 'zoomOut', title: 'Zoom out', category: 'View', keys: 'Ctrl+-', run: () => setZoom(zoom - 0.1) },
  { id: 'zoomReset', title: 'Reset zoom', category: 'View', keys: 'Ctrl+0', run: () => setZoom(1) },
  {
    id: 'about', title: 'About DbStudio', category: 'Help',
    run: () => toast('info', `DbStudio ${getPlatform().appVersion}`, 'A fast desktop client for SQL Server, Oracle and SQLite.'),
  },
];

export function runCommand(id: string): void {
  const c = COMMANDS.find((x) => x.id === id);
  if (!c) return;
  if (c.enabled && !c.enabled()) return;
  c.run();
}

/** Native menu → command. */
export function handleMenuCommand(cmd: MenuCommand): void {
  runCommand(cmd);
}

/** Keys the Electron menu registers as accelerators; in Electron the menu handles them (no double firing). */
const MENU_OWNED = new Set([
  'ctrl+n', 'ctrl+shift+n', 'ctrl+o', 'ctrl+s', 'ctrl+shift+s', 'ctrl+w', 'ctrl+b', 'ctrl+r', 'ctrl+shift+p', 'ctrl+shift+h',
  'ctrl+=', 'ctrl+-', 'ctrl+0', 'shift+f5',
]);

/** Global (non-editor) shortcuts. The editor owns Ctrl+Enter / F5 / Esc while it has focus. */
const GLOBAL_KEYS: Record<string, string> = {
  'ctrl+shift+p': 'commandPalette',
  'f1': 'commandPalette',
  'ctrl+p': 'goToObject',
  'ctrl+r': 'toggleResults',
  'ctrl+b': 'toggleExplorer',
  'ctrl+shift+h': 'showHistory',
  'ctrl+t': 'newQueryTab',
  'ctrl+n': 'newQueryTab',
  'ctrl+shift+n': 'newConnection',
  'ctrl+w': 'closeTab',
  'ctrl+o': 'openFile',
  'ctrl+s': 'saveFile',
  'ctrl+shift+s': 'saveFileAs',
  'ctrl+tab': 'nextTab',
  'ctrl+shift+tab': 'prevTab',
  'ctrl+pagedown': 'nextTab',
  'ctrl+pageup': 'prevTab',
  'shift+f5': 'cancel',
  'ctrl+=': 'zoomIn',
  'ctrl+-': 'zoomOut',
  'ctrl+0': 'zoomReset',
};

export function keyId(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key.toLowerCase();
  if (k === '+') k = '=';
  if (k === '_') k = '-';
  parts.push(k);
  return parts.join('+');
}

export function onGlobalKeyDown(e: KeyboardEvent): void {
  const id = keyId(e);
  const inEditor = !!(e.target as HTMLElement | null)?.closest?.('.monaco-editor');
  // Outside the editor, F5 / Ctrl+Enter still run the active console (and keep the browser from reloading).
  if (!inEditor && (id === 'f5' || id === 'ctrl+enter' || id === 'ctrl+shift+enter')) {
    if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [role=dialog]')) return;
    e.preventDefault();
    runActive(id === 'ctrl+enter' ? 'statement' : 'script');
    return;
  }
  const cmd = GLOBAL_KEYS[id];
  if (!cmd) return;
  if (getPlatform().kind === 'electron' && MENU_OWNED.has(id)) return; // the native menu sends it
  if (inEditor && (id === 'ctrl+=' || id === 'ctrl+-' || id === 'ctrl+0')) return;
  e.preventDefault();
  e.stopPropagation();
  runCommand(cmd);
}

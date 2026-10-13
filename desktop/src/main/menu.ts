// Native menu. Items send MenuCommands (bridge.ts) to the renderer.
//
// Keyboard routing on Windows: Chromium gives the page the keydown first; a menu accelerator only
// fires when the page did NOT handle the key (preventDefault). Keys the editor owns (Ctrl+Enter, F5)
// are shown in the menu with `registerAccelerator: false`, so they never fire twice and keep working
// only where the editor wants them. All other accelerators are registered; renderer code that also
// handles one of them must call preventDefault() (then the menu stays quiet).
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../../../ui/src/platform/bridge';
import { IPC } from '../shared/channels';
import { logsDir } from './paths';

export interface MenuOptions {
  isDev: boolean;
  onRestartEngine?: () => void;
}

export interface ShortcutRow { command: MenuCommand; label: string; accelerator?: string; registered: boolean }

/** Single source of truth for the menu and the README shortcut table. */
export const SHORTCUTS: ShortcutRow[] = [
  { command: 'newConnection', label: 'New Connection…', accelerator: 'Ctrl+Shift+N', registered: true },
  { command: 'newQueryTab', label: 'New Query Tab', accelerator: 'Ctrl+N', registered: true },
  { command: 'openFile', label: 'Open File…', accelerator: 'Ctrl+O', registered: true },
  { command: 'saveFile', label: 'Save', accelerator: 'Ctrl+S', registered: true },
  { command: 'saveFileAs', label: 'Save As…', accelerator: 'Ctrl+Shift+S', registered: true },
  { command: 'closeTab', label: 'Close Tab', accelerator: 'Ctrl+W', registered: true },
  { command: 'runStatement', label: 'Execute Statement / Selection', accelerator: 'Ctrl+Enter', registered: false },
  { command: 'runScript', label: 'Execute Script', accelerator: 'F5', registered: false },
  { command: 'cancel', label: 'Cancel Execution', accelerator: 'Shift+F5', registered: true },
  { command: 'commit', label: 'Commit', registered: true },
  { command: 'rollback', label: 'Rollback', registered: true },
  { command: 'toggleExplorer', label: 'Toggle Object Explorer', accelerator: 'Ctrl+B', registered: true },
  { command: 'toggleResults', label: 'Toggle Results Pane', accelerator: 'Ctrl+R', registered: true },
  { command: 'commandPalette', label: 'Command Palette…', accelerator: 'Ctrl+Shift+P', registered: true },
  { command: 'showHistory', label: 'Query History', accelerator: 'Ctrl+Shift+H', registered: true },
  { command: 'toggleTheme', label: 'Toggle Light/Dark Theme', registered: true },
  { command: 'zoomIn', label: 'Zoom In', accelerator: 'Ctrl+=', registered: true },
  { command: 'zoomOut', label: 'Zoom Out', accelerator: 'Ctrl+-', registered: true },
  { command: 'zoomReset', label: 'Reset Zoom', accelerator: 'Ctrl+0', registered: true },
  { command: 'about', label: 'About DbStudio', registered: true },
];

export function sendMenuCommand(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(IPC.menuCommand, command);
}

function item(command: MenuCommand): MenuItemConstructorOptions {
  const row = SHORTCUTS.find((s) => s.command === command)!;
  return {
    label: row.label,
    accelerator: row.accelerator,
    registerAccelerator: row.registered,
    click: () => sendMenuCommand(command),
  };
}

export function buildMenu(o: MenuOptions): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        item('newConnection'),
        item('newQueryTab'),
        { type: 'separator' },
        item('openFile'),
        item('saveFile'),
        item('saveFileAs'),
        { type: 'separator' },
        item('closeTab'),
        { type: 'separator' },
        { role: 'quit', label: 'Exit', accelerator: 'Alt+F4' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo', accelerator: 'Ctrl+Y' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        item('commandPalette'),
        { type: 'separator' },
        item('toggleExplorer'),
        item('toggleResults'),
        item('showHistory'),
        { type: 'separator' },
        item('toggleTheme'),
        { type: 'separator' },
        item('zoomIn'),
        item('zoomOut'),
        item('zoomReset'),
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' },
        ...(o.isDev
          ? ([
              { type: 'separator' },
              { role: 'reload', accelerator: 'Ctrl+Shift+R' },
              { role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: '&Query',
      submenu: [
        item('runStatement'),
        item('runScript'),
        item('cancel'),
        { type: 'separator' },
        item('commit'),
        item('rollback'),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Open Logs Folder', click: () => void shell.openPath(logsDir()) },
        ...(o.onRestartEngine ? [{ label: 'Restart Engine', click: o.onRestartEngine }] : []),
        ...(o.isDev ? [] : [{ role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' } satisfies MenuItemConstructorOptions]),
        { type: 'separator' },
        { ...item('about'), label: `About DbStudio ${app.getVersion()}` },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

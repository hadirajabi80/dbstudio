// Native menu, built from the renderer's pure-data menu model (ui/src/commands/menuModel.ts), so the native menu,
// the in-app menu (browser build), the command palette and the shortcut sheet all show the same commands with the
// same titles and shortcuts. Items send registry command ids to the renderer (IPC menuCommand); the renderer's
// command registry resolves them (M1 MenuCommand names are aliased there too).
//
// Keyboard routing: Chromium gives the page the keydown first; a menu accelerator only fires when the page did NOT
// handle the key (preventDefault). The renderer's key dispatcher handles every registered shortcut and calls
// preventDefault, so accelerators shown here never fire twice. Keys the editor owns (Mod+Enter, F5) are shown with
// `registerAccelerator: false`.
//
// Shortcuts are written with `Mod` (Ctrl on Windows/Linux, Cmd on macOS) and become `CmdOrCtrl` accelerators.
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { MENUS, type MenuEntry } from '../../../ui/src/commands/menuModel';
import { IPC } from '../shared/channels';
import { logsDir } from './paths';

export interface MenuOptions {
  isDev: boolean;
  onRestartEngine?: () => void;
}

export interface ShortcutRow { command: string; label: string; accelerator?: string; registered: boolean }

const PLATFORM: 'darwin' | 'win32' = process.platform === 'darwin' ? 'darwin' : 'win32';

/** "Mod+Shift+P" → "CmdOrCtrl+Shift+P"; chords ("Mod+K Mod+S") have no native accelerator. */
export function toAccelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut || /\s/.test(shortcut.trim())) return undefined;
  return shortcut
    .split('+')
    .map((p) => {
      const k = p.trim();
      const l = k.toLowerCase();
      if (l === 'mod' || l === 'ctrl' || l === 'cmd' || l === 'cmdorctrl') return 'CmdOrCtrl';
      if (l === 'macctrl') return PLATFORM === 'darwin' ? 'Ctrl' : 'CmdOrCtrl';
      if (l === 'arrowup') return 'Up';
      if (l === 'arrowdown') return 'Down';
      if (l === 'arrowleft') return 'Left';
      if (l === 'arrowright') return 'Right';
      if (l === 'esc') return 'Escape';
      return k.length === 1 ? k.toUpperCase() : k;
    })
    .join('+');
}

/** Every command item of the menu model (README shortcut table, tests). */
export const SHORTCUTS: ShortcutRow[] = MENUS.flatMap((m) =>
  m.items.flatMap((it): ShortcutRow[] =>
    it.type === undefined || it.type === 'command'
      ? [{ command: it.command, label: it.label, accelerator: toAccelerator(it.shortcut), registered: it.registerAccelerator !== false }]
      : [],
  ),
).filter((r, i, all) => all.findIndex((x) => x.command === r.command) === i);

export function sendMenuCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(IPC.menuCommand, command);
}

function entry(it: MenuEntry, o: MenuOptions): MenuItemConstructorOptions | null {
  if (it.type === 'separator') return { type: 'separator' };
  if ('platform' in it && it.platform && it.platform !== PLATFORM) return null;
  if (it.type === 'role') {
    if (it.dev && !o.isDev) return null;
    if (it.role === 'toggleDevTools' && !it.dev && o.isDev) return null;
    return { role: it.role, ...(it.label ? { label: it.label } : {}), ...(it.accelerator ? { accelerator: it.accelerator } : {}) };
  }
  if (it.type === 'native') {
    if (it.id === 'openLogs') return { label: it.label, click: () => void shell.openPath(logsDir()) };
    if (it.id === 'restartEngine') return o.onRestartEngine ? { label: it.label, click: o.onRestartEngine } : null;
    return null;
  }
  const label = it.command === 'help.about' ? `About DbStudio ${app.getVersion()}` : it.label;
  return {
    label,
    accelerator: toAccelerator(it.shortcut),
    registerAccelerator: it.registerAccelerator !== false,
    click: () => sendMenuCommand(it.command),
  };
}

/** Removes leading/trailing/double separators left by filtered items. */
function tidy(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const it of items) {
    if (it.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

export function buildMenu(o: MenuOptions): Menu {
  const template: MenuItemConstructorOptions[] = [];
  for (const m of MENUS) {
    if (m.platform && m.platform !== PLATFORM) continue;
    const items = tidy(m.items.map((it) => entry(it, o)).filter((x): x is MenuItemConstructorOptions => x !== null));
    if (!items.length) continue;
    // macOS: the first menu is the application menu (titled with the app name); the Window menu gets its role.
    if (m.id === 'app') template.push({ label: app.name, submenu: items });
    else if (m.id === 'window') template.push({ role: 'windowMenu', label: m.label, submenu: items });
    else template.push({ label: PLATFORM === 'darwin' ? m.label.replace('&', '') : m.label, submenu: items });
  }
  return Menu.buildFromTemplate(template);
}

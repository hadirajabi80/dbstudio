import { Keyboard, Menu as MenuIcon, Moon, PanelLeft, Plus, Search, Settings, SquareTerminal, Sun, SunMoon } from 'lucide-react';
import { ariaKeyShortcuts, isMac } from '../../commands/keys';
import { menuCommandIds, MENUS, type MenuEntry } from '../../commands/menuModel';
import { getCommand } from '../../commands/registry';
import { useCommandContext } from '../../commands/useCommands';
import { getPlatform } from '../../platform';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { showMenuBelow, type MenuItem } from '../common/Menu';
import { Kbd, withShortcut } from '../Shortcuts/Kbd';
import { CommandButton } from './CommandButton';
import { commandMenuItems } from './commandMenu';

/** Browser build: the native menu does not exist, so the same model is offered as an in-app menu. */
function appMenuItems(): MenuItem[] {
  const platform = isMac() ? 'darwin' : 'win32';
  const ids = new Set(menuCommandIds(platform).map((m) => m.command));
  return MENUS.filter((m) => !m.platform || m.platform === platform)
    .filter((m) => m.id !== 'window' && m.id !== 'app')
    .map((m) => ({
      label: m.label.replace('&', ''),
      submenu: commandMenuItems(
        m.items
          .filter((it: MenuEntry) => it.type === 'separator' || ((it.type === undefined || it.type === 'command') && ids.has((it as { command: string }).command)))
          .map((it) => (it.type === 'separator' ? 'separator' : { command: (it as { command: string }).command, optional: (it as { optional?: boolean }).optional })),
      ),
    }))
    .filter((m) => m.submenu.length > 0);
}

export function TopBar({ theme }: { theme: EffectiveTheme }) {
  useCommandContext();
  const pref = useSettings((s) => s.settings.theme);
  const explorerVisible = useUi((s) => s.explorerVisible);
  const browser = getPlatform().kind === 'browser';
  const nextTheme = pref === 'system' ? (theme === 'dark' ? 'light' : 'dark') : pref === 'dark' ? 'light' : 'system';
  const ThemeIcon = pref === 'system' ? SunMoon : theme === 'dark' ? Moon : Sun;
  const gotoShortcut = getCommand('view.goToObject')?.shortcut;

  return (
    <header className="topbar" aria-label="Application">
      <div className="brand" aria-label="DbStudio">
        <span className="brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="8" className="brand-bg" />
            <ellipse cx="16" cy="9.5" rx="8" ry="3.2" className="brand-fg-fill" />
            <path d="M8 9.5v13c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-13M8 16c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" fill="none" className="brand-fg-stroke" strokeWidth="2.2" />
          </svg>
        </span>
        <span className="brand-name">DbStudio</span>
      </div>
      {browser && (
        <button className="icon-btn" title="Menu" aria-label="Application menu" aria-haspopup="menu" onClick={(e) => showMenuBelow(e.currentTarget, appMenuItems())}>
          <MenuIcon size={16} strokeWidth={1.5} />
        </button>
      )}
      <CommandButton command="view.toggleSidebar" icon={<PanelLeft size={16} strokeWidth={1.5} />} className={explorerVisible ? 'on' : ''} />
      <div className="topbar-sep" />
      {/* On a narrow bar (high zoom, small window) these become icon buttons; the label stays their accessible name
          (shell.css, styles-r2-01). */}
      <CommandButton command="file.newConsole" icon={<SquareTerminal size={16} strokeWidth={1.5} />} label="Console" variant="ghost" className="topbar-text-btn" />
      <CommandButton command="file.newConnection" icon={<Plus size={16} strokeWidth={1.5} />} label="Connection" variant="ghost" className="topbar-text-btn" />
      <div className="flex-1 topbar-drag" />
      <button
        type="button"
        className="palette-trigger"
        onClick={() => useUi.getState().openPalette('objects')}
        title={withShortcut('Go to object, or type > for commands', gotoShortcut)}
        aria-label="Go to object or command"
        aria-keyshortcuts={ariaKeyShortcuts(gotoShortcut)}
      >
        <Search size={14} strokeWidth={1.5} />
        <span className="palette-trigger-text">Go to object or command</span>
        <Kbd shortcut={gotoShortcut} />
      </button>
      <div className="flex-1 topbar-drag" />
      <button className="icon-btn" title={`Theme: ${pref} — click for ${nextTheme}`} aria-label={`Theme ${pref}, switch to ${nextTheme}`} onClick={() => useSettings.getState().update({ theme: nextTheme })}>
        <ThemeIcon size={16} strokeWidth={1.5} />
      </button>
      <CommandButton command="view.shortcuts" icon={<Keyboard size={16} strokeWidth={1.5} />} />
      <CommandButton command="view.settings" icon={<Settings size={16} strokeWidth={1.5} />} />
    </header>
  );
}

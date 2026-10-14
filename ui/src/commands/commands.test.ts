// QA (section 5.3): every menu, toolbar and context-menu item is a registered command with the same title and
// shortcut; zero shortcut conflicts; key handling is platform-aware.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initCommands, loadedCommandModules } from '.';
import { LEGACY_IDS } from './core';
import { resolveKey, scopesFor } from './dispatcher';
import { displayShortcut, eventStroke, normalizeShortcut, setPlatformForTests, shortcutKeys, toAccelerator } from './keys';
import { CONSOLE_TOOLBAR, CONTEXT_MENUS, MENUS, TOPBAR, menuCommandIds, type ContextEntry } from './menuModel';
import { findConflicts, getCommand, listBindings, listCommands, registerCommand, resolveId } from './registry';

beforeAll(() => initCommands(), 60_000);
afterEach(() => setPlatformForTests(null));

/** Package folders whose commands.ts makes their optional menu items mandatory. */
function ownerLoaded(id: string): boolean {
  const mods = loadedCommandModules().join(' ');
  const owner: Record<string, RegExp> = {
    'data.': /DataTab|filter/, 'grid.': /DataTab|Grid|filter/, 'designer.': /designer/, 'codegen.': /codegen|Codegen/,
    'format.': /format|editor/, 'snippet': /snippets|editor/, 'explain.': /PlanView|format|editor/, 'params.': /ParamsDialog|src\/params\//,
  };
  const re = Object.entries(owner).find(([p]) => id.startsWith(p))?.[1];
  return !!re && re.test(mods);
}

function check(entries: readonly ContextEntry[], where: string) {
  for (const e of entries) {
    if (e === 'separator') continue;
    const c = getCommand(e.command);
    if (e.optional && !c && !ownerLoaded(e.command)) continue;
    expect(c, `${where}: ${e.command} is not a registered command`).toBeDefined();
  }
}

describe('command coverage', () => {
  it('registers the shell commands', () => {
    expect(listCommands().length).toBeGreaterThan(80);
    for (const id of ['run.multi', 'connections.showActive', 'view.goToObject', 'view.shortcuts', 'connections.change', 'connections.changeDatabase']) {
      expect(getCommand(id), id).toBeDefined();
    }
  });

  for (const platform of ['win32', 'darwin'] as const) {
    it(`every native menu item (${platform}) is a command with the same title and shortcut`, () => {
      for (const it of menuCommandIds(platform)) {
        const c = getCommand(it.command);
        if (!c && it.optional && !ownerLoaded(it.command)) continue;
        expect(c, `menu ${it.command}`).toBeDefined();
        // About gets the version appended natively; everything else matches the palette title.
        expect(it.label, it.command).toBe(c!.title);
        expect(it.shortcut ? normalizeShortcut(it.shortcut) : undefined, `${it.command} shortcut`).toBe(c!.shortcut ? normalizeShortcut(c!.shortcut) : undefined);
      }
    });
  }

  it('every context-menu item is a command', () => {
    for (const [id, entries] of Object.entries(CONTEXT_MENUS)) check(entries, `context ${id}`);
  });

  it('every toolbar and top-bar item is a command', () => {
    check(CONSOLE_TOOLBAR, 'console toolbar');
    check(TOPBAR, 'top bar');
  });

  it('M1 native-menu ids resolve to commands', () => {
    for (const legacy of Object.keys(LEGACY_IDS)) expect(getCommand(legacy), legacy).toBeDefined();
    expect(resolveId('newQueryTab')).toBe('file.newConsole');
  });

  it('menus only use known roles or commands', () => {
    for (const m of MENUS) for (const it of m.items) expect(['command', 'role', 'native', 'separator', undefined]).toContain(it.type);
  });
});

describe('shortcuts', () => {
  it('has zero conflicts (same key, same scope)', () => {
    expect(findConflicts()).toEqual([]);
  });

  it('binds the reserved shortcuts of section 3', () => {
    const byKey = new Map(listBindings().filter((b) => b.scope === 'global').map((b) => [b.key, b.commandId]));
    const expected: Record<string, string> = {
      'Mod+N': 'file.newConsole', 'Mod+Shift+N': 'file.newConnection', 'Mod+P': 'view.goToObject', 'Mod+Shift+P': 'view.commandPalette',
      'Mod+Enter': 'run.statement', F5: 'run.script', 'Shift+F5': 'run.cancel', 'Mod+Alt+Enter': 'run.multi', 'Mod+Shift+K': 'connections.change',
      'Mod+Shift+D': 'connections.changeDatabase', 'Mod+B': 'view.toggleSidebar', 'Mod+R': 'view.toggleResults', 'Mod+Shift+H': 'view.history',
      'Mod+Shift+T': 'tab.reopenClosed', 'Mod+1': 'tab.goto1', 'Mod+,': 'view.settings', F1: 'view.shortcuts', 'Mod+K Mod+S': 'view.shortcuts',
    };
    for (const [k, id] of Object.entries(expected)) expect(byKey.get(normalizeShortcut(k)), k).toBe(id);
  });

  it('detects a conflict at registration', () => {
    const dispose = registerCommand({ id: 'test.dup', title: 'Dup', category: 'Test', shortcut: 'Mod+Shift+P', run: () => {} });
    expect(findConflicts().some((c) => c.commands.includes('test.dup'))).toBe(true);
    dispose();
    expect(findConflicts()).toEqual([]);
  });

  it('displays Ctrl+… on Windows and glyphs on macOS', () => {
    setPlatformForTests(false);
    expect(displayShortcut('Mod+Shift+P')).toBe('Ctrl+Shift+P');
    expect(displayShortcut('Mod+K Mod+S')).toBe('Ctrl+K Ctrl+S');
    expect(shortcutKeys('Mod+Alt+Enter')).toEqual(['Ctrl', 'Alt', 'Enter']);
    setPlatformForTests(true);
    expect(displayShortcut('Mod+Shift+P')).toBe('⇧⌘P');
    expect(displayShortcut('Mod+Alt+Enter')).toBe('⌥⌘↩');
    expect(displayShortcut('MacCtrl+Tab')).toBe('⌃⇥');
    expect(toAccelerator('Mod+Shift+P')).toBe('CmdOrCtrl+Shift+P');
  });

  it('maps keyboard events per platform (Cmd = Mod on macOS, Ctrl = Mod on Windows)', () => {
    const ev = (o: Partial<KeyboardEvent>) => ({ key: 'p', code: 'KeyP', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    setPlatformForTests(true);
    expect(eventStroke(ev({ metaKey: true }))).toBe('ctrl+p');
    expect(eventStroke(ev({ ctrlKey: true }))).toBe('macctrl+p');
    setPlatformForTests(false);
    expect(eventStroke(ev({ ctrlKey: true }))).toBe('ctrl+p');
    expect(eventStroke(ev({ ctrlKey: true, shiftKey: true, key: 'P' }))).toBe('ctrl+shift+p');
  });

  it('scopes: the innermost scope wins; the editor keeps its own keys', () => {
    const div = document.createElement('div');
    div.setAttribute('data-command-scope', 'explorer');
    const inner = document.createElement('input');
    div.appendChild(inner);
    document.body.appendChild(div);
    expect(scopesFor(inner)).toEqual(['explorer', 'global']);
    expect(resolveKey('ctrl+f', ['explorer', 'global'])).toBe('explorer.focusFilter');
    expect(resolveKey('ctrl+f', ['global'])).toBeNull();
    // Mod+Enter runs from outside the editor but is left to Monaco inside it.
    expect(resolveKey('ctrl+enter', ['editor', 'global'], { editor: true })).toBeNull();
    expect(resolveKey('ctrl+shift+p', ['editor', 'global'], { editor: true })).toBe('view.commandPalette');
    div.remove();
  });
});

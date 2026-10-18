// QA (section 5.3): every menu, toolbar and context-menu item is a registered command with the same title and
// shortcut; zero shortcut conflicts; key handling is platform-aware.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerEditor } from '../app/editors';
import type { SqlEditorHandle } from '../editor/SqlEditor.types';
import { initCommands, loadedCommandModules } from '.';
import { LEGACY_IDS } from './core';
import { installKeyDispatcher, resolveKey, scopesFor } from './dispatcher';
import { displayShortcut, eventStroke, FORMAT_ALT_SHORTCUT, isAltGraphCharacter, normalizeShortcut, setPlatformForTests, shortcutKeys, toAccelerator, tooltipWithShortcut } from './keys';
import { CONSOLE_TOOLBAR, CONTEXT_MENUS, MENUS, TOPBAR, menuCommandIds, type ContextEntry } from './menuModel';
import { DATATAB_TOOLBAR, GRID_CELL_EDIT_MENU, GRID_CELL_PENDING_MENU, GRID_COPY_AS_MENU, GRID_EXPORT_MENU, GRID_SAVE_MENU, RESULTS_TOOLBAR } from '../components/ResultsPane/toolbarModel';
import { commandMenuItems, hasCommandIcon } from '../components/layout/commandMenu';
import { advertisedShortcuts, findConflicts, getCommand, listBindings, listCommands, registerCommand, resolveId } from './registry';
import { commandView } from './useCommands';

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

/** Command entries of a menu model, submenus flattened. */
function commandEntries(entries: readonly ContextEntry[]): Extract<ContextEntry, { command: string }>[] {
  const out: Extract<ContextEntry, { command: string }>[] = [];
  for (const e of entries) {
    if (e === 'separator') continue;
    if ('submenu' in e) out.push(...commandEntries(e.entries));
    else out.push(e);
  }
  return out;
}

function check(entries: readonly ContextEntry[], where: string) {
  for (const e of commandEntries(entries)) {
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

  it('every result-grid and Data-tab toolbar/menu item is a command (incl. Code ▾ → codegen.query)', () => {
    check(RESULTS_TOOLBAR, 'results toolbar');
    check(DATATAB_TOOLBAR, 'data tab toolbar');
    check(GRID_COPY_AS_MENU, 'grid copy-as menu');
    check(GRID_EXPORT_MENU, 'grid export menu');
    check(GRID_CELL_EDIT_MENU, 'grid cell edit menu');
    // The result-set "Code ▾" button runs codegen.query with the result set's columns.
    if (ownerLoaded('codegen.query')) expect(getCommand('codegen.query'), 'codegen.query').toBeDefined();
  });

  it('every shell menu item has an icon, and submenus build from commands', () => {
    const shellMenus: [string, readonly ContextEntry[]][] = [...Object.entries(CONTEXT_MENUS), ['console toolbar', CONSOLE_TOOLBAR], ['top bar', TOPBAR]];
    for (const [where, entries] of shellMenus) {
      for (const e of commandEntries(entries)) {
        const c = getCommand(e.command);
        if (!c) continue;
        expect(hasCommandIcon(c.icon), `${where}: ${c.id} (${c.title}) has no icon`).toBe(true);
      }
    }
    // Generate SQL ▸ is a submenu of commands.
    const table = commandMenuItems(CONTEXT_MENUS['explorer.table'], { kind: 'object', connectionId: 'c1', database: null, ref: { database: null, schema: 'main', name: 'T', type: 'table' } });
    const gen = table.find((i) => i.id === 'explorer.generateSql');
    expect(gen?.submenu?.map((i) => i.id)).toEqual(['explorer.generateSelect', 'explorer.generateInsert', 'explorer.generateUpdate', 'explorer.generateDelete']);
  });

  it('palette-only shell commands have unique titles', () => {
    const seen = new Map<string, string>();
    for (const c of listCommands()) {
      if (c.palette === false) continue;
      const k = `${c.category}: ${c.title}`.toLowerCase();
      expect(seen.get(k), `${c.id} and ${seen.get(k)} are both "${k}"`).toBeUndefined();
      seen.set(k, c.id);
    }
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

  it('scoped shortcuts never shadow a global or native-menu accelerator (cross-scope collisions)', () => {
    // A scoped binding wins while focus is in its scope, so it must not reuse a key that means something else
    // app-wide (or that the native menu grabs first in the desktop build). Intentional, documented overrides only:
    const INTENTIONAL: Record<string, string> = {
      // F5 in the explorer refreshes the selected node (DataGrip/SSMS); there is no script to run there.
      'explorer.refresh|f5': 'run.script',
      // F5 in a Data tab reloads its rows; there is no script to run there.
      'dataTab.reload|f5': 'run.script',
      // F4 in a Data tab designs its table: the same action as the global Design / edit object.
      'dataTab.design|f4': 'designer.edit',
      // Ctrl+S saves what has focus: pending grid edits, the open designer (the console's file otherwise).
      'grid.submitChanges|ctrl+s': 'file.save',
      'grid.submitFromEditor|ctrl+s': 'file.save',
      'designer.apply|ctrl+s': 'file.save',
      // Ctrl+Shift+Enter in a result grid re-runs its query with the filter applied (the console's run-script key).
      'grid.applyServerFilter|ctrl+shift+enter': 'run.script',
    };
    const natives = new Map<string, string>();
    for (const it of [...menuCommandIds('win32'), ...menuCommandIds('darwin')]) if (it.shortcut) natives.set(normalizeShortcut(it.shortcut), it.command);
    const globals = new Map<string, string>();
    for (const b of listBindings()) if (b.scope === 'global') globals.set(b.key, b.commandId);
    const collisions: string[] = [];
    for (const b of listBindings()) {
      if (b.scope === 'global') continue;
      const other = globals.get(b.key) ?? natives.get(b.key);
      if (!other || other === b.commandId) continue;
      const k = `${b.commandId}|${b.key}`;
      if (INTENTIONAL[k] === other) continue;
      collisions.push(`${b.display} (${b.scope}: ${b.commandId}) collides with ${other}`);
    }
    expect(collisions).toEqual([]);
  });

  it('Set NULL is not Ctrl+0 (that is Reset zoom)', () => {
    const setNull = getCommand('grid.setNull');
    // design-13: Set NULL is Mod+Alt+N (components/DataTab/commands.ts).
    if (setNull?.shortcut) expect(normalizeShortcut(setNull.shortcut)).toBe(normalizeShortcut('Mod+Alt+N'));
    expect(getCommand('view.zoomReset')?.shortcut).toBe('Mod+0');
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

  it('prints modifiers in one canonical order: Ctrl, Shift, Alt on Windows (as Monaco does), ⌃⌥⇧⌘ on macOS', () => {
    setPlatformForTests(false);
    // however the shortcut is written, the label matches the Monaco context menu ("Shift+Alt+F")
    expect(displayShortcut('Shift+Alt+F')).toBe('Shift+Alt+F');
    expect(displayShortcut('Alt+Shift+F')).toBe('Shift+Alt+F');
    expect(displayShortcut('Mod+Alt+Shift+K')).toBe('Ctrl+Shift+Alt+K');
    expect(displayShortcut('Mod+Alt+L')).toBe('Ctrl+Alt+L');
    expect(shortcutKeys('Shift+Alt+F')).toEqual(['Shift', 'Alt', 'F']);
    expect(shortcutKeys('Mod+K Shift+Alt+F')).toEqual(['Ctrl', 'K', null, 'Shift', 'Alt', 'F']);
    setPlatformForTests(true);
    expect(displayShortcut('Shift+Alt+F')).toBe('⌥⇧F');
    expect(displayShortcut('Mod+Alt+Shift+K')).toBe('⌥⇧⌘K');
    expect(displayShortcut('MacCtrl+Shift+Mod+K')).toBe('⌃⇧⌘K');
  });

  it('never doubles parentheses in a tooltip (design-r1-07)', () => {
    setPlatformForTests(false);
    expect(tooltipWithShortcut('Run', 'Ctrl+Enter')).toBe('Run (Ctrl+Enter)');
    expect(tooltipWithShortcut('Explain plan (estimated)', 'Ctrl+L')).toBe('Explain plan (estimated) · Ctrl+L');
    expect(tooltipWithShortcut('Explain plan (estimated)', '')).toBe('Explain plan (estimated)');
    expect(getCommand('explain.estimated'), 'plan commands are loaded').toBeDefined();
    expect(commandView('explain.estimated').tooltip).toBe('Explain plan (estimated) · Ctrl+L');
    expect(commandView('explain.actual').tooltip).toBe(`${getCommand('explain.actual')!.title} · Ctrl+Shift+L`);
    setPlatformForTests(true);
    expect(commandView('explain.estimated').tooltip).toBe('Explain plan (estimated) · ⌘L');
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

describe('Format SQL shortcut (user-01)', () => {
  it('Ctrl+Alt+L (⌘⌥L) is a second binding of format.document, next to Shift+Alt+F, without conflicts', () => {
    const c = getCommand('format.document');
    expect(c, 'editor commands are loaded').toBeDefined();
    expect(c?.shortcut).toBe('Shift+Alt+F');
    expect(c?.altShortcuts).toContain(FORMAT_ALT_SHORTCUT);
    const keys = listBindings().filter((b) => b.commandId === 'format.document').map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(['alt+shift+f', 'ctrl+alt+l']));
    // nothing else uses Ctrl+Alt+L in any scope, and no global / native-menu accelerator either
    expect(listBindings().filter((b) => b.key === 'ctrl+alt+l').map((b) => b.commandId)).toEqual(['format.document']);
    expect(findConflicts()).toEqual([]);
    for (const p of ['win32', 'darwin'] as const) {
      expect(menuCommandIds(p).filter((m) => m.shortcut && normalizeShortcut(m.shortcut) === 'ctrl+alt+l' && m.command !== 'format.document')).toEqual([]);
    }
    setPlatformForTests(true);
    expect(displayShortcut(FORMAT_ALT_SHORTCUT)).toBe('⌥⌘L');
  });

  it('shows both shortcuts in the tooltip, menus and palette', () => {
    expect(getCommand('format.document'), 'editor commands are loaded').toBeDefined();
    setPlatformForTests(false);
    expect(advertisedShortcuts(getCommand('format.document')!)).toEqual(['Shift+Alt+F', 'Mod+Alt+L']);
    expect(commandView('format.document').tooltip).toBe('Format SQL (Shift+Alt+F or Ctrl+Alt+L)');
    const [item] = commandMenuItems([{ command: 'format.document' }]);
    expect(item.shortcut).toBe('Shift+Alt+F');
    expect(item.extraShortcuts).toEqual(['Mod+Alt+L']);
    // commands that do not advertise their alternatives keep a single shortcut in tooltips
    expect(commandView('file.newConsole').tooltip).toBe(`${getCommand('file.newConsole')!.title} (Ctrl+N)`);
  });

  it('Ctrl+Alt+L inside a console formats its editor; AltGr+L typing "ł" does not', () => {
    expect(getCommand('format.document'), 'editor commands are loaded').toBeDefined();
    setPlatformForTests(false);
    const formatDocument = vi.fn(() => 0);
    const focus = vi.fn();
    registerEditor('tab-fmt', { formatDocument, focus } as unknown as SqlEditorHandle);
    const consoleEl = document.createElement('div');
    consoleEl.className = 'console';
    consoleEl.dataset.tab = 'tab-fmt';
    consoleEl.setAttribute('data-command-scope', 'console');
    const btn = document.createElement('button');
    consoleEl.appendChild(btn);
    document.body.appendChild(consoleEl);
    const uninstall = installKeyDispatcher();
    try {
      btn.focus();
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      expect(formatDocument).toHaveBeenCalledTimes(1);
      // Polish keyboard: AltGr (reported as Ctrl+Alt) + L types "ł"
      const altGr = new KeyboardEvent('keydown', { key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
      btn.dispatchEvent(altGr);
      expect(formatDocument).toHaveBeenCalledTimes(1);
      expect(altGr.defaultPrevented).toBe(false);
      // the original binding still works
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, altKey: true, bubbles: true, cancelable: true }));
      expect(formatDocument).toHaveBeenCalledTimes(2);
    } finally {
      uninstall();
      registerEditor('tab-fmt', null);
      consoleEl.remove();
    }
  });

  it('isAltGraphCharacter: only Ctrl+Alt key presses that type another character', () => {
    const ev = (o: Partial<KeyboardEvent>) => ({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, metaKey: false, ...o });
    expect(isAltGraphCharacter(ev({}), false)).toBe(false);
    expect(isAltGraphCharacter(ev({ key: 'L' }), false)).toBe(false);
    expect(isAltGraphCharacter(ev({ key: 'ł' }), false)).toBe(true);
    expect(isAltGraphCharacter(ev({ key: '{', code: 'Digit7' }), false)).toBe(true); // German AltGr+7
    expect(isAltGraphCharacter(ev({ key: 'ArrowRight', code: 'ArrowRight' }), false)).toBe(false);
    expect(isAltGraphCharacter(ev({ key: 'ł', ctrlKey: false }), false)).toBe(false);
    expect(isAltGraphCharacter(ev({ key: '¬' }), true)).toBe(false); // macOS: ⌥ produces characters, ⌘⌥L is a shortcut
  });
});

describe('grid save menus (user-02)', () => {
  it('every save / preview / copy-SQL entry is a registered command', () => {
    check(GRID_CELL_PENDING_MENU, 'grid cell pending menu');
    check(GRID_SAVE_MENU, 'save button menu');
    expect(getCommand('grid.submitChanges')).toBeDefined();
    // saving is direct now: no "…" (that promised a dialog)
    expect(getCommand('grid.submitChanges')!.title).toBe('Save pending changes');
    expect(getCommand('grid.previewChanges')!.title).toBe('Preview SQL of pending changes…');
    expect(getCommand('grid.copyChangesSql')).toBeDefined();
  });
});

// "Trigger suggest" key routing: Ctrl+Space (and the layout-safe Ctrl+I) reach Monaco untouched inside every editor
// (consoles, F4 edit consoles, designer / wizard editors), and from elsewhere in a console (toolbar, messages, a
// closed dialog's return focus) they focus the console's editor and open IntelliSense. The results grid keeps its own
// Ctrl+Space (select column).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerEditor } from '../app/editors';
import type { SqlEditorHandle } from '../editor/SqlEditor.types';
import { initCommands } from '.';
import { installKeyDispatcher } from './dispatcher';
import { setPlatformForTests } from './keys';
import { findConflicts, getCommand, listBindings } from './registry';

beforeAll(() => initCommands(), 60_000);
afterEach(() => {
  setPlatformForTests(null);
  document.body.innerHTML = '';
});

function consoleFixture(tab: string) {
  const triggerSuggest = vi.fn();
  const focus = vi.fn();
  registerEditor(tab, { triggerSuggest, focus } as unknown as SqlEditorHandle);
  const consoleEl = document.createElement('div');
  consoleEl.className = 'console';
  consoleEl.dataset.tab = tab;
  consoleEl.setAttribute('data-command-scope', 'console');
  const toolbarBtn = document.createElement('button');
  const monacoEl = document.createElement('div');
  monacoEl.className = 'monaco-editor';
  const textarea = document.createElement('textarea'); // Monaco's input area
  monacoEl.appendChild(textarea);
  const grid = document.createElement('canvas');
  grid.tabIndex = 0;
  grid.setAttribute('data-testid', 'data-grid-canvas');
  consoleEl.append(toolbarBtn, monacoEl, grid);
  document.body.appendChild(consoleEl);
  return { triggerSuggest, focus, toolbarBtn, textarea, grid, dispose: () => registerEditor(tab, null) };
}

const ctrlSpace = () => new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true });
const ctrlI = () => new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, bubbles: true, cancelable: true });

describe('Trigger suggest routing', () => {
  it('is a console command on Ctrl+Space with Ctrl+I as the alternative, listed in the shortcut sheet, no conflicts', () => {
    setPlatformForTests(false);
    const c = getCommand('editor.triggerSuggest');
    expect(c).toBeDefined();
    expect(c!.scope).toBe('console');
    const keys = listBindings().filter((b) => b.commandId === 'editor.triggerSuggest').map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(['ctrl+space', 'ctrl+i']));
    expect(findConflicts()).toEqual([]);
  });

  it('from the console toolbar: focuses the console editor and opens IntelliSense (Ctrl+Space and Ctrl+I)', () => {
    setPlatformForTests(false);
    const f = consoleFixture('tab-sugg-1');
    const uninstall = installKeyDispatcher();
    try {
      f.toolbarBtn.focus();
      const e = ctrlSpace();
      f.toolbarBtn.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(f.focus).toHaveBeenCalled();
      expect(f.triggerSuggest).toHaveBeenCalledTimes(1);
      f.toolbarBtn.dispatchEvent(ctrlI());
      expect(f.triggerSuggest).toHaveBeenCalledTimes(2);
    } finally {
      uninstall();
      f.dispose();
    }
  });

  it('inside a console editor: the dispatcher leaves Ctrl+Space / Ctrl+I to Monaco', () => {
    setPlatformForTests(false);
    const f = consoleFixture('tab-sugg-2');
    const uninstall = installKeyDispatcher();
    try {
      f.textarea.focus();
      for (const e of [ctrlSpace(), ctrlI()]) {
        f.textarea.dispatchEvent(e);
        expect(e.defaultPrevented, e.code).toBe(false);
      }
      expect(f.triggerSuggest).not.toHaveBeenCalled();
    } finally {
      uninstall();
      f.dispose();
    }
  });

  it('inside a designer / wizard editor (no console around it): nothing swallows Ctrl+Space', () => {
    setPlatformForTests(false);
    const host = document.createElement('div');
    host.setAttribute('data-command-scope', 'designer');
    const monacoEl = document.createElement('div');
    monacoEl.className = 'monaco-editor';
    const ta = document.createElement('textarea');
    monacoEl.appendChild(ta);
    host.appendChild(monacoEl);
    document.body.appendChild(host);
    const uninstall = installKeyDispatcher();
    try {
      ta.focus();
      const e = ctrlSpace();
      ta.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it('on the results grid: Ctrl+Space stays the grid\'s (select column)', () => {
    setPlatformForTests(false);
    const f = consoleFixture('tab-sugg-3');
    const uninstall = installKeyDispatcher();
    try {
      f.grid.focus();
      const e = ctrlSpace();
      f.grid.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(f.triggerSuggest).not.toHaveBeenCalled();
    } finally {
      uninstall();
      f.dispose();
    }
  });

  it('macOS: ⌃Space (the physical Control key) and ⌘I', () => {
    setPlatformForTests(true);
    const f = consoleFixture('tab-sugg-4');
    const uninstall = installKeyDispatcher();
    try {
      f.toolbarBtn.focus();
      f.toolbarBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true }));
      f.toolbarBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', metaKey: true, bubbles: true, cancelable: true }));
      expect(f.triggerSuggest).toHaveBeenCalledTimes(2);
    } finally {
      uninstall();
      f.dispose();
    }
  });
});

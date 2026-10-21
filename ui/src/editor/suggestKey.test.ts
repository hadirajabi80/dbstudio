// @vitest-environment jsdom
// Ctrl+Space / Ctrl+I "Trigger suggest" (editor/suggestKey.ts): it always does something, including while the widget
// shows its "No suggestions." / "Loading…" message (where Monaco's own binding is disabled), and follow-up / refresh
// triggers are automatic so they never open an empty box.
import { describe, expect, it, vi } from 'vitest';
import { followUpPayload, refreshSuggest, suggestKeyAction, suggestKeyState, triggerSuggest } from './suggestKey';
import { SUGGEST_CONTROLLER_ID } from './suggest-guard';

type WidgetState = 'none' | 'list' | 'message' | 'frozen';

function fakeEditor(widget: WidgetState, opts: { readOnly?: boolean; controller?: boolean } = {}) {
  const dom = document.createElement('div');
  dom.className = 'monaco-editor';
  if (widget !== 'none') {
    const w = document.createElement('div');
    w.className = `suggest-widget visible${widget === 'message' ? ' message' : ''}${widget === 'frozen' ? ' frozen' : ''}`;
    if (widget !== 'message') {
      const row = document.createElement('div');
      row.className = 'monaco-list-row focused';
      w.appendChild(row);
    }
    dom.appendChild(w);
  }
  const ctrl = { triggerSuggest: vi.fn() };
  const ed = {
    getDomNode: () => dom,
    getRawOptions: () => ({ readOnly: !!opts.readOnly }),
    getContribution: (id: string) => (id === SUGGEST_CONTROLLER_ID && opts.controller !== false ? ctrl : null),
    trigger: vi.fn(),
    focus: vi.fn(),
  };
  return { ed, ctrl };
}

describe('suggestKeyAction', () => {
  it('toggles the details of a focused suggestion, else (re)triggers; nothing in a read-only editor', () => {
    expect(suggestKeyAction({ readOnly: false, widgetVisible: false, focusedItem: false })).toBe('trigger');
    expect(suggestKeyAction({ readOnly: false, widgetVisible: true, focusedItem: true })).toBe('toggleDetails');
    expect(suggestKeyAction({ readOnly: false, widgetVisible: true, focusedItem: false })).toBe('trigger');
    expect(suggestKeyAction({ readOnly: true, widgetVisible: false, focusedItem: false })).toBe('none');
  });

  it('reads the widget state from the editor', () => {
    expect(suggestKeyState(fakeEditor('none').ed)).toEqual({ readOnly: false, widgetVisible: false, focusedItem: false });
    expect(suggestKeyState(fakeEditor('list').ed)).toEqual({ readOnly: false, widgetVisible: true, focusedItem: true });
    expect(suggestKeyState(fakeEditor('message').ed)).toEqual({ readOnly: false, widgetVisible: true, focusedItem: false });
    expect(suggestKeyState(fakeEditor('frozen').ed).focusedItem).toBe(false);
  });
});

describe('triggerSuggest', () => {
  it('opens IntelliSense explicitly when nothing is open', () => {
    const { ed, ctrl } = fakeEditor('none');
    expect(triggerSuggest(ed)).toBe('trigger');
    expect(ed.focus).toHaveBeenCalled();
    expect(ctrl.triggerSuggest).toHaveBeenCalledWith(undefined, false);
  });

  it('replaces a "No suggestions." / "Loading…" box with a fresh request (Monaco\'s own Ctrl+Space is disabled there)', () => {
    const { ed, ctrl } = fakeEditor('message');
    expect(triggerSuggest(ed)).toBe('trigger');
    expect(ed.trigger).toHaveBeenCalledWith('dbstudio', 'hideSuggestWidget', {});
    expect(ctrl.triggerSuggest).toHaveBeenCalledWith(undefined, false);
  });

  it('refreshes a frozen list instead of toggling its details', () => {
    const { ed, ctrl } = fakeEditor('frozen');
    expect(triggerSuggest(ed)).toBe('trigger');
    expect(ctrl.triggerSuggest).toHaveBeenCalled();
  });

  it('keeps Monaco\'s behaviour on a live list: Ctrl+Space shows / hides the details panel', () => {
    const { ed, ctrl } = fakeEditor('list');
    expect(triggerSuggest(ed)).toBe('toggleDetails');
    expect(ed.trigger).toHaveBeenCalledWith('dbstudio', 'toggleSuggestionDetails', {});
    expect(ctrl.triggerSuggest).not.toHaveBeenCalled();
  });

  it('falls back to the action without the controller, and does nothing read-only', () => {
    const a = fakeEditor('none', { controller: false });
    triggerSuggest(a.ed);
    expect(a.ed.trigger).toHaveBeenCalledWith('dbstudio', 'editor.action.triggerSuggest', {});
    const b = fakeEditor('none', { readOnly: true });
    expect(triggerSuggest(b.ed)).toBe('none');
    expect(b.ctrl.triggerSuggest).not.toHaveBeenCalled();
  });
});

describe('automatic follow-ups never open an empty box', () => {
  it('a schema / database / package item re-triggers suggest automatically', () => {
    expect(followUpPayload('editor.action.triggerSuggest')).toEqual({ auto: true });
    expect(followUpPayload('editor.action.triggerParameterHints')).toEqual({});
  });

  it('the catalog refresh of a "Loading <schema>…" list runs only while the widget is open, automatically', () => {
    const open = fakeEditor('list');
    expect(refreshSuggest(open.ed)).toBe(true);
    expect(open.ctrl.triggerSuggest).toHaveBeenCalledWith(undefined, true);
    const closed = fakeEditor('none');
    expect(refreshSuggest(closed.ed)).toBe(false);
    expect(closed.ctrl.triggerSuggest).not.toHaveBeenCalled();
  });

  it('also refreshes a session whose result has not rendered yet (the catalog answered first)', () => {
    const pending = fakeEditor('none');
    (pending.ctrl as unknown as { model: { state: number } }).model = { state: 2 };
    expect(refreshSuggest(pending.ed)).toBe(true);
    expect(pending.ctrl.triggerSuggest).toHaveBeenCalledWith(undefined, true);
  });
});

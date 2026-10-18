// features-17: the routine/trigger wizard. Trigger timings per table/view, the trigger's default table (explorer table
// nodes only) and leaving snippet (tab-stop) mode before a run so F5 / Run takes the whole CREATE script.
import { describe, expect, it, vi } from 'vitest';
import * as monaco from '../../editor/monaco';
import { useExplorer } from '../../components/Explorer/explorerStore';
import { explorerTable } from '../commands';
import { guardRunInSnippetMode, isInSnippetMode, leaveSnippetMode } from '../snippet';
import { defaultTiming, triggerTimings } from './templates';

describe('trigger timings', () => {
  it('a view only takes INSTEAD OF', () => {
    for (const d of ['tsql', 'plsql', 'sqlite'] as const) {
      expect(triggerTimings(d, true)).toEqual(['INSTEAD OF']);
      expect(defaultTiming(d, true)).toBe('INSTEAD OF');
    }
  });

  it('tables: SQL Server AFTER / INSTEAD OF, SQLite and Oracle BEFORE / AFTER', () => {
    expect(triggerTimings('tsql', false)).toEqual(['AFTER', 'INSTEAD OF']);
    expect(triggerTimings('sqlite', false)).toEqual(['BEFORE', 'AFTER']);
    expect(triggerTimings('plsql', false)).toEqual(['BEFORE', 'AFTER']);
    expect(defaultTiming('tsql', false)).toBe('AFTER');
    expect(defaultTiming('sqlite', false)).toBe('AFTER');
    expect(defaultTiming('plsql', false)).toBe('BEFORE');
  });
});

describe('default trigger table', () => {
  const obj = (type: 'table' | 'view') => ({ kind: 'object' as const, connectionId: 'c', database: null, ref: { database: null, schema: 'main', name: type === 'table' ? 'Orders' : 'vActiveCustomers', type } });

  it('comes from a table node only', () => {
    expect(explorerTable(obj('table'))).toBe('Orders');
    expect(explorerTable(obj('view'))).toBeNull();
    expect(explorerTable({ kind: 'container', connectionId: 'c', database: null, schema: 'main', objectType: 'trigger' as const })).toBeNull();
  });

  it('ignores the active tab (a view designer tab must not pre-fill the wizard)', () => {
    expect(explorerTable({ kind: 'tab', tabId: 't1' })).toBeNull();
  });

  it('without args, uses the explorer selection when it is a table', () => {
    const prev = useExplorer.getState().selectedTarget;
    try {
      useExplorer.setState({ selectedTarget: obj('table') } as never);
      expect(explorerTable()).toBe('Orders');
      useExplorer.setState({ selectedTarget: obj('view') } as never);
      expect(explorerTable()).toBeNull();
    } finally {
      useExplorer.setState({ selectedTarget: prev } as never);
    }
  });
});

describe('leaving snippet mode before a run', () => {
  function fakeEditor(inSnippet: boolean) {
    let sel = new monaco.Selection(3, 5, 3, 20); // the selected placeholder
    const ctl = { insert: vi.fn(), isInSnippet: vi.fn(() => inSnippet), cancel: vi.fn(() => (inSnippet = false)) };
    const ed = {
      getContribution: () => ctl,
      getPosition: () => new monaco.Position(3, 20),
      setSelection: (s: monaco.Selection) => {
        sel = s;
      },
      getSelection: () => sel,
    } as unknown as monaco.editor.ICodeEditor;
    return { ed, ctl, selection: () => sel };
  }

  it('cancels tab-stop mode and collapses the placeholder selection', () => {
    const f = fakeEditor(true);
    expect(isInSnippetMode(f.ed)).toBe(true);
    expect(leaveSnippetMode(f.ed)).toBe(true);
    expect(f.ctl.cancel).toHaveBeenCalledWith(false);
    expect(f.selection().isEmpty()).toBe(true);
    expect(isInSnippetMode(f.ed)).toBe(false);
  });

  it('F5 / Ctrl+Enter in the editor and focus moving to the Run button leave snippet mode first', () => {
    const key = (keyCode: number, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
      ({ keyCode, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as monaco.IKeyboardEvent;
    for (const [ev, leaves] of [
      [key(monaco.KeyCode.F5), true],
      [key(monaco.KeyCode.Enter, { ctrlKey: true }), true],
      [key(monaco.KeyCode.Enter, { ctrlKey: true, shiftKey: true }), true],
      [key(monaco.KeyCode.Tab), false],
      [key(monaco.KeyCode.Enter), false],
    ] as const) {
      const f = fakeEditor(true);
      let onKey: (e: monaco.IKeyboardEvent) => void = () => undefined;
      Object.assign(f.ed, { onKeyDown: (h: typeof onKey) => (onKey = h), onDidBlurEditorWidget: () => undefined });
      guardRunInSnippetMode(f.ed);
      onKey(ev);
      expect(f.ctl.cancel.mock.calls.length > 0, `keyCode ${ev.keyCode}`).toBe(leaves);
    }
    const f = fakeEditor(true);
    let onBlur = () => undefined as void;
    Object.assign(f.ed, { onKeyDown: () => undefined, onDidBlurEditorWidget: (h: () => void) => (onBlur = h) });
    guardRunInSnippetMode(f.ed);
    const hasFocus = vi.spyOn(document, 'hasFocus');
    hasFocus.mockReturnValue(false); // the window was deactivated: keep the tab stops
    onBlur();
    expect(f.ctl.cancel).not.toHaveBeenCalled();
    hasFocus.mockReturnValue(true); // focus went to the toolbar Run button
    onBlur();
    expect(f.ctl.cancel).toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it('outside snippet mode it leaves a user selection alone (Run selection keeps working)', () => {
    const f = fakeEditor(false);
    expect(leaveSnippetMode(f.ed)).toBe(false);
    expect(f.ctl.cancel).not.toHaveBeenCalled();
    expect(f.selection().isEmpty()).toBe(false);
  });
});

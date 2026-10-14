// Regression test for the SuggestModel re-entrancy TypeError (see suggest-guard.ts).
import { describe, expect, it } from 'vitest';
import suggestModelSource from 'monaco-editor/editor/contrib/suggest/browser/suggestModel.js?raw';
import suggestControllerSource from 'monaco-editor/editor/contrib/suggest/browser/suggestController.js?raw';
import { guardEditorSuggest, guardSuggestModel, SUGGEST_CONTROLLER_ID } from './suggest-guard';

/**
 * A faithful miniature of SuggestModel._onNewContext's "new word started" branch (monaco-editor 0.57,
 * suggestModel.js): `shouldAutoTrigger` force-tokenizes the line, which can flush queued cursor events and
 * re-enter the model; afterwards only `_context` is re-checked before `_completionModel` is dereferenced.
 */
class MiniSuggestModel {
  _context: { leadingWordStart: number } | undefined = { leadingWordStart: 5 };
  _completionModel: { getItemsByProvider(): Map<string, unknown> } | undefined = { getItemsByProvider: () => new Map() };
  triggers = 0;
  /** Simulates the tokens-changed view event flushing the queued cursor event into a nested refilter. */
  reenter: (() => void) | null = null;

  trigger(): void {
    // cancel(retrigger) + new request: context replaced, completion model cleared until the request resolves
    this._completionModel = undefined;
    this._context = { leadingWordStart: 9 };
    this.triggers++;
  }

  private shouldAutoTrigger(): boolean {
    const r = this.reenter;
    this.reenter = null;
    r?.();
    return true;
  }

  _onNewContext(ctx: { leadingWordStart: number }): void {
    if (!this._context) return;
    if (!this._completionModel) return;
    if (ctx.leadingWordStart > this._context.leadingWordStart) {
      const shouldAutoTrigger = this.shouldAutoTrigger();
      if (shouldAutoTrigger && this._context) {
        const map = this._completionModel.getItemsByProvider();
        void map;
        this.trigger();
      }
    }
  }
}

describe('SuggestModel re-entrancy guard', () => {
  it('reproduces the TypeError without the guard', () => {
    const m = new MiniSuggestModel();
    m.reenter = () => m.trigger();
    expect(() => m._onNewContext({ leadingWordStart: 7 })).toThrow(TypeError);
  });

  it('the guard swallows exactly that case and the nested trigger stays in effect', () => {
    const m = new MiniSuggestModel();
    expect(guardSuggestModel(m)).toBe(true);
    m.reenter = () => m.trigger();
    expect(() => m._onNewContext({ leadingWordStart: 7 })).not.toThrow();
    expect(m.triggers).toBe(1);
    expect(m._context).toEqual({ leadingWordStart: 9 });
  });

  it('other errors still surface', () => {
    const m = new MiniSuggestModel();
    guardSuggestModel(m);
    m.reenter = () => { throw new RangeError('boom'); };
    expect(() => m._onNewContext({ leadingWordStart: 7 })).toThrow(RangeError);
  });

  it('is idempotent and installs through the suggest controller', () => {
    const m = new MiniSuggestModel();
    const editor = { getContribution: (id: string) => (id === SUGGEST_CONTROLLER_ID ? { model: m } : null) };
    expect(guardEditorSuggest(editor)).toBe(true);
    const once = m._onNewContext;
    expect(guardEditorSuggest(editor)).toBe(true);
    expect(m._onNewContext).toBe(once);
    expect(guardEditorSuggest({ getContribution: () => null })).toBe(false);
  });

  it('Monaco still has the internals the guard relies on', () => {
    // If this fails after a Monaco upgrade, re-check suggest-guard.ts (the bug may be fixed upstream).
    expect(suggestModelSource).toMatch(/_refilterCompletionItems\(\) \{[\s\S]*?this\._onNewContext\(ctx\)/);
    expect(suggestModelSource).toMatch(/shouldAutoTrigger\(this\._editor\);\s*if \(shouldAutoTrigger && this\._context\) \{[\s\S]*?this\._completionModel\.getItemsByProvider\(\)/);
    expect(suggestControllerSource).toContain(`this.ID = '${SUGGEST_CONTROLLER_ID}'`);
    expect(suggestControllerSource).toMatch(/this\.model = _instantiationService\.createInstance\(SuggestModel/);
  });
});

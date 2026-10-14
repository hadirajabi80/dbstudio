// Guard against a re-entrancy bug in Monaco's SuggestModel (monaco-editor 0.57).
//
// Symptom: `TypeError: Cannot read properties of undefined (reading 'getItemsByProvider')` at
// SuggestModel._onNewContext ← _refilterCompletionItems while typing with the suggest widget open.
//
// Mechanism: on every keystroke the view model emits its outgoing events in order (model content changed, then
// cursor changed). SuggestModel's content listener re-filters (`_refilterCompletionItems` → `_onNewContext`). When
// a new word starts (`foo.Total` after an earlier context, or the leading word moved right) `_onNewContext` calls
// `LineContext.shouldAutoTrigger`, which force-tokenizes the line (`tokenizeIfCheap`). The resulting tokens-changed
// view event flushes the *still queued* outgoing events synchronously, re-entering SuggestModel before the outer
// call has finished; a nested refilter / `trigger()` replaces `_context` and clears `_completionModel`. The outer
// frame re-checks only `this._context` and then dereferences `this._completionModel.getItemsByProvider()`.
// Our editor makes the window wider than plain Monaco: the language tokenizer runs on every line edit, completion
// results are often `incomplete` (unresolved qualifiers), and a space is a trigger character.
//
// Fix: wrap the instance's `_onNewContext`. When the call throws a TypeError *and* the completion model vanished
// during it, the nested call has already re-triggered (or cancelled) the session, so the outer frame has nothing
// left to do and the error is swallowed. Any other error is rethrown.

interface SuggestModelLike {
  _onNewContext?: (ctx: never) => void;
  _completionModel?: unknown;
  __dbstudioGuarded?: boolean;
}

interface EditorLike {
  getContribution(id: string): unknown;
}

export const SUGGEST_CONTROLLER_ID = 'editor.contrib.suggestController';

/** Patch one SuggestModel instance (idempotent). Returns false when Monaco's internals look different. */
export function guardSuggestModel(model: SuggestModelLike | null | undefined): boolean {
  if (!model || typeof model._onNewContext !== 'function') return false;
  if (model.__dbstudioGuarded) return true;
  const original = model._onNewContext as (ctx: unknown) => void;
  const guarded = function (this: SuggestModelLike, ctx: unknown): void {
    const hadModel = this._completionModel !== undefined;
    try {
      original.call(this, ctx);
    } catch (e) {
      if (e instanceof TypeError && hadModel && this._completionModel === undefined) return;
      throw e;
    }
  };
  model._onNewContext = guarded as (ctx: never) => void;
  model.__dbstudioGuarded = true;
  return true;
}

/** Install the guard on an editor's suggest controller. */
export function guardEditorSuggest(editor: EditorLike): boolean {
  const ctrl = editor.getContribution(SUGGEST_CONTROLLER_ID) as { model?: SuggestModelLike } | null;
  return guardSuggestModel(ctrl?.model);
}

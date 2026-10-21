// "Trigger suggest" (Ctrl+Space, and Ctrl+I as the layout-safe alternative; ⌃Space / ⌘I on macOS) that always does
// something. Monaco-free (structural editor type), so the routing is unit-tested without an editor.
//
// Why not Monaco's own binding: `editor.action.triggerSuggest` has the precondition `!suggestWidgetVisible`, and the
// other Ctrl+Space binding, `toggleSuggestionDetails`, needs a focused suggestion. While the widget showed its
// "Loading…" / "No suggestions." message (or a stale, frozen list) Ctrl+Space therefore did nothing at all, and from
// the console toolbar or the results grid nothing handled it either (editor/commands.ts covers that case).
import { SUGGEST_CONTROLLER_ID } from './suggest-guard';

export type SuggestKeyAction = 'none' | 'toggleDetails' | 'trigger';

export interface SuggestKeyState {
  readOnly: boolean;
  /** The suggest widget is on screen (list or message). */
  widgetVisible: boolean;
  /** It shows a live list with a focused row (not a message, not a frozen list). */
  focusedItem: boolean;
}

/** What Ctrl+Space should do: details of the focused suggestion when a live list is open, else (re)trigger. */
export function suggestKeyAction(s: SuggestKeyState): SuggestKeyAction {
  if (s.readOnly) return 'none';
  if (s.widgetVisible && s.focusedItem) return 'toggleDetails';
  return 'trigger';
}

export interface SuggestEditorLike {
  getDomNode(): HTMLElement | null;
  getRawOptions(): { readOnly?: boolean };
  getContribution(id: string): unknown;
  trigger(source: string, handlerId: string, payload: unknown): void;
  focus(): void;
}

/** The editor's visible suggest widget, if any. */
function visibleWidget(ed: SuggestEditorLike): Element | null {
  return ed.getDomNode()?.querySelector('.suggest-widget.visible') ?? null;
}

export function suggestKeyState(ed: SuggestEditorLike): SuggestKeyState {
  const w = visibleWidget(ed);
  const live = !!w && !w.classList.contains('message') && !w.classList.contains('frozen');
  return { readOnly: !!ed.getRawOptions().readOnly, widgetVisible: !!w, focusedItem: live && !!w!.querySelector('.monaco-list-row.focused') };
}

/** Runs "Trigger suggest" on an editor; returns what it did. */
export function triggerSuggest(ed: SuggestEditorLike): SuggestKeyAction {
  const state = suggestKeyState(ed);
  const action = suggestKeyAction(state);
  if (action === 'none') return action;
  ed.focus();
  if (action === 'toggleDetails') {
    ed.trigger('dbstudio', 'toggleSuggestionDetails', {});
    return action;
  }
  // The controller's own entry point bypasses the action's `!suggestWidgetVisible` precondition and replaces a
  // message / frozen session with a fresh, explicit one.
  if (state.widgetVisible) ed.trigger('dbstudio', 'hideSuggestWidget', {});
  const ctrl = ed.getContribution(SUGGEST_CONTROLLER_ID) as { triggerSuggest?: (onlyFrom?: unknown, auto?: boolean) => void } | null;
  if (typeof ctrl?.triggerSuggest === 'function') ctrl.triggerSuggest(undefined, false);
  else ed.trigger('dbstudio', 'editor.action.triggerSuggest', {});
  return action;
}

/**
 * Re-runs an open suggest session in place (after the catalog changed while a "Loading <schema>…" row was shown).
 * Automatic, so a list that is still empty closes instead of turning into "No suggestions.". Returns true when it ran.
 */
export function refreshSuggest(ed: SuggestEditorLike): boolean {
  const ctrl = ed.getContribution(SUGGEST_CONTROLLER_ID) as { triggerSuggest?: (onlyFrom?: unknown, auto?: boolean) => void; model?: { state?: number } } | null;
  if (typeof ctrl?.triggerSuggest !== 'function') return false;
  // A fast catalog answer can land before Monaco has rendered the "Loading" result: a session that is still pending
  // (SuggestModel.state: 0 idle, 1 manual, 2 auto) is refreshed too, else the stale row would render afterwards.
  if (!visibleWidget(ed) && !ctrl.model?.state) return false;
  ctrl.triggerSuggest(undefined, true);
  return true;
}

/**
 * Payload of the suggest follow-up after accepting an item that inserts a qualifier (`schema.`, `db.`, `pkg.`):
 * automatic, so when nothing is there yet the box stays closed rather than showing an empty "No suggestions.".
 */
export function followUpPayload(handlerId: string): { auto?: true } {
  return handlerId === 'editor.action.triggerSuggest' ? { auto: true } : {};
}

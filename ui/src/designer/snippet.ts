// Inserting a Monaco snippet into a console tab's editor once it has mounted (procedure wizard templates), and leaving
// snippet (tab-stop) mode before a run: while a placeholder is selected, F5 / Run would otherwise run only that
// selection ("TR_Orders_Audit") instead of the CREATE script.
import * as monaco from '../editor/monaco';
import { useTabs } from '../store/tabs';
import { snippetToText } from './proc/templates';

interface SnippetController {
  insert(template: string): void;
  isInSnippet?(): boolean;
  cancel?(resetSelection?: boolean): void;
}

function editorOf(tabId: string): monaco.editor.ICodeEditor | undefined {
  const uri = monaco.Uri.parse(`dbstudio-tab://tab/${encodeURIComponent(tabId)}.sql`).toString();
  return monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
}

function controllerOf(ed: monaco.editor.ICodeEditor): SnippetController | null {
  return (ed.getContribution('snippetController2') as SnippetController | null) ?? null;
}

/** True while the editor is in snippet tab-stop mode (a placeholder of an inserted template is active). */
export function isInSnippetMode(ed: monaco.editor.ICodeEditor): boolean {
  return !!controllerOf(ed)?.isInSnippet?.();
}

/**
 * Leaves snippet mode and collapses the placeholder selection to the cursor, so the next run resolves to the whole
 * script instead of the selected placeholder. Returns true when snippet mode was active.
 */
export function leaveSnippetMode(ed: monaco.editor.ICodeEditor): boolean {
  const ctl = controllerOf(ed);
  if (!ctl?.isInSnippet?.()) return false;
  ctl.cancel?.(false);
  const pos = ed.getPosition();
  if (pos) ed.setSelection(new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
  return true;
}

/** Same as leaveSnippetMode for a console tab (Run button / run commands outside the editor's own keybindings). */
export function leaveSnippetModeInTab(tabId: string): boolean {
  const ed = editorOf(tabId);
  return ed ? leaveSnippetMode(ed) : false;
}

/**
 * Run keys: F5 / Ctrl+Shift+Enter (script) and Ctrl+Enter (statement at the cursor, which is the whole CREATE once the
 * placeholder selection is gone). The editor's own keybindings handle them after us.
 */
function isRunKey(e: monaco.IKeyboardEvent): boolean {
  if (e.keyCode === monaco.KeyCode.F5 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return true;
  return e.keyCode === monaco.KeyCode.Enter && (e.ctrlKey || e.metaKey) && !e.altKey;
}

const guarded = new WeakSet<monaco.editor.ICodeEditor>();

/**
 * F5 while a template's placeholder is selected leaves snippet mode first. The editor's onKeyDown fires on the text
 * area before the keybinding service (listening on the editor's container) dispatches the run action, so the run
 * then sees no selection and takes the whole script.
 */
export function guardRunInSnippetMode(ed: monaco.editor.ICodeEditor): void {
  if (guarded.has(ed)) return;
  guarded.add(ed);
  ed.onKeyDown((e) => {
    if (isRunKey(e)) leaveSnippetMode(ed);
  });
  // The toolbar Run button, the command palette and the menus take focus from the editor before they run: leave
  // snippet mode when focus moves elsewhere in the app (not when the whole window is merely deactivated).
  ed.onDidBlurEditorWidget(() => {
    if (typeof document === 'undefined' || document.hasFocus()) leaveSnippetMode(ed);
  });
}

/** Waits (up to ~3 s) for the tab's editor, then inserts the snippet with its tab stops; falls back to plain text. */
export async function insertSnippetInTab(tabId: string, snippet: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const ed = editorOf(tabId);
    if (ed) {
      ed.focus();
      const ctl = controllerOf(ed);
      if (ctl) {
        guardRunInSnippetMode(ed);
        ctl.insert(snippet);
      } else ed.setValue(snippetToText(snippet));
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  useTabs.getState().updateText(tabId, snippetToText(snippet));
  return false;
}

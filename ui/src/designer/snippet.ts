// Inserting a Monaco snippet into a console tab's editor once it has mounted (procedure wizard templates).
import * as monaco from '../editor/monaco';
import { useTabs } from '../store/tabs';
import { snippetToText } from './proc/templates';

interface SnippetController {
  insert(template: string): void;
}

function editorOf(tabId: string): monaco.editor.ICodeEditor | undefined {
  const uri = monaco.Uri.parse(`dbstudio-tab://tab/${encodeURIComponent(tabId)}.sql`).toString();
  return monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
}

/** Waits (up to ~3 s) for the tab's editor, then inserts the snippet with its tab stops; falls back to plain text. */
export async function insertSnippetInTab(tabId: string, snippet: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const ed = editorOf(tabId);
    if (ed) {
      ed.focus();
      const ctl = ed.getContribution('snippetController2') as SnippetController | null;
      if (ctl) ctl.insert(snippet);
      else ed.setValue(snippetToText(snippet));
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  useTabs.getState().updateText(tabId, snippetToText(snippet));
  return false;
}

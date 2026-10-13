import type { SqlEditorHandle } from '../editor/SqlEditor.types';

/** Imperative editor handles by tab id (run from toolbar/palette, click-to-line from Messages, drag/insert). */
const handles = new Map<string, SqlEditorHandle>();

export function registerEditor(tabId: string, h: SqlEditorHandle | null): void {
  if (h) handles.set(tabId, h);
  else handles.delete(tabId);
}

export function getEditor(tabId: string | null | undefined): SqlEditorHandle | undefined {
  return tabId ? handles.get(tabId) : undefined;
}

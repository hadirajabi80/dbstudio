import type { SqlEditorHandle } from '../editor/SqlEditor.types';

/** Imperative editor handles by tab id (run from toolbar/palette, click-to-line from Messages, drag/insert). */
const handles = new Map<string, SqlEditorHandle>();
const listeners = new Set<() => void>();
let version = 0;

export function registerEditor(tabId: string, h: SqlEditorHandle | null): void {
  const had = handles.get(tabId);
  if (h) handles.set(tabId, h);
  else handles.delete(tabId);
  if (had === (h ?? undefined)) return;
  // Commands whose `when` needs an editor (Format, Explain) re-evaluate once the editor mounts (user-01: the toolbar
  // rendered before Monaco did and showed them disabled until something else re-rendered it).
  version++;
  for (const l of [...listeners]) l();
}

export function getEditor(tabId: string | null | undefined): SqlEditorHandle | undefined {
  return tabId ? handles.get(tabId) : undefined;
}

/** Changes whenever an editor is registered or removed (useSyncExternalStore snapshot). */
export function editorsVersion(): number {
  return version;
}

export function subscribeEditors(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

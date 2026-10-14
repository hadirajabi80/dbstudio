// Per-model state for the global Monaco providers. Providers are registered once per language and look up the
// editor instance that owns a model by its URI (several SqlEditor instances can be mounted at the same time).
import type * as monaco from './monaco';
import type { Intel } from '../intel';
import type { Dialect, FormatOptions, ObjectRef, Snippet } from '../api/types';

export interface ModelBinding {
  uri: string;
  intel: Intel;
  editor: monaco.editor.IStandaloneCodeEditor;
  connectionId: () => string;
  database: () => string | null;
  openObject: (ref: ObjectRef, column?: string) => void;
  /** Called after a completion item was accepted (usage ranking). */
  accepted: (usageKey: string) => void;
  /** WP-H: dialect of the model, formatter options and user snippets (props, else the app-wide editor config). */
  dialect?: Dialect;
  formatOptions?: () => Partial<FormatOptions> | null;
  snippets?: () => readonly Snippet[];
  /** Ctrl+J: the next completion request lists snippets only. */
  snippetPicker?: boolean;
  /** Tab id of the editor (commands acting on the focused editor). */
  tabId?: string;
}

// On globalThis so providers registered once keep seeing bindings after Vite HMR re-evaluates this module.
const G = globalThis as unknown as { __dbstudioBindings?: Map<string, ModelBinding> };
const bindings: Map<string, ModelBinding> = (G.__dbstudioBindings ??= new Map());

const A = globalThis as unknown as { __dbstudioActiveBinding?: { uri: string | null } };
const active = (A.__dbstudioActiveBinding ??= { uri: null });

export function bindModel(b: ModelBinding): () => void {
  bindings.set(b.uri, b);
  return () => {
    if (bindings.get(b.uri) === b) bindings.delete(b.uri);
    if (active.uri === b.uri) active.uri = null;
  };
}

/** Remember the editor that had focus last (commands from the palette act on it). */
export function setActiveBinding(uri: string): void {
  active.uri = uri;
}

/** The focused (or last focused) editor, if it is still mounted. */
export function activeBinding(): ModelBinding | undefined {
  return active.uri ? bindings.get(active.uri) : undefined;
}

export function bindingFor(model: monaco.editor.ITextModel | null | undefined): ModelBinding | undefined {
  return model ? bindings.get(model.uri.toString()) : undefined;
}

export function bindingByUri(uri: string): ModelBinding | undefined {
  return bindings.get(uri);
}

export function bindingForEditor(ed: { getModel(): monaco.editor.ITextModel | null } | null | undefined): ModelBinding | undefined {
  return ed ? bindingFor(ed.getModel()) : undefined;
}

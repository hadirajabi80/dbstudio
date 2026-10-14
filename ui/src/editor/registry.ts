// Per-model state for the global Monaco providers. Providers are registered once per language and look up the
// editor instance that owns a model by its URI (several SqlEditor instances can be mounted at the same time).
import type * as monaco from './monaco';
import type { Intel } from '../intel';
import type { ObjectRef } from '../api/types';

export interface ModelBinding {
  uri: string;
  intel: Intel;
  editor: monaco.editor.IStandaloneCodeEditor;
  connectionId: () => string;
  database: () => string | null;
  openObject: (ref: ObjectRef, column?: string) => void;
  /** Called after a completion item was accepted (usage ranking). */
  accepted: (usageKey: string) => void;
}

// On globalThis so providers registered once keep seeing bindings after Vite HMR re-evaluates this module.
const G = globalThis as unknown as { __dbstudioBindings?: Map<string, ModelBinding> };
const bindings: Map<string, ModelBinding> = (G.__dbstudioBindings ??= new Map());

export function bindModel(b: ModelBinding): () => void {
  bindings.set(b.uri, b);
  return () => {
    if (bindings.get(b.uri) === b) bindings.delete(b.uri);
  };
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

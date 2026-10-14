// Imperative actions of mounted designer tabs (Ctrl+S → Apply), looked up by tab id from commands.
import { useTabs } from '../store/tabs';

export interface DesignerActions {
  apply(): void;
}

const actions = new Map<string, DesignerActions>();

/** Called by a designer component; returns the unregister function (use as an effect cleanup). */
export function registerDesignerActions(tabId: string, a: DesignerActions): () => void {
  actions.set(tabId, a);
  return () => {
    if (actions.get(tabId) === a) actions.delete(tabId);
  };
}

export function activeDesignerActions(): DesignerActions | undefined {
  const id = useTabs.getState().activeId;
  return id ? actions.get(id) : undefined;
}

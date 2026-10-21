// Commands → open Redis view: palette / shortcut commands without a target act on the active Redis tab by sending it
// an action; each view subscribes for its own tab id.
import { useEffect, useRef } from 'react';

export type RedisViewAction =
  | 'focusPattern' | 'focusKeys' | 'focusValue' | 'refresh' | 'newKey' | 'renameKey' | 'deleteKey' | 'setTtl' | 'copyKey' | 'copyValueJson'
  | 'deletePattern' | 'save' | 'scanMore' | 'runLine' | 'runAll' | 'clear' | 'monitorToggle' | 'pause';

const listeners = new Map<string, Set<(a: RedisViewAction) => void>>();

export function sendRedisViewAction(tabId: string, action: RedisViewAction): boolean {
  const set = listeners.get(tabId);
  if (!set?.size) return false;
  for (const l of set) l(action);
  return true;
}

export function useRedisViewEvents(tabId: string, handler: (a: RedisViewAction) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (a: RedisViewAction) => ref.current(a);
    let set = listeners.get(tabId);
    if (!set) {
      set = new Set();
      listeners.set(tabId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }, [tabId]);
}

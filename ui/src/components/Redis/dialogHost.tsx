// A host for Redis dialogs opened from commands (explorer context menus, the palette) and from the views: its own
// React root in a body-level container, so the shell needs no Redis-specific mount point.
import { useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Render = (close: () => void) => ReactNode;

let root: Root | null = null;
let current: { id: number; render: Render } | null = null;
let seq = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Renders the current dialog; mounted by the body-level root, and by tests directly. */
export function RedisDialogHost() {
  const c = useSyncExternalStore(subscribe, () => current);
  if (!c) return null;
  const close = () => {
    if (current?.id === c.id) {
      current = null;
      emit();
    }
  };
  return <div key={c.id}>{c.render(close)}</div>;
}

/** Tests render RedisDialogHost themselves; the app gets a body-level root on first use. */
let manualHost = false;
export function enableManualDialogHost(): void {
  manualHost = true;
}

function ensureRoot() {
  if (root || manualHost) return;
  const el = document.createElement('div');
  el.className = 'redis-dialog-root';
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(<RedisDialogHost />);
}

/** Shows a dialog (one at a time); `render` receives `close`. */
export function showRedisDialog(render: Render): void {
  ensureRoot();
  current = { id: ++seq, render };
  emit();
}

export function closeRedisDialog(): void {
  current = null;
  emit();
}

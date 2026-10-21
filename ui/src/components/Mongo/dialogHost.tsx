// A host for Mongo dialogs opened from commands (explorer context menus, the palette) as well as from the views:
// a separate React root in a body-level container, so the shell needs no Mongo-specific mount point.
import { useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Render = (close: () => void) => ReactNode;

let root: Root | null = null;
let current: { id: number; render: Render } | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function Host() {
  const c = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
  if (!c) return null;
  const close = () => {
    if (current?.id === c.id) {
      current = null;
      emit();
    }
  };
  return <div key={c.id}>{c.render(close)}</div>;
}

function ensureRoot() {
  if (root) return;
  const el = document.createElement('div');
  el.className = 'mongo-dialog-root';
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(<Host />);
}

/** Shows a dialog (one at a time); `render` receives `close`. */
export function showMongoDialog(render: Render): void {
  ensureRoot();
  current = { id: ++seq, render };
  emit();
}

export function closeMongoDialog(): void {
  current = null;
  emit();
}

export function hasMongoDialog(): boolean {
  return current !== null;
}

// A host for Kafka dialogs opened from commands (explorer context menus, the palette) and from the views: a separate
// React root in a body-level container, so the shell needs no Kafka-specific mount point.
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

/** Shows a dialog (one at a time); `render` receives `close`. */
export function showKafkaDialog(render: Render): void {
  if (!root) {
    const el = document.createElement('div');
    el.className = 'kafka-dialog-root';
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(<Host />);
  }
  current = { id: ++seq, render };
  emit();
}

export function closeKafkaDialog(): void {
  current = null;
  emit();
}

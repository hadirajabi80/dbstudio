// The app's effective theme as applied to <html data-theme> (useEffectiveTheme in App sets it), for components that
// are not handed the theme (the settings dialog).
import { useSyncExternalStore } from 'react';
import type { EffectiveTheme } from '../../theme/useTheme';

function read(): EffectiveTheme {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(cb: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

export function useDocumentTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, read, () => 'light');
}

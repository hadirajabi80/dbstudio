// The Settings dialog lives in ./settings/ (sections, theme pickers, the updates card). This path stays the import
// used by App.tsx: a lazy wrapper, so the dialog and its styles load on first open instead of with the app.
import { lazy, Suspense } from 'react';
import { useUi } from '../../store/ui';

const Dialog = lazy(() => import('./settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));

/** Ctrl+, : settings. */
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Dialog />
    </Suspense>
  );
}

export { openSettings, type SettingsSection } from './settings/nav';

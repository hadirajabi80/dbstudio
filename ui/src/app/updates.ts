// Auto-update in the renderer: mirrors the main process status (desktop/src/main/updater-core.ts) into the updates
// store, reports the "Automatically check for updates" setting, and implements help.checkForUpdates. The main process
// does the checking, downloading and installing; nothing here is ever a modal dialog.
import { useEffect } from 'react';
import { getPlatform } from '../platform';
import type { UpdateStatus } from '../platform/bridge';
import { autoCheckUpdates, useSettings } from '../store/settings';
import { toast } from '../store/ui';
import { useUpdates } from '../store/updates';

export const RELEASES_URL = 'https://github.com/hadirajabi80/dbstudio/releases';

/** Shell hook: status subscription, and the auto-check setting (main checks nothing until it hears it). */
export function useUpdateWiring(): void {
  const loaded = useSettings((s) => s.loaded);
  const autoCheck = useSettings((s) => autoCheckUpdates(s.settings));

  useEffect(() => {
    const p = getPlatform();
    if (!p.onUpdateStatus) return;
    const off = p.onUpdateStatus((s) => useUpdates.getState().setStatus(s));
    p.getUpdateStatus?.().then((s) => useUpdates.getState().setStatus(s), () => undefined);
    return off;
  }, []);

  useEffect(() => {
    if (!loaded) return;
    getPlatform().configureUpdates?.({ autoCheck })?.catch((e) => console.warn('[updates] configure failed', e));
  }, [loaded, autoCheck]);
}

function report(s: UpdateStatus): void {
  switch (s.state) {
    case 'up-to-date':
      toast('success', "You're up to date", `DbStudio ${s.currentVersion} is the latest version.`);
      break;
    case 'downloading':
      toast('info', s.version ? `Downloading DbStudio ${s.version}…` : 'Downloading the update…', "You'll be asked to restart when it is ready.");
      break;
    case 'disabled':
      toast('info', 'Updates are not checked in this build', s.message);
      break;
    case 'error':
      // Logged by the main process; a gentle note, never a dialog.
      toast('warning', "Couldn't check for updates", s.message);
      break;
    default:
      // 'available' / 'ready': the update notice shows it.
      break;
  }
}

/** help.checkForUpdates. The browser build has no updater: it opens the releases page instead. */
export async function checkForUpdatesNow(): Promise<void> {
  const p = getPlatform();
  if (!p.checkForUpdates) {
    await p.openExternal(RELEASES_URL);
    return;
  }
  let s: UpdateStatus;
  try {
    s = await p.checkForUpdates({ manual: true });
  } catch (e) {
    toast('warning', "Couldn't check for updates", e instanceof Error ? e.message : String(e));
    return;
  }
  const u = useUpdates.getState();
  u.undismiss(); // a manual check shows a pending update again, even after "Later"
  u.setStatus(s);
  report(s);
}

/** "Restart now" (install mode). */
export async function restartToUpdate(): Promise<void> {
  const ok = await getPlatform().quitAndInstall?.().catch(() => false);
  if (!ok) toast('warning', 'The update could not be installed now', 'It will be installed when DbStudio quits.');
}

/** "Download" (notify mode: ad-hoc signed macOS). */
export async function openReleasePage(url?: string): Promise<void> {
  await getPlatform().openExternal(url ?? RELEASES_URL);
}

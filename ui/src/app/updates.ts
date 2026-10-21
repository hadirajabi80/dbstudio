// Auto-update in the renderer: mirrors the main process status (desktop/src/main/updater-core.ts) into the updates
// store, reports the "Automatically check for updates" setting, announces a new version once (a toast, and an OS
// notification while the window is in the background), and implements help.checkForUpdates. The main process does
// the checking, downloading and installing; nothing here is ever a modal dialog. The status bar chip
// (components/StatusBar/UpdateChip.tsx) and Settings › Updates show the same state machine (describeUpdate).
import { useEffect } from 'react';
import { getPlatform } from '../platform';
import type { UpdateStatus } from '../platform/bridge';
import { autoCheckUpdates, useSettings } from '../store/settings';
import { toast } from '../store/ui';
import { useUpdates } from '../store/updates';

export const RELEASES_URL = 'https://github.com/hadirajabi80/dbstudio/releases';

/** Announcements already made this session, per kind and version ("arrived:1.1.0", "ready:1.1.0"). */
const announced = new Set<string>();

/** Tests. */
export function resetUpdateAnnouncements(): void {
  announced.clear();
}

/**
 * Tells the user about a new version once per version: a transient toast when an update starts downloading in the
 * background (install mode; the ready/available card in the toast stack covers the rest), and an OS notification when
 * it is ready to install (or, in notify mode, available) while DbStudio is in the background.
 */
export function announceUpdate(prev: UpdateStatus | null, next: UpdateStatus): void {
  const v = next.version;
  if (!v || (prev?.state === next.state && prev?.version === v)) return;
  const once = (key: string) => {
    if (announced.has(`${key}:${v}`)) return false;
    announced.add(`${key}:${v}`);
    return true;
  };
  const notify = (title: string, body: string) => getPlatform().showNotification?.({ title, body });
  if (next.mode === 'install' && (next.state === 'available' || next.state === 'downloading') && once('arrived')) {
    toast('info', `DbStudio ${v} is available`, 'Downloading in the background — progress is in the status bar.');
  } else if (next.mode === 'install' && next.state === 'ready' && once('ready')) {
    announced.add(`arrived:${v}`);
    notify(`DbStudio ${v} is ready`, 'Restart DbStudio to finish updating, or it installs when you quit.');
  } else if (next.mode === 'notify' && next.state === 'available' && once('ready')) {
    notify(`DbStudio ${v} is available`, 'Download the new version from GitHub.');
  }
}

/** Shell hook: status subscription, and the auto-check setting (main checks nothing until it hears it). */
export function useUpdateWiring(): void {
  const loaded = useSettings((s) => s.loaded);
  const autoCheck = useSettings((s) => autoCheckUpdates(s.settings));

  useEffect(() => {
    const p = getPlatform();
    if (!p.onUpdateStatus) return;
    const off = p.onUpdateStatus((s) => {
      const prev = useUpdates.getState().status;
      useUpdates.getState().setStatus(s);
      announceUpdate(prev, s);
    });
    // The status at start (e.g. after a renderer reload): shown by the chip and the card, not announced again.
    p.getUpdateStatus?.().then((s) => {
      useUpdates.getState().setStatus(s);
      if (s.version && (s.state === 'ready' || s.state === 'downloading' || s.state === 'available')) {
        announced.add(`arrived:${s.version}`);
        if (s.state === 'ready' || s.mode === 'notify') announced.add(`ready:${s.version}`);
      }
    }, () => undefined);
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
      // Once per version (the background download may already have been announced).
      if (s.version && announced.has(`arrived:${s.version}`)) break;
      if (s.version) announced.add(`arrived:${s.version}`);
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
  useUpdates.getState().setStatus({ ...(useUpdates.getState().status ?? { mode: 'install', currentVersion: p.appVersion }), state: 'checking' });
  let s: UpdateStatus;
  try {
    s = await p.checkForUpdates({ manual: true });
  } catch (e) {
    toast('warning', "Couldn't check for updates", e instanceof Error ? e.message : String(e));
    const cur = useUpdates.getState().status;
    if (cur?.state === 'checking') useUpdates.getState().setStatus({ ...cur, state: 'error', message: e instanceof Error ? e.message : String(e) });
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

export type UpdateTone = 'muted' | 'busy' | 'accent' | 'success' | 'warning';

/** One line about the update state, shared by the status bar chip and Settings › Updates. */
export interface UpdateDescription {
  tone: UpdateTone;
  /** Settings › Updates status line. */
  text: string;
  /** Status bar chip label (null: no chip). */
  chip: string | null;
  /** 0–100 while downloading. */
  percent?: number;
}

export function describeUpdate(s: UpdateStatus | null): UpdateDescription {
  const v = s?.version;
  switch (s?.state) {
    case 'checking':
      return { tone: 'busy', text: 'Checking for updates…', chip: 'Checking for updates…' };
    case 'up-to-date':
      return { tone: 'success', text: `You're up to date — DbStudio ${s.currentVersion} is the latest version.`, chip: null };
    case 'available':
      return s.mode === 'notify'
        ? { tone: 'accent', text: `DbStudio ${v} is available to download.`, chip: `v${v} available` }
        : { tone: 'accent', text: `DbStudio ${v} is available — downloading in the background…`, chip: `v${v} available` };
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.round(s.percent ?? 0)));
      return { tone: 'busy', text: `Downloading DbStudio ${v ?? 'update'}… ${percent}%`, chip: `Downloading ${percent}%`, percent };
    }
    case 'ready':
      return { tone: 'accent', text: `DbStudio ${v} is ready — restart to finish updating (or it installs when you quit).`, chip: 'Restart to update' };
    case 'error':
      return { tone: 'warning', text: `Couldn't check for updates${s.message ? `: ${s.message}` : '.'}`, chip: 'Update check failed' };
    case 'disabled':
      return { tone: 'muted', text: s.message ?? 'Updates are not checked in this build.', chip: null };
    case 'idle':
      return { tone: 'muted', text: 'Not checked yet in this session.', chip: null };
    default:
      return { tone: 'muted', text: 'Updates come with the desktop app.', chip: null };
  }
}

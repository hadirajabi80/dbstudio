// Auto-update state machine (electron-free, so test/updater.test.mjs drives it with a fake electron-updater).
// updater.ts wires it to electron-updater, the app and the renderer.
//
//   idle --check--> checking --> up-to-date
//                            \-> install mode: downloading --> ready  (Windows, signed macOS: Restart now / Later)
//                            \-> notify mode:  available             (ad-hoc signed macOS: open the release page)
//   any --error--> error (logged; a manual check reports it gently, automatic checks stay silent)
//   disabled: dev runs, unpackaged builds, Linux, smoke tests. Nothing is ever checked.
import type { UpdateMode, UpdateStatus } from '../../../ui/src/platform/bridge';

export type { UpdateMode, UpdateStatus };

/** GitHub repository the releases (and latest.yml / latest-mac.yml) are published to (electron-builder.yml publish). */
export const RELEASE_OWNER = 'hadirajabi80';
export const RELEASE_REPO = 'rowlit';
export const RELEASES_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`;

/** First automatic check after start, then every 6 hours. */
export const INITIAL_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Release page of a version (tags are v<version>, release.yml); the releases list for anything unexpected. */
export function releasePageUrl(version: string | undefined): string {
  return version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL;
}

/** The part of electron-updater's AppUpdater this controller uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease?: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface UpdateControllerOptions {
  /** null: updates are disabled (`disabledReason` says why). */
  updater: UpdaterLike | null;
  mode: UpdateMode;
  disabledReason?: string;
  currentVersion: string;
  /** Pushes every status change to the renderer. */
  send(status: UpdateStatus): void;
  log(message: string): void;
  /** Windows: quitAndInstall(isSilent, isForceRunAfter) runs the NSIS installer silently and restarts the app. */
  silentInstall?: boolean;
  timers?: Timers;
  now?(): number;
  initialDelayMs?: number;
  intervalMs?: number;
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // electron-updater errors can carry a whole HTTP response; the first line is enough for the log and the UI.
  return m.split('\n')[0].slice(0, 300);
}

export class UpdateController {
  private current: UpdateStatus;
  private readonly timers: Timers;
  private readonly startedAt: number;
  private firstTimer: unknown = null;
  private intervalTimer: unknown = null;
  private inflight: Promise<UpdateStatus> | null = null;
  private autoCheck = false;

  constructor(private readonly o: UpdateControllerOptions) {
    this.timers = o.timers ?? realTimers;
    this.startedAt = (o.now ?? Date.now)();
    const mode = o.updater ? o.mode : 'disabled';
    this.current = o.updater
      ? { state: 'idle', mode, currentVersion: o.currentVersion }
      : { state: 'disabled', mode, currentVersion: o.currentVersion, message: o.disabledReason ?? 'Updates are not available in this build.' };
    const u = o.updater;
    if (!u) return;
    // Windows / signed macOS: download in the background and install on quit unless the user restarts first.
    // Ad-hoc signed macOS (Squirrel.Mac refuses unsigned updates): only announce the release.
    u.autoDownload = o.mode === 'install';
    u.autoInstallOnAppQuit = o.mode === 'install';
    u.allowPrerelease = false;
    u.on('checking-for-update', () => this.set({ state: 'checking' }));
    u.on('update-available', (info: { version?: string }) => {
      const version = info?.version;
      this.o.log(`update available: ${version} (${o.mode})`);
      if (o.mode === 'install') this.set({ state: 'downloading', version, percent: 0 });
      else this.set({ state: 'available', version, releaseUrl: releasePageUrl(version) });
    });
    u.on('update-not-available', () => this.set({ state: 'up-to-date' }));
    u.on('download-progress', (p: { percent?: number }) => {
      if (this.current.state !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
      if (percent !== this.current.percent) this.set({ ...this.current, percent });
    });
    u.on('update-downloaded', (info: { version?: string }) => {
      const version = info?.version ?? this.current.version;
      this.o.log(`update downloaded: ${version}`);
      this.set({ state: 'ready', version, releaseUrl: releasePageUrl(version) });
    });
    u.on('error', (e: unknown) => this.fail(e));
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /**
   * The renderer reports the "Automatically check for updates" setting once its settings are loaded, and whenever it
   * changes. Nothing is checked automatically before that: the first check runs 10 s after start (or right away when
   * the setting arrives later), then every 6 hours.
   */
  configure(opts: { autoCheck: boolean }): void {
    if (!this.o.updater) return;
    if (opts.autoCheck === this.autoCheck) return;
    this.autoCheck = opts.autoCheck;
    this.clearTimers();
    if (!opts.autoCheck) {
      this.o.log('automatic update checks off');
      return;
    }
    const elapsed = (this.o.now ?? Date.now)() - this.startedAt;
    const delay = Math.max(0, (this.o.initialDelayMs ?? INITIAL_CHECK_DELAY_MS) - elapsed);
    this.firstTimer = this.timers.setTimeout(() => {
      this.firstTimer = null;
      void this.check();
    }, delay);
    this.intervalTimer = this.timers.setInterval(() => void this.check(), this.o.intervalMs ?? CHECK_INTERVAL_MS);
  }

  /** Checks now. Never throws: failures become an 'error' status (logged). A downloaded update is not re-checked. */
  check(opts: { manual?: boolean } = {}): Promise<UpdateStatus> {
    const u = this.o.updater;
    if (!u) return Promise.resolve(this.current);
    if (this.current.state === 'ready' || this.current.state === 'downloading') return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    this.o.log(`checking for updates (${opts.manual ? 'manual' : 'automatic'})`);
    this.inflight = (async () => {
      try {
        this.set({ state: 'checking' });
        const r = await u.checkForUpdates();
        // electron-updater emits the outcome as events before resolving; derive it here for anything it did not.
        if (this.current.state === 'checking') {
          const version = r?.updateInfo?.version;
          if (!r || !r.isUpdateAvailable) this.set({ state: 'up-to-date' });
          else if (this.o.mode === 'install') this.set({ state: 'downloading', version, percent: 0 });
          else this.set({ state: 'available', version, releaseUrl: releasePageUrl(version) });
        }
      } catch (e) {
        this.fail(e);
      } finally {
        this.inflight = null;
      }
      return this.current;
    })();
    return this.inflight;
  }

  /** Restart now: only once an update is downloaded (install mode). */
  quitAndInstall(): boolean {
    const u = this.o.updater;
    if (!u || this.o.mode !== 'install' || this.current.state !== 'ready') return false;
    this.o.log(`restarting to install ${this.current.version}`);
    this.clearTimers();
    if (this.o.silentInstall) u.quitAndInstall(true, true);
    else u.quitAndInstall();
    return true;
  }

  dispose(): void {
    this.clearTimers();
  }

  private fail(e: unknown): void {
    const message = messageOf(e);
    // electron-updater both emits 'error' and rejects checkForUpdates(): log (and report) the failure once.
    if (this.current.state === 'error' && this.current.message === message) return;
    this.o.log(`update error: ${message}`);
    // A finished download stays installable (it installs on quit) even if a later check fails.
    if (this.current.state === 'ready') return;
    this.set({ state: 'error', message });
  }

  private set(next: Omit<UpdateStatus, 'mode' | 'currentVersion'>): void {
    const status = { ...next, mode: this.current.mode, currentVersion: this.o.currentVersion } as UpdateStatus;
    const same = (Object.keys(status) as (keyof UpdateStatus)[]).every((k) => status[k] === this.current[k])
      && Object.keys(status).length === Object.keys(this.current).length;
    if (same) return;
    this.current = status;
    try {
      this.o.send(this.current);
    } catch (e) {
      this.o.log(`update status not delivered: ${messageOf(e)}`);
    }
  }

  private clearTimers(): void {
    if (this.firstTimer !== null) this.timers.clearTimeout(this.firstTimer);
    if (this.intervalTimer !== null) this.timers.clearInterval(this.intervalTimer);
    this.firstTimer = null;
    this.intervalTimer = null;
  }
}

/** How a macOS bundle is signed, from `codesign -dv --verbose=2 <app>` (it prints to stderr). */
export type MacSignature = 'developer-id' | 'adhoc' | 'unsigned' | 'unknown';

export function parseCodesignOutput(text: string): MacSignature {
  if (/not signed at all/i.test(text)) return 'unsigned';
  if (/^Signature=adhoc$/m.test(text) || /flags=0x[0-9a-f]*\(.*adhoc.*\)/i.test(text)) return 'adhoc';
  if (/^Authority=Developer ID Application:/m.test(text) && /^TeamIdentifier=(?!not set)\S+/m.test(text)) return 'developer-id';
  return 'unknown';
}

/**
 * Update behaviour per OS. Windows: full flow (NSIS, unsigned installers are fine). macOS: Squirrel.Mac only installs
 * updates into a properly signed app, so an ad-hoc signed build (no CSC_LINK at build time) only announces new
 * releases. Linux has no updater target.
 */
export function updateModeFor(os: 'win32' | 'darwin' | 'linux', signature: MacSignature = 'unknown'): UpdateMode {
  if (os === 'win32') return 'install';
  if (os === 'darwin') return signature === 'developer-id' ? 'install' : 'notify';
  return 'disabled';
}

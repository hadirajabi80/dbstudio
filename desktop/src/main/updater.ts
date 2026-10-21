// Auto-update through GitHub Releases (electron-updater reads latest.yml / latest-mac.yml from the release that
// release.yml publishes). The state machine is in updater-core.ts; this file only wires Electron to it.
//
// Disabled in dev runs, unpackaged builds, smoke tests, on Linux and with DBSTUDIO_DISABLE_UPDATES=1.
// Windows: background download, then "Restart now / Later" in the renderer; Later installs on quit.
// macOS: the full flow only when the bundle has a Developer ID signature (Squirrel.Mac refuses ad-hoc signed apps);
// otherwise the renderer only announces the release and opens its page.
import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { IPC } from '../shared/channels';
import type { DesktopOs } from './platform';
import { parseCodesignOutput, UpdateController, updateModeFor, type MacSignature, type UpdaterLike, type UpdateStatus } from './updater-core';

export interface UpdaterDeps {
  os: DesktopOs;
  log(message: string): void;
  smokeTest: boolean;
}

function broadcast(status: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.updateStatus, status);
  }
}

/** codesign of the running .app (Contents/MacOS/DbStudio -> DbStudio.app). Any failure counts as not signed. */
function macSignature(): Promise<MacSignature> {
  const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (_err, stdout, stderr) => {
      resolve(parseCodesignOutput(`${stdout}\n${stderr}`));
    });
  });
}

function disabledReason(deps: UpdaterDeps): string | null {
  if (deps.smokeTest) return 'Updates are off during the smoke test.';
  if (!app.isPackaged) return 'Updates are only checked in installed builds.';
  if (process.env.DBSTUDIO_DISABLE_UPDATES === '1') return 'Updates are turned off (DBSTUDIO_DISABLE_UPDATES).';
  if (deps.os === 'linux') return 'Automatic updates are not available on Linux.';
  return null;
}

export async function createUpdater(deps: UpdaterDeps): Promise<UpdateController> {
  const currentVersion = app.getVersion();
  const reason = disabledReason(deps);
  if (reason) {
    deps.log(`updates disabled: ${reason}`);
    return new UpdateController({ updater: null, mode: 'disabled', disabledReason: reason, currentVersion, send: broadcast, log: deps.log });
  }
  try {
    const signature = deps.os === 'darwin' ? await macSignature() : undefined;
    const mode = updateModeFor(deps.os, signature);
    const { autoUpdater } = await import('electron-updater');
    const prefix = (level: string) => (...args: unknown[]) => deps.log(`[${level}] ${args.map(String).join(' ')}`);
    autoUpdater.logger = { info: prefix('info'), warn: prefix('warn'), error: prefix('error'), debug: () => undefined };
    deps.log(`updates: ${mode} mode${signature ? ` (codesign: ${signature})` : ''}, current ${currentVersion}`);
    return new UpdateController({
      updater: autoUpdater as unknown as UpdaterLike,
      mode,
      currentVersion,
      send: broadcast,
      log: deps.log,
      silentInstall: deps.os === 'win32',
    });
  } catch (e) {
    const message = (e as Error).message;
    deps.log(`updates disabled: ${message}`);
    return new UpdateController({ updater: null, mode: 'disabled', disabledReason: 'The updater could not be started.', currentVersion, send: broadcast, log: deps.log });
  }
}

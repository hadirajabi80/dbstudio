import { app } from 'electron';
import * as path from 'node:path';
import { resolveDataDir, type DataDirResult } from './data-dir';

let resolved: DataDirResult | null = null;

/**
 * <appData>/Rowlit: shared with the engine (history.db, settings, connections, secrets) and holding the Chromium
 * profile. Resolved once per process; a packaged build moves an existing DbStudio folder here on first start
 * (data-dir.ts). DBSTUDIO_DATA_DIR overrides it (tests use a temp folder so they never touch real user data).
 */
export function initDataDir(): DataDirResult {
  if (!resolved) {
    resolved = resolveDataDir({
      appData: app.getPath('appData'),
      env: process.env,
      migrate: app.isPackaged,
      appVersion: app.getVersion(),
    });
  }
  return resolved;
}

export function dataDir(): string {
  return initDataDir().dir;
}

/** Chromium profile (cache, local storage, window state) lives below the data dir, not mixed into it. */
export function electronProfileDir(): string {
  return path.join(dataDir(), 'electron');
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs');
}

export function engineLogFile(): string {
  return path.join(logsDir(), 'engine-process.log');
}

export function workspaceFile(): string {
  return path.join(dataDir(), 'workspace.json');
}

export function windowStateFile(): string {
  return path.join(electronProfileDir(), 'window-state.json');
}

/** desktop/ in dev, resources/app.asar in a packaged build. */
export function appRoot(): string {
  return app.getAppPath();
}

/** Repository root in dev (desktop/..). Meaningless when packaged. */
export function repoRoot(): string {
  return path.resolve(app.getAppPath(), '..');
}

/** Built UI: resources/ui when packaged, ../ui/dist in dev; DBSTUDIO_UI_DIR overrides both. */
export function uiDir(): string {
  if (process.env.DBSTUDIO_UI_DIR) return path.resolve(process.env.DBSTUDIO_UI_DIR);
  return app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(repoRoot(), 'ui', 'dist');
}

export function iconPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(appRoot(), 'build', 'icon.png');
}

// DbStudio Electron main process: single instance, dbstudio:// protocol, window, menu, IPC, engine sidecar.
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron';
import * as path from 'node:path';
import { IPC } from '../shared/channels';
import {
  EngineStartError,
  EngineSupervisor,
  resolveEngineLaunch,
  type EngineExit,
  type EngineLaunch,
} from './engine-process';
import { engineErrorPageUrl } from './error-page';
import { RotatingLog } from './fs-utils';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { electronProfileDir, engineLogFile, iconPath, repoRoot, uiDir } from './paths';
import { desktopOs, quitWhenAllWindowsClosed } from './platform';
import { registerSchemePrivileges, registerUiProtocol } from './protocol';
import { runSmoke } from './smoke';
import { createUpdater } from './updater';
import type { UpdateController } from './updater-core';
import { applyTitleBarTheme, createMainWindow, installCsp, uiEntryUrl } from './window';

const APP_ID = 'com.dbstudio.desktop';
const smokeTest = process.env.DBSTUDIO_SMOKE === '1';
const os = desktopOs();

function readDevUrl(): string | undefined {
  const raw = process.env.DBSTUDIO_DEV_URL;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      return u.origin + '/';
    }
  } catch { /* fall through */ }
  console.error(`Ignoring DBSTUDIO_DEV_URL="${raw}": only http(s)://localhost URLs are allowed.`);
  return undefined;
}

const devUrl = readDevUrl();

// Must happen before 'ready'.
app.setPath('userData', electronProfileDir());
app.setAppUserModelId(APP_ID);
registerSchemePrivileges();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  const log = new RotatingLog(engineLogFile());
  let mainWindow: BrowserWindow | null = null;
  let titleLocked = false;
  let quitting = false;
  let engineStartedOnce = false;
  let updates: Promise<UpdateController> | null = null;

  let launch: EngineLaunch;
  try {
    launch = resolveEngineLaunch({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot: repoRoot(),
      parentPid: process.pid,
      env: process.env,
      devServer: devUrl !== undefined,
    });
  } catch (e) {
    app.whenReady().then(() => {
      dialog.showErrorBox('DbStudio', `Invalid engine configuration: ${(e as Error).message}`);
      app.quit();
    });
    return;
  }
  log.write('main', launch.kind === 'external'
    ? `attaching to external engine at ${launch.info.baseUrl}`
    : `launching engine: ${launch.spec.description} (timeout ${launch.spec.readyTimeoutMs} ms)`);

  const loadUi = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void mainWindow.loadURL(uiEntryUrl(devUrl));
  };

  const askRestart = async (exit: EngineExit): Promise<boolean> => {
    if (smokeTest) return true;
    // macOS keeps running without windows: restart silently so the next window finds a live engine.
    if (!mainWindow || mainWindow.isDestroyed()) return !quitWhenAllWindowsClosed(os);
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DbStudio',
      message: 'The DbStudio engine stopped unexpectedly.',
      detail:
        `Exit code: ${exit.code ?? exit.signal ?? 'unknown'}.\n` +
        'Open sessions and uncommitted transactions were lost; editor tabs are kept.\n\n' +
        `Log: ${log.file}`,
      buttons: ['Restart Engine', 'Quit DbStudio'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return r.response === 0;
  };

  const showStartFailure = async (err: Error) => {
    log.write('main', `engine start failed: ${err.message}`);
    if (quitting) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const output = err instanceof EngineStartError ? err.output : [];
    await mainWindow.loadURL(engineErrorPageUrl({ message: err.message, output, logFile: log.file, dark: nativeTheme.shouldUseDarkColors }));
    if (smokeTest) {
      const errorPage = await mainWindow.webContents.executeJavaScript('document.querySelector("h1").textContent + " | " + document.body.innerText.length');
      process.stdout.write(`DBSTUDIO_SMOKE_RESULT ${JSON.stringify({ error: err.message, startFailed: true, errorPage })}\n`);
      app.quit();
      return;
    }
    for (;;) {
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'DbStudio',
        message: 'The DbStudio engine could not be started.',
        detail: err.message,
        buttons: ['Retry', 'Open Log', 'Quit'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (r.response === 1) { await shell.openPath(log.file); continue; }
      if (r.response === 0) {
        // On failure the supervisor calls showStartFailure again.
        supervisor.start().then(loadUi, () => undefined);
      } else {
        app.quit();
      }
      return;
    }
  };

  const supervisor = new EngineSupervisor(launch, {
    askRestart,
    onRestarted: (info) => {
      log.write('main', `engine restarted at ${info.baseUrl}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.engineRestarted, info);
    },
    onStartFailed: (err) => { void showStartFailure(err); },
    onGaveUp: () => app.quit(),
    onOutput: (stream, line) => log.write(stream === 'stderr' ? 'engine:err' : 'engine', line),
    onExit: (exit) => log.write('main', `engine exited (code=${exit.code} signal=${exit.signal} expected=${exit.expected})`),
  });

  const restartEngine = () => {
    // A user-requested restart; the renderer is notified exactly like after a crash.
    supervisor.start().then(
      (info) => mainWindow?.webContents.send(IPC.engineRestarted, info),
      () => undefined,
    );
  };

  app.on('second-instance', () => {
    if (!mainWindow) {
      // macOS with every window closed: launching DbStudio again opens a window.
      if (app.isReady() && !quitting) mainWindow = openMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerUiProtocol(uiDir());
    installCsp(devUrl);
    // The renderer reports the "Automatically check for updates" setting; checks start 10 s after launch at the earliest.
    updates = createUpdater({ os, smokeTest, log: (m) => log.write('updater', m) });
    registerIpc({
      getEngineInfo: () => supervisor.whenReady(),
      devUrl,
      onTitle: () => { titleLocked = true; },
      updates: () => updates!,
      onTitleBarTheme: applyTitleBarTheme,
    });
    Menu.setApplicationMenu(buildMenu({ isDev: !app.isPackaged, onRestartEngine: supervisor.isExternal ? undefined : restartEngine }));

    // Dev runs show Electron's icon in the Dock; packaged builds get build/icon.icns from the bundle.
    if (os === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconPath());

    mainWindow = openMainWindow();

    if (smokeTest) runSmoke(mainWindow, supervisor);
    // Engine and UI start in parallel; getEngineInfo() calls from the renderer wait for the handshake.
    // A failure is reported through onStartFailed (error page + Retry dialog).
    supervisor.start().catch(() => undefined);
    engineStartedOnce = true;
    loadUi();
  });

  // macOS: closing the last window keeps the app (and the engine) alive; clicking the Dock icon re-creates it.
  app.on('activate', () => {
    if (!app.isReady() || quitting) return;
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = openMainWindow();
  });

  const cleanup = () => {
    quitting = true;
    void updates?.then((u) => u.dispose());
    supervisor.shutdown(); // synchronous tree kill: taskkill /T /F, or SIGKILL to the process group
  };
  // POSIX: give the engine a chance to roll back open transactions (SIGTERM to its process group, bounded wait,
  // then SIGKILL) before quitting. Windows keeps the immediate taskkill.
  let engineStopped = os === 'win32' || supervisor.isExternal;
  app.on('before-quit', (e) => {
    if (!engineStopped && supervisor.pid !== undefined) {
      e.preventDefault();
      quitting = true;
      log.write('main', 'stopping engine (SIGTERM)');
      void supervisor.shutdownGracefully(5_000).finally(() => { engineStopped = true; app.quit(); });
      return;
    }
    engineStopped = true;
    cleanup();
    log.write('main', 'quitting');
  });
  app.on('will-quit', () => { cleanup(); log.close(); });
  process.on('exit', cleanup);
  app.on('window-all-closed', () => { if (quitWhenAllWindowsClosed(os) || quitting) app.quit(); });

  function openMainWindow(): BrowserWindow {
    const win = createMainWindow({
      preloadPath: path.join(__dirname, 'preload.js'),
      appVersion: app.getVersion(),
      devUrl,
      show: !smokeTest,
    });
    win.on('page-title-updated', (e) => { if (titleLocked) e.preventDefault(); });
    win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.write('main', `renderer gone: ${details.reason} (${details.exitCode})`);
      if (details.reason !== 'clean-exit' && !quitting && mainWindow === win) loadUi();
    });
    // A re-created window (macOS activate) loads the UI itself; the first one is loaded after the engine start.
    if (engineStartedOnce) void win.loadURL(uiEntryUrl(devUrl));
    return win;
  }
}

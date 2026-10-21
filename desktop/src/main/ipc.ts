// IPC handlers behind window.dbstudio. Every handler checks the sender's origin and validates its arguments.
import { BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import type { EngineInfo } from '../../../ui/src/platform/bridge';
import { IPC } from '../shared/channels';
import { atomicWriteFile, readTextFileDecoded, SerialQueue } from './fs-utils';
import { workspaceFile } from './paths';
import type { UpdateController } from './updater-core';
import {
  LIMITS,
  serializeWorkspace,
  validateExternalUrl,
  validateFileContent,
  validateFilePath,
  validateMenuPosition,
  validateOpenDialogArgs,
  validateSaveDialogArgs,
  validateTitle,
  validateTitleBarTheme,
  validateUpdateCheckArgs,
  validateUpdateConfig,
  type TitleBarThemeArgs,
} from './validate';
import { isAllowedUrl } from './window';

export interface IpcDeps {
  getEngineInfo(): Promise<EngineInfo>;
  devUrl?: string;
  /** Called when the renderer sets a title (main also stops page <title> from overriding it). */
  onTitle?(win: BrowserWindow, title: string): void;
  /** The auto-updater (created asynchronously at startup). */
  updates?(): Promise<UpdateController>;
  /** Applies the renderer's theme to the window chrome (caption-button overlay, native light/dark mode). */
  onTitleBarTheme?(win: BrowserWindow, theme: TitleBarThemeArgs): void;
}

function assertTrustedSender(e: IpcMainInvokeEvent | IpcMainEvent, devUrl?: string): void {
  const url = e.senderFrame?.url ?? '';
  if (!isAllowedUrl(url, devUrl)) throw new Error(`Blocked IPC from untrusted origin: ${url || '<unknown>'}`);
}

/** Workspace persistence: serialized writes, atomic rename, one backup generation. */
const workspaceQueue = new SerialQueue();

export async function loadWorkspace(file = workspaceFile()): Promise<unknown | null> {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const text = await fs.promises.readFile(candidate, 'utf8');
      return JSON.parse(text) as unknown;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Corrupt JSON: fall through to the backup.
    }
  }
  return null;
}

export function saveWorkspace(data: unknown, file = workspaceFile()): Promise<void> {
  const json = serializeWorkspace(data);
  return workspaceQueue.run(async () => {
    try {
      await fs.promises.copyFile(file, `${file}.bak`);
    } catch { /* first save */ }
    await atomicWriteFile(file, json);
  });
}

export function registerIpc(deps: IpcDeps): void {
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, ...args) => {
      assertTrustedSender(e, deps.devUrl);
      return fn(e, ...args);
    });
  };
  const ownerWindow = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender) ?? undefined;

  handle(IPC.getEngineInfo, () => deps.getEngineInfo());

  handle(IPC.showSaveDialog, async (e, opts) => {
    const o = validateSaveDialogArgs(opts);
    const options: Electron.SaveDialogOptions = { title: o.title, defaultPath: o.defaultPath, filters: o.filters, properties: ['showOverwriteConfirmation'] };
    const win = ownerWindow(e);
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    return r.canceled || !r.filePath ? null : r.filePath;
  });

  handle(IPC.showOpenDialog, async (e, opts) => {
    const o = validateOpenDialogArgs(opts);
    // promptToCreate (Windows): lets the user type a new file name, e.g. a new SQLite database.
    const options: Electron.OpenDialogOptions = {
      title: o.title,
      filters: o.filters,
      properties: o.createIfMissing ? ['openFile', 'promptToCreate'] : ['openFile'],
    };
    const win = ownerWindow(e);
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  handle(IPC.readTextFile, async (_e, p) => readTextFileDecoded(validateFilePath(p), LIMITS.readBytes));

  handle(IPC.writeTextFile, async (_e, p, content) => {
    await atomicWriteFile(validateFilePath(p), validateFileContent(content));
  });

  handle(IPC.openExternal, async (_e, url) => {
    await shell.openExternal(validateExternalUrl(url));
  });

  handle(IPC.loadWorkspace, () => loadWorkspace());
  handle(IPC.saveWorkspace, (_e, data) => saveWorkspace(data));

  const updates = async () => {
    if (!deps.updates) throw new Error('Updates are not available.');
    return deps.updates();
  };
  handle(IPC.updatesGetStatus, async () => (await updates()).status);
  handle(IPC.updatesCheck, async (_e, opts) => {
    const o = validateUpdateCheckArgs(opts);
    return (await updates()).check(o);
  });
  handle(IPC.updatesConfigure, async (_e, opts) => {
    const o = validateUpdateConfig(opts);
    (await updates()).configure(o);
  });
  handle(IPC.updatesQuitAndInstall, async () => (await updates()).quitAndInstall());

  // Fire-and-forget channels: bad input is ignored.
  const on = (channel: string, fn: (e: IpcMainEvent, win: BrowserWindow, ...args: unknown[]) => void) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, (e, ...args) => {
      try {
        assertTrustedSender(e, deps.devUrl);
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) fn(e, win, ...args);
      } catch {
        /* ignore */
      }
    });
  };
  on(IPC.setTitleBarTheme, (_e, win, theme) => deps.onTitleBarTheme?.(win, validateTitleBarTheme(theme)));
  on(IPC.showAppMenu, (_e, win, pos) => {
    const p = validateMenuPosition(pos);
    Menu.getApplicationMenu()?.popup({ window: win, x: p.x, y: p.y });
  });

  ipcMain.removeAllListeners(IPC.setTitle);
  ipcMain.on(IPC.setTitle, (e, title) => {
    try {
      assertTrustedSender(e, deps.devUrl);
      const t = validateTitle(title);
      const win = BrowserWindow.fromWebContents(e.sender);
      if (win && !win.isDestroyed()) {
        win.setTitle(t);
        deps.onTitle?.(win, t);
      }
    } catch {
      /* fire-and-forget channel: ignore bad input */
    }
  });
}

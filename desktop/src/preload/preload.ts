// Sandboxed preload: exposes window.dbstudio (the DbStudioBridge contract from ui/src/platform/bridge.ts).
// Only `electron` may be required at runtime; esbuild inlines ../shared/channels.
import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron';
import type { DbStudioBridge, EngineInfo, FileFilter, MenuCommand, TitleBarTheme, UpdateStatus } from '../../../ui/src/platform/bridge';
import { desktopOs, htmlPlatformClasses, htmlPlatformVars, parseChromeArg, type DesktopPlatformInfo } from '../main/platform';
import { APP_VERSION_ARG, IPC } from '../shared/channels';

function readAppVersion(): string {
  const arg = process.argv.find((a) => a.startsWith(APP_VERSION_ARG));
  return arg ? arg.slice(APP_VERSION_ARG.length) : '0.0.0';
}

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const bridge: DbStudioBridge = {
  platform: 'electron',
  appVersion: readAppVersion(),
  getEngineInfo: () => ipcRenderer.invoke(IPC.getEngineInfo) as Promise<EngineInfo>,
  showSaveDialog: (opts: { title?: string; defaultPath?: string; filters?: FileFilter[] }) =>
    ipcRenderer.invoke(IPC.showSaveDialog, opts) as Promise<string | null>,
  showOpenDialog: (opts: { title?: string; filters?: FileFilter[]; createIfMissing?: boolean }) =>
    ipcRenderer.invoke(IPC.showOpenDialog, opts) as Promise<string | null>,
  readTextFile: (path: string) => ipcRenderer.invoke(IPC.readTextFile, path) as Promise<string>,
  writeTextFile: (path: string, content: string) =>
    ipcRenderer.invoke(IPC.writeTextFile, path, content) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  onMenuCommand: (cb: (cmd: MenuCommand) => void) => subscribe<MenuCommand>(IPC.menuCommand, cb),
  onEngineRestarted: (cb: (info: EngineInfo) => void) => subscribe<EngineInfo>(IPC.engineRestarted, cb),
  loadWorkspace: () => ipcRenderer.invoke(IPC.loadWorkspace) as Promise<unknown | null>,
  saveWorkspace: (data: unknown) => ipcRenderer.invoke(IPC.saveWorkspace, data) as Promise<void>,
  setTitle: (title: string) => { ipcRenderer.send(IPC.setTitle, title); },
  // Page zoom in the renderer itself (no IPC): Chromium scales devicePixelRatio, so canvases stay sharp.
  setZoomFactor: (factor: number) => {
    if (typeof factor !== 'number' || !Number.isFinite(factor)) return;
    webFrame.setZoomFactor(Math.max(0.6, Math.min(2, factor)));
  },
  // Auto-update (desktop/src/main/updater.ts) and the window chrome (main validates every argument).
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => subscribe<UpdateStatus>(IPC.updateStatus, cb),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.updatesGetStatus) as Promise<UpdateStatus>,
  checkForUpdates: (opts?: { manual?: boolean }) => ipcRenderer.invoke(IPC.updatesCheck, opts ?? {}) as Promise<UpdateStatus>,
  configureUpdates: (opts: { autoCheck: boolean }) => ipcRenderer.invoke(IPC.updatesConfigure, opts) as Promise<void>,
  quitAndInstall: () => ipcRenderer.invoke(IPC.updatesQuitAndInstall) as Promise<boolean>,
  setTitleBarTheme: (theme: TitleBarTheme) => { ipcRenderer.send(IPC.setTitleBarTheme, theme); },
  showAppMenu: (pos: { x: number; y: number }) => { ipcRenderer.send(IPC.showAppMenu, pos); },
};

contextBridge.exposeInMainWorld('dbstudio', bridge);

// OS information outside the frozen DbStudioBridge contract (ui/src/platform/bridge.ts):
//  - window.dbstudioPlatform = { platform: 'win32' | 'darwin' | 'linux', arch, titleBar, nativeMaterial }
//  - <html class="platform-<os> [titlebar-inset | titlebar-overlay] [native-material]"> and the CSS variables
//    --titlebar-inset-left (78px on macOS: room for the traffic lights), --titlebar-overlay-fallback (Windows caption
//    buttons, until env(titlebar-area-*) is known) and --titlebar-drag, set before the UI runs.
const os = desktopOs(process.platform);
const chrome = parseChromeArg(process.argv);
const platformInfo: DesktopPlatformInfo = Object.freeze({
  platform: os,
  arch: process.arch,
  titleBar: chrome.titleBar,
  nativeMaterial: chrome.material !== 'none',
});
contextBridge.exposeInMainWorld('dbstudioPlatform', platformInfo);

function applyPlatformToDocument(): boolean {
  const html = document.documentElement;
  if (!html) return false;
  html.classList.add(...htmlPlatformClasses(os, chrome));
  for (const [name, value] of Object.entries(htmlPlatformVars(os, chrome))) html.style.setProperty(name, value);
  return true;
}
if (!applyPlatformToDocument()) document.addEventListener('DOMContentLoaded', () => { applyPlatformToDocument(); }, { once: true });

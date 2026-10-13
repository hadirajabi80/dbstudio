// Sandboxed preload: exposes window.dbstudio (the DbStudioBridge contract from ui/src/platform/bridge.ts).
// Only `electron` may be required at runtime; esbuild inlines ../shared/channels.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DbStudioBridge, EngineInfo, FileFilter, MenuCommand } from '../../../ui/src/platform/bridge';
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
};

contextBridge.exposeInMainWorld('dbstudio', bridge);

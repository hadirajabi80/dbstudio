import type { DbStudioBridge, NotificationOptions, TitleBarTheme } from './bridge';
import type { Platform } from './types';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function createElectronPlatform(b: DbStudioBridge): Platform {
  return {
    kind: 'electron',
    appVersion: b.appVersion,
    hasFileSystem: true,
    getEngineInfo: () => b.getEngineInfo(),
    showSaveDialog: (o) => b.showSaveDialog(o),
    showOpenDialog: (o) => b.showOpenDialog(o),
    async saveFile({ suggestedName, filters, content }) {
      const path = await b.showSaveDialog({ defaultPath: suggestedName, filters });
      if (!path) return null;
      const text = typeof content === 'string' ? content : await content.text();
      await b.writeTextFile(path, text);
      return path;
    },
    async openTextFile({ filters }) {
      const path = await b.showOpenDialog({ filters });
      if (!path) return null;
      return { name: baseName(path), path, content: await b.readTextFile(path) };
    },
    writeTextFile: (p, c) => b.writeTextFile(p, c),
    openExternal: (u) => b.openExternal(u),
    onMenuCommand: (cb) => b.onMenuCommand(cb),
    onEngineRestarted: (cb) => b.onEngineRestarted(cb),
    loadWorkspace: () => b.loadWorkspace(),
    saveWorkspace: (d) => b.saveWorkspace(d),
    setTitle: (t) => b.setTitle(t),
    ...(typeof b.setZoomFactor === 'function' ? { setZoomFactor: (f: number) => b.setZoomFactor!(f) } : {}),
    // Additive bridge members: only present when this preload has them.
    ...(typeof b.onUpdateStatus === 'function' ? { onUpdateStatus: (cb: Parameters<NonNullable<DbStudioBridge['onUpdateStatus']>>[0]) => b.onUpdateStatus!(cb) } : {}),
    ...(typeof b.getUpdateStatus === 'function' ? { getUpdateStatus: () => b.getUpdateStatus!() } : {}),
    ...(typeof b.checkForUpdates === 'function' ? { checkForUpdates: (o?: { manual?: boolean }) => b.checkForUpdates!(o) } : {}),
    ...(typeof b.configureUpdates === 'function' ? { configureUpdates: (o: { autoCheck: boolean }) => b.configureUpdates!(o) } : {}),
    ...(typeof b.quitAndInstall === 'function' ? { quitAndInstall: () => b.quitAndInstall!() } : {}),
    ...(typeof b.setTitleBarTheme === 'function' ? { setTitleBarTheme: (t: TitleBarTheme) => b.setTitleBarTheme!(t) } : {}),
    ...(typeof b.showAppMenu === 'function' ? { showAppMenu: (pos: { x: number; y: number }) => b.showAppMenu!(pos) } : {}),
    // ---- notifications
    ...(typeof b.showNotification === 'function' ? { showNotification: (o: NotificationOptions) => b.showNotification!(o) } : {}),
  };
}

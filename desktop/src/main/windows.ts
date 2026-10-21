// Detached tab windows ("Open in new window", dragging a tab out of the window): a secondary BrowserWindow runs its
// own copy of the UI (URL hash #detached, --dbstudio-window-role=detached) on the same engine. It skips engine
// supervision, the updater and workspace autosave; main keeps the tabs it shows (src/main/windows-core.ts).
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC, WINDOW_ROLE_ARG } from '../shared/channels';
import { DetachedWindows, validateOpenTabWindowArgs, validateTabs } from './windows-core';
import { createMainWindow, isAllowedUrl, uiEntryUrl } from './window';

export interface WindowIpcDeps {
  preloadPath: string;
  appVersion: string;
  devUrl?: string;
  /** The main window, if open. */
  primary(): BrowserWindow | null;
  /** Called for every new detached window (page-title lock, crash logging). */
  onCreated?(win: BrowserWindow): void;
  /** false keeps detached windows hidden (smoke test). */
  show?: boolean;
}

function assertTrusted(e: IpcMainInvokeEvent | IpcMainEvent, devUrl?: string): void {
  const url = e.senderFrame?.url ?? '';
  if (!isAllowedUrl(url, devUrl)) throw new Error(`Blocked IPC from untrusted origin: ${url || '<unknown>'}`);
}

/** URL of a detached window: the UI entry with the #detached route. */
export function detachedWindowUrl(devUrl?: string): string {
  const base = uiEntryUrl(devUrl);
  return `${base.replace(/#.*$/, '')}#detached`;
}

export function registerWindowIpc(deps: WindowIpcDeps): DetachedWindows<BrowserWindow> {
  const windows = new DetachedWindows<BrowserWindow>({
    primary: deps.primary,
    create: ({ position }) => {
      const win = createMainWindow({
        preloadPath: deps.preloadPath,
        appVersion: deps.appVersion,
        devUrl: deps.devUrl,
        show: deps.show,
        kind: 'secondary',
        position,
        extraArgs: [`${WINDOW_ROLE_ARG}detached`],
      });
      deps.onCreated?.(win);
      void win.loadURL(detachedWindowUrl(deps.devUrl));
      return win;
    },
  });

  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, ...args) => {
      assertTrusted(e, deps.devUrl);
      return fn(e, ...args);
    });
  };
  const on = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, (e, ...args) => {
      try {
        assertTrusted(e, deps.devUrl);
        fn(e, ...args);
      } catch {
        /* fire-and-forget channel: bad input is ignored */
      }
    });
  };

  handle(IPC.openTabWindow, (_e, opts) => windows.open(validateOpenTabWindowArgs(opts)));
  handle(IPC.getDetachedTabs, (e) => windows.tabsOf(e.sender.id));
  handle(IPC.reattachTabs, (e, tabs) => windows.reattach(e.sender.id, validateTabs(tabs)));
  handle(IPC.listDetachedTabs, () => windows.allTabs());
  on(IPC.reportDetachedTabs, (e, tabs) => windows.update(e.sender.id, validateTabs(tabs)));
  on(IPC.closeDetachedWindow, (e) => windows.closeEmpty(e.sender.id));
  return windows;
}

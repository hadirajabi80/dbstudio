import type { EngineInfo, FileFilter, MenuCommand, NotificationOptions, TitleBarTheme, UpdateStatus } from './bridge';

export type { EngineInfo, FileFilter, MenuCommand, NotificationOptions, TitleBarTheme, UpdateStatus };

/** What the app needs from its host. Electron delegates to window.dbstudio; the browser uses fallbacks. */
export interface Platform {
  kind: 'electron' | 'browser';
  appVersion: string;
  getEngineInfo(): Promise<EngineInfo>;
  /** True when native dialogs can return file-system paths (Electron). */
  readonly hasFileSystem: boolean;
  /** Native save dialog. Browser: always null (callers fall back to a download). */
  showSaveDialog(opts: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  /** Native open dialog. Browser: null (no paths in a browser; callers let the user type one). */
  showOpenDialog(opts: { title?: string; filters?: FileFilter[]; createIfMissing?: boolean }): Promise<string | null>;
  /** Save content the browser way (<a download>) or, in Electron, through a save dialog. Returns the path or file name. */
  saveFile(opts: { suggestedName: string; filters?: FileFilter[]; content: Blob | string; mime?: string }): Promise<string | null>;
  /** Pick a text file and read it. */
  openTextFile(opts: { filters?: FileFilter[] }): Promise<{ name: string; path: string | null; content: string } | null>;
  writeTextFile(path: string, content: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onMenuCommand(cb: (cmd: MenuCommand) => void): () => void;
  onEngineRestarted(cb: (info: EngineInfo) => void): () => void;
  loadWorkspace(): Promise<unknown | null>;
  saveWorkspace(data: unknown): Promise<void>;
  setTitle(title: string): void;
  /**
   * Desktop only: native page zoom (Electron webFrame), which scales devicePixelRatio so canvases stay sharp.
   * Absent in the browser, where the app falls back to CSS zoom.
   */
  setZoomFactor?(factor: number): void;
  /** Desktop only (absent in the browser and with older preloads): auto-update through GitHub Releases. */
  onUpdateStatus?(cb: (status: UpdateStatus) => void): () => void;
  getUpdateStatus?(): Promise<UpdateStatus>;
  checkForUpdates?(opts?: { manual?: boolean }): Promise<UpdateStatus>;
  configureUpdates?(opts: { autoCheck: boolean }): Promise<void>;
  quitAndInstall?(): Promise<boolean>;
  /** Desktop only: window chrome (caption buttons, native light/dark mode) follows the app theme. */
  setTitleBarTheme?(theme: TitleBarTheme): void;
  /** Desktop only (Windows overlay title bar, which hides the native menu bar): the application menu as a popup. */
  showAppMenu?(pos: { x: number; y: number }): void;
  // ---- notifications
  /** Desktop only: an OS notification while the window is in the background (main decides; fire-and-forget). */
  showNotification?(opts: NotificationOptions): void;
}

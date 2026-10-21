// Contract between the renderer (WP-C) and the Electron preload (WP-E).
// In Electron, preload exposes `window.dbstudio: DbStudioBridge` via contextBridge.
// In a plain browser it is undefined and ui/src/platform/browser.ts provides fallbacks.

export interface EngineInfo {
  /** e.g. "http://127.0.0.1:51234" */
  baseUrl: string;
  token: string;
}

export interface FileFilter { name: string; extensions: string[] }

/** Commands sent from the native menu to the renderer (accelerators live in the menu). */
export type MenuCommand =
  | 'newConnection' | 'newQueryTab' | 'openFile' | 'saveFile' | 'saveFileAs' | 'closeTab'
  | 'runStatement' | 'runScript' | 'cancel' | 'commit' | 'rollback'
  | 'toggleResults' | 'toggleExplorer' | 'commandPalette' | 'toggleTheme' | 'showHistory'
  | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'about';

export interface DbStudioBridge {
  platform: 'electron';
  appVersion: string;
  getEngineInfo(): Promise<EngineInfo>;
  /** Returns the chosen path or null if cancelled. */
  showSaveDialog(opts: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  showOpenDialog(opts: { title?: string; filters?: FileFilter[]; createIfMissing?: boolean }): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Subscribe to native menu commands. Returns an unsubscribe function. */
  onMenuCommand(cb: (cmd: MenuCommand) => void): () => void;
  /** Engine process died; the main process shows a restart dialog and calls this after a restart with fresh info. */
  onEngineRestarted(cb: (info: EngineInfo) => void): () => void;
  /** Workspace (open tabs, unsaved text) persistence in %APPDATA%\DbStudio\workspace.json. */
  loadWorkspace(): Promise<unknown | null>;
  saveWorkspace(data: unknown): Promise<void>;
  setTitle(title: string): void;
  /**
   * Additive (optional, older preloads lack it): page zoom via webFrame.setZoomFactor, 0.6–2. Renderer-side only,
   * no IPC; Chromium then renders canvases at the zoomed devicePixelRatio.
   */
  setZoomFactor?(factor: number): void;

  // ---- Additive (optional, older preloads lack them): auto-update and the Windows title bar overlay. ----
  /** Update status pushed by the main process (desktop/src/main/updater-core.ts). Returns an unsubscribe function. */
  onUpdateStatus?(cb: (status: UpdateStatus) => void): () => void;
  /** The current update status (e.g. after a renderer reload). */
  getUpdateStatus?(): Promise<UpdateStatus>;
  /** Checks GitHub Releases now; resolves with the outcome (never rejects for network errors: state 'error'). */
  checkForUpdates?(opts?: { manual?: boolean }): Promise<UpdateStatus>;
  /** The "Automatically check for updates" setting (no automatic check runs before the renderer reports it). */
  configureUpdates?(opts: { autoCheck: boolean }): Promise<void>;
  /** Restart now and install the downloaded update; false when there is nothing to install. */
  quitAndInstall?(): Promise<boolean>;
  /** Keeps the native caption buttons (Windows overlay) and the window's light/dark mode in step with the app theme. */
  setTitleBarTheme?(theme: TitleBarTheme): void;
  /** Windows (no native menu bar with the overlay title bar): pops the application menu up at a window position. */
  showAppMenu?(pos: { x: number; y: number }): void;
}

export type UpdateMode = 'install' | 'notify' | 'disabled';
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  /** install: downloaded in the background, restart to install. notify: only announced (ad-hoc signed macOS). */
  mode: UpdateMode;
  currentVersion: string;
  /** The new version (available / downloading / ready). */
  version?: string;
  /** Download progress 0–100 (downloading). */
  percent?: number;
  /** GitHub release page of `version`. */
  releaseUrl?: string;
  /** Why updates are disabled, or the (logged) error. */
  message?: string;
}

export interface TitleBarTheme {
  /** The theme setting: drives the window's native light/dark mode (material tint, native menus). */
  theme: 'system' | 'light' | 'dark';
  /** Caption-button background (#rrggbb or #rrggbbaa; transparent over a native material). */
  color: string;
  /** Caption-button glyph colour (#rrggbb). */
  symbolColor: string;
  /** Overlay height in device-independent pixels (the top bar height times the page zoom). */
  height?: number;
}

declare global {
  interface Window { dbstudio?: DbStudioBridge }
}

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
}

declare global {
  interface Window { dbstudio?: DbStudioBridge }
}

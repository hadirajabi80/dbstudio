// IPC channel names shared by main and preload. The preload is bundled by esbuild, so it may
// import this module even though it runs sandboxed (sandboxed preloads cannot require local files).
import type { MenuCommand } from '../../../ui/src/platform/bridge';

export const IPC = {
  getEngineInfo: 'dbstudio:get-engine-info',
  showSaveDialog: 'dbstudio:show-save-dialog',
  showOpenDialog: 'dbstudio:show-open-dialog',
  readTextFile: 'dbstudio:read-text-file',
  writeTextFile: 'dbstudio:write-text-file',
  openExternal: 'dbstudio:open-external',
  loadWorkspace: 'dbstudio:load-workspace',
  saveWorkspace: 'dbstudio:save-workspace',
  setTitle: 'dbstudio:set-title',
  // ---- windows (detached tab windows: src/main/windows.ts)
  openTabWindow: 'dbstudio:open-tab-window',
  /** detached window: the tabs it shows */
  getDetachedTabs: 'dbstudio:get-detached-tabs',
  /** detached window -> main (send) */
  reportDetachedTabs: 'dbstudio:report-detached-tabs',
  /** detached window: hand tabs back to the main window */
  reattachTabs: 'dbstudio:reattach-tabs',
  /** detached window -> main (send) */
  closeDetachedWindow: 'dbstudio:close-detached-window',
  /** main window: tabs of every detached window */
  listDetachedTabs: 'dbstudio:list-detached-tabs',
  /** main -> main window */
  detachedTabs: 'dbstudio:detached-tabs',
  /** main -> main window */
  tabsReattached: 'dbstudio:tabs-reattached',
  // ---- end windows
  /** main -> renderer */
  menuCommand: 'dbstudio:menu-command',
  /** main -> renderer */
  engineRestarted: 'dbstudio:engine-restarted',
  updatesCheck: 'dbstudio:updates-check',
  updatesGetStatus: 'dbstudio:updates-get-status',
  updatesConfigure: 'dbstudio:updates-configure',
  updatesQuitAndInstall: 'dbstudio:updates-quit-and-install',
  /** main -> renderer */
  updateStatus: 'dbstudio:update-status',
  /** renderer -> main (send) */
  setTitleBarTheme: 'dbstudio:set-titlebar-theme',
  /** renderer -> main (send) */
  showAppMenu: 'dbstudio:show-app-menu',
  // ---- notifications
  /** renderer -> main (send): an OS notification while the window is not focused */
  notify: 'dbstudio:notify',
} as const;

/** Passed to the renderer through webPreferences.additionalArguments, read by the preload. */
export const APP_VERSION_ARG = '--dbstudio-app-version=';
// ---- windows
/** additionalArguments of a detached tab window ("detached"); the main window has none. */
export const WINDOW_ROLE_ARG = '--dbstudio-window-role=';

/** Every MenuCommand in the contract. The type assertions below fail to compile if the contract changes. */
export const MENU_COMMANDS = [
  'newConnection', 'newQueryTab', 'openFile', 'saveFile', 'saveFileAs', 'closeTab',
  'runStatement', 'runScript', 'cancel', 'commit', 'rollback',
  'toggleResults', 'toggleExplorer', 'commandPalette', 'toggleTheme', 'showHistory',
  'zoomIn', 'zoomOut', 'zoomReset', 'about',
] as const satisfies readonly MenuCommand[];

type Missing = Exclude<MenuCommand, (typeof MENU_COMMANDS)[number]>;
// If this line errors, a MenuCommand was added to bridge.ts and is missing above.
export const MENU_COMMANDS_EXHAUSTIVE: [Missing] extends [never] ? true : Missing = true;

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === 'string' && (MENU_COMMANDS as readonly string[]).includes(value);
}

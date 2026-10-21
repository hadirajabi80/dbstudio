// Detached tab windows (desktop only): the renderer side of the `// ---- windows` part of the preload bridge. Every
// Electron window runs its own copy of the UI; a detached window shows tabs moved out of the main window and hands
// them back through the main process. In a browser (and with older preloads) none of this is available.
import type { DbStudioBridge } from './bridge';

export type WindowsBridge = Required<Pick<DbStudioBridge,
  'openTabWindow' | 'getDetachedTabs' | 'reportDetachedTabs' | 'reattachTabs' | 'closeDetachedWindow' | 'listDetachedTabs' | 'onDetachedTabs' | 'onTabsReattached'
>>;

let override: WindowsBridge | null | undefined;
let roleOverride: 'main' | 'detached' | undefined;

function bridge(): DbStudioBridge | undefined {
  return typeof window !== 'undefined' ? window.dbstudio : undefined;
}

/** The window API, or null when tabs cannot be opened in their own window (browser, older preload). */
export function windowsApi(): WindowsBridge | null {
  if (override !== undefined) return override;
  const b = bridge();
  return b && typeof b.openTabWindow === 'function' && typeof b.reattachTabs === 'function' ? (b as WindowsBridge) : null;
}

/** True in a window opened by "Open in new window" (the URL carries `#detached` too, so a reload keeps the role). */
export function isDetachedWindow(): boolean {
  if (roleOverride) return roleOverride === 'detached';
  if (bridge()?.windowRole === 'detached') return true;
  // The hash alone means nothing in a browser (no window bridge to get the tabs from).
  return windowsApi() !== null && typeof window !== 'undefined' && window.location.hash.startsWith('#detached');
}

/** Tests: substitute the bridge (null: unsupported) and the window role; no arguments restore the defaults. */
export function setWindowsApiForTests(api?: WindowsBridge | null, role?: 'main' | 'detached'): void {
  override = api;
  roleOverride = role;
}

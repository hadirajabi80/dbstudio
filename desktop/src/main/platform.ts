// Per-OS decisions for the shell, kept free of `electron` imports so they are unit tested in plain Node
// (test/platform.test.mjs) for every OS from any OS.

export type DesktopOs = 'win32' | 'darwin' | 'linux';

/** process.platform narrowed to the three platforms DbStudio knows; BSDs etc. behave like Linux. */
export function desktopOs(platform: NodeJS.Platform = process.platform): DesktopOs {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

/** macOS convention: the app (and its engine) keeps running with no windows until Cmd+Q. */
export function quitWhenAllWindowsClosed(os: DesktopOs): boolean {
  return os !== 'darwin';
}

/** Height of the renderer's top bar (ui/src/theme/tokens.css --topbar-h). The traffic lights are centred in it. */
export const TOPBAR_HEIGHT_PX = 40;
/** Room the macOS traffic lights need on the left of the top bar (x offset + three buttons + gap). */
export const TRAFFIC_LIGHT_INSET_PX = 78;

export interface WindowChrome {
  titleBarStyle?: 'hiddenInset';
  trafficLightPosition?: { x: number; y: number };
}

/**
 * macOS: no native title bar; the traffic lights sit inside the renderer's top bar, which becomes the drag region.
 * Windows/Linux: the native frame and menu bar, unchanged.
 */
export function windowChrome(os: DesktopOs): WindowChrome {
  if (os !== 'darwin') return {};
  // The buttons are ~14 px tall: centre them vertically in the 40 px bar.
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: Math.round((TOPBAR_HEIGHT_PX - 14) / 2) } };
}

/**
 * Classes the preload puts on <html> so CSS can adapt: always `platform-<os>`, plus `titlebar-inset` when the
 * renderer draws the title bar (macOS hiddenInset).
 */
export function htmlPlatformClasses(os: DesktopOs): string[] {
  return os === 'darwin' ? ['platform-darwin', 'titlebar-inset'] : [`platform-${os}`];
}

/** CSS custom properties the preload sets on <html> (used by the UI: ui/src/theme/shell.css styles html.titlebar-inset .topbar). */
export function htmlPlatformVars(os: DesktopOs): Record<string, string> {
  return {
    '--titlebar-inset-left': os === 'darwin' ? `${TRAFFIC_LIGHT_INSET_PX}px` : '0px',
    '--titlebar-drag': os === 'darwin' ? 'drag' : 'no-drag',
  };
}

/** Exposed by the preload as `window.dbstudioPlatform` (outside the frozen DbStudioBridge contract). */
export interface DesktopPlatformInfo {
  platform: DesktopOs;
  /** process.arch: 'x64' | 'arm64' | ... */
  arch: string;
}

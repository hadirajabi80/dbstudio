// Per-OS decisions for the shell, kept free of `electron` imports so they are unit tested in plain Node
// (test/platform.test.mjs) for every OS from any OS.

export type DesktopOs = 'win32' | 'darwin' | 'linux';

/** process.platform narrowed to the three platforms Rowlit knows; BSDs etc. behave like Linux. */
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
/**
 * Width of the Windows caption buttons (3 x 46 DIP) drawn by titleBarOverlay. The renderer reads the real value from
 * env(titlebar-area-*); this is only the fallback for a renderer that cannot.
 */
export const WINDOW_CONTROLS_WIDTH_PX = 138;
/** Windows 11 22H2: the first build where DWM system backdrops (BrowserWindow.backgroundMaterial) exist. */
export const WINDOWS_MATERIAL_MIN_BUILD = 22621;
/**
 * Windows backdrop. Mica rather than acrylic: Mica is tinted from the wallpaper (and the window's light/dark mode, which
 * main keeps in step with the app theme), so the top bar keeps the same colour, and its text the same contrast,
 * whatever window is behind Rowlit. Acrylic blurs the live content behind the window: measured on Windows 11, a dark
 * Rowlit over a white browser turned the acrylic bar mid-grey (and a light one over a dark window would turn dark),
 * and it costs GPU on every frame behind it. Microsoft recommends Mica for an app's base layer and title bar and
 * acrylic for transient surfaces (flyouts, menus).
 */
export const WINDOWS_MATERIAL = 'mica';
/** macOS vibrancy behind the top bar: the material Apple uses for title bars and unified toolbars. */
export const MAC_VIBRANCY = 'titlebar';
/** Fully transparent window background: the page paints everything except the glass top bar opaquely. */
export const TRANSPARENT_BG = '#00000000';

/** Who draws the title bar: the OS ('native'), the renderer around the macOS traffic lights, or around the Windows overlay. */
export type TitleBarKind = 'native' | 'inset' | 'overlay';
/** The system material shown through the renderer's translucent top bar ('none': solid bar, CSS fallback). */
export type WindowMaterial = 'mica' | 'vibrancy' | 'none';
export interface ChromeInfo { titleBar: TitleBarKind; material: WindowMaterial }

/** Build number of a Windows `os.release()` ("10.0.22631" -> 22631); 0 when it cannot be read. */
export function windowsBuild(release: string | undefined): number {
  const m = /^\d+\.\d+\.(\d+)/.exec(release ?? '');
  return m ? Number(m[1]) : 0;
}

/**
 * Title bar and material per OS. Windows: hidden title bar with the caption buttons as an overlay inside the top bar,
 * Mica behind it on Windows 11 22H2+, a solid bar on Windows 10. macOS: hiddenInset with vibrancy. Linux: native frame.
 */
export function chromeInfo(os: DesktopOs, osRelease?: string): ChromeInfo {
  if (os === 'darwin') return { titleBar: 'inset', material: 'vibrancy' };
  if (os === 'win32') return { titleBar: 'overlay', material: windowsBuild(osRelease) >= WINDOWS_MATERIAL_MIN_BUILD ? 'mica' : 'none' };
  return { titleBar: 'native', material: 'none' };
}

/** Caption-button colours used until the renderer reports its theme (ui/src/theme/titlebar.ts sends the token values). */
export function defaultTitleBarOverlay(dark: boolean, material: WindowMaterial): { color: string; symbolColor: string; height: number } {
  return {
    // Transparent: the renderer's glass top bar (and the material behind it) shows under the buttons.
    color: material !== 'none' ? TRANSPARENT_BG : dark ? '#1b1d21' : '#f5f6f8',
    symbolColor: dark ? '#e6e8eb' : '#1c1f24',
    height: TOPBAR_HEIGHT_PX,
  };
}

export interface WindowChrome {
  titleBarStyle?: 'hiddenInset' | 'hidden';
  trafficLightPosition?: { x: number; y: number };
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  backgroundMaterial?: typeof WINDOWS_MATERIAL;
  vibrancy?: typeof MAC_VIBRANCY;
  visualEffectState?: 'active';
  /** Only set when a material shows through (transparent); otherwise window.ts picks the solid theme colour. */
  backgroundColor?: string;
}

/**
 * BrowserWindow options for the title bar and the material behind the top bar.
 * macOS: no native title bar; the traffic lights sit inside the renderer's top bar, vibrancy shows through it.
 * Windows: no native title bar either; the caption buttons are a titleBarOverlay inside the top bar, Mica behind it
 * on Windows 11 (solid on Windows 10). Linux: the native frame and menu bar, unchanged.
 * The window background is transparent only when a material is used; the page itself keeps everything below the top
 * bar opaque (ui/src/theme/shell.css html.native-material), so only the top bar is see-through.
 */
export function windowChrome(os: DesktopOs, opts: { dark?: boolean; osRelease?: string } = {}): WindowChrome {
  const info = chromeInfo(os, opts.osRelease);
  if (os === 'darwin') {
    // The buttons are ~14 px tall: centre them vertically in the 40 px bar.
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: Math.round((TOPBAR_HEIGHT_PX - 14) / 2) },
      vibrancy: MAC_VIBRANCY,
      visualEffectState: 'active',
      backgroundColor: TRANSPARENT_BG,
    };
  }
  if (os === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: defaultTitleBarOverlay(opts.dark === true, info.material),
      ...(info.material === 'mica' ? { backgroundMaterial: WINDOWS_MATERIAL, backgroundColor: TRANSPARENT_BG } : {}),
    };
  }
  return {};
}

/** Passed to the renderer through webPreferences.additionalArguments ("--dbstudio-chrome=overlay:mica"). */
export const CHROME_ARG = '--dbstudio-chrome=';

export function chromeArg(info: ChromeInfo): string {
  return `${CHROME_ARG}${info.titleBar}:${info.material}`;
}

/** Reads CHROME_ARG back from argv; anything unexpected falls back to the native frame without material. */
export function parseChromeArg(argv: readonly string[]): ChromeInfo {
  const raw = argv.find((a) => a.startsWith(CHROME_ARG))?.slice(CHROME_ARG.length) ?? '';
  const [t, m] = raw.split(':');
  const titleBar: TitleBarKind = t === 'inset' || t === 'overlay' ? t : 'native';
  const material: WindowMaterial = m === 'mica' || m === 'vibrancy' ? m : 'none';
  return { titleBar, material };
}

/**
 * Classes the preload puts on <html> so CSS can adapt: always `platform-<os>`, plus `titlebar-inset` (macOS
 * hiddenInset) or `titlebar-overlay` (Windows caption-button overlay) when the renderer draws the title bar, and
 * `native-material` when a system material shows through the transparent top bar.
 */
export function htmlPlatformClasses(os: DesktopOs, chrome: ChromeInfo = chromeInfo(os)): string[] {
  const out = [`platform-${os}`];
  if (chrome.titleBar === 'inset') out.push('titlebar-inset');
  if (chrome.titleBar === 'overlay') out.push('titlebar-overlay');
  if (chrome.material !== 'none') out.push('native-material');
  return out;
}

/** CSS custom properties the preload sets on <html> (used by ui/src/theme/shell.css: html.titlebar-inset/-overlay .topbar). */
export function htmlPlatformVars(os: DesktopOs, chrome: ChromeInfo = chromeInfo(os)): Record<string, string> {
  return {
    '--titlebar-inset-left': chrome.titleBar === 'inset' ? `${TRAFFIC_LIGHT_INSET_PX}px` : '0px',
    '--titlebar-overlay-fallback': chrome.titleBar === 'overlay' ? `${WINDOW_CONTROLS_WIDTH_PX}px` : '0px',
    '--titlebar-drag': chrome.titleBar === 'native' ? 'no-drag' : 'drag',
  };
}

/** Exposed by the preload as `window.dbstudioPlatform` (outside the frozen DbStudioBridge contract). */
export interface DesktopPlatformInfo {
  platform: DesktopOs;
  /** process.arch: 'x64' | 'arm64' | ... */
  arch: string;
  /** Who draws the title bar (ui: the Windows overlay gets an application-menu button in the top bar). */
  titleBar: TitleBarKind;
  /** A system material (Mica, vibrancy) shows through the top bar. */
  nativeMaterial: boolean;
}

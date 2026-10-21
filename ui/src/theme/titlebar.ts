// Window chrome follows the app theme (Electron only): the theme setting drives the window's native light/dark mode
// (so Mica / vibrancy behind the glass top bar and native menus match the app), and on Windows the caption buttons
// (titleBarOverlay) take the top bar's colours from the tokens. Sent whenever the theme or the page zoom changes.
import { getPlatform } from '../platform';
import type { TitleBarTheme } from '../platform/bridge';
import { useSettings } from '../store/settings';
import { blend, parseColor, themeTokens, toHex, type TokenMap } from './index';
import type { EffectiveTheme } from './useTheme';

/**
 * Caption-button colours for a theme. Over a native material the background is transparent, so the material and the
 * glass bar show under the buttons; it keeps the bar's tint as its RGB so the buttons' hover highlight (drawn in the
 * colour of maximum contrast to it) stays visible. Without a material (Windows 10) it is the bar's opaque colour:
 * --glass-bg composited over --bg-app.
 */
export function titleBarOverlayColors(tokens: TokenMap, nativeMaterial: boolean): { color: string; symbolColor: string } {
  const c = (name: string) => parseColor(tokens[name] ?? '');
  const symbol = c('--titlebar-symbol');
  const glass = c(nativeMaterial ? '--glass-bg-native' : '--glass-bg');
  const app = c('--bg-app');
  if (!symbol || !glass || !app) throw new Error('title bar tokens missing');
  return {
    color: nativeMaterial ? toHex({ ...glass, a: 0 }) : toHex(blend(glass, app)),
    symbolColor: toHex({ ...blend(symbol, app), a: 1 }),
  };
}

let last = '';

/** Sends the current theme to the window chrome (no-op in the browser and with older preloads; deduplicated). */
export function syncTitleBar(theme?: EffectiveTheme): void {
  const p = getPlatform();
  if (typeof document === 'undefined' || !p.setTitleBarTheme) return;
  const html = document.documentElement;
  const eff: EffectiveTheme = theme ?? (html.dataset.theme === 'dark' ? 'dark' : 'light');
  const tokens = themeTokens(eff);
  let colors: { color: string; symbolColor: string };
  try {
    colors = titleBarOverlayColors(tokens, html.classList.contains('native-material'));
  } catch {
    return;
  }
  const zoom = Number(html.dataset.zoom) || 1;
  const bar = parseFloat(tokens['--topbar-h'] ?? '') || 40;
  const msg: TitleBarTheme = { theme: useSettings.getState().settings.theme, ...colors, height: Math.round(bar * zoom) };
  const key = JSON.stringify(msg);
  if (key === last) return;
  last = key;
  p.setTitleBarTheme(msg);
}

/** Tests. */
export function resetTitleBarSync(): void {
  last = '';
}

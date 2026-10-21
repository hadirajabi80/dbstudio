// UI zoom (styles-03). Desktop: Electron's webFrame zoom through the bridge, so devicePixelRatio scales and canvas
// content (the results grid, Monaco) renders sharply. Browser: CSS zoom on <html> as a fallback. The level is kept in
// settings.ui.zoom and restored on boot.
import { getPlatform } from '../platform';
import { uiSetting, useSettings } from '../store/settings';
import { syncTitleBar } from '../theme/titlebar';

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2;

let zoom = 1;

export function currentZoom(): number {
  return zoom;
}

/** Clamp to [0.6, 2] in 10 % steps. */
export function normalizeZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 10) / 10));
}

/** Apply a zoom level; `persist` stores it in settings.ui.zoom. */
export function setZoom(z: number, persist = true): void {
  zoom = normalizeZoom(z);
  const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string };
  const p = getPlatform();
  if (p.setZoomFactor) {
    style.zoom = '';
    p.setZoomFactor(zoom);
  } else {
    style.zoom = zoom === 1 ? '' : String(zoom);
  }
  document.documentElement.dataset.zoom = String(zoom);
  // The Windows caption-button overlay is sized in device pixels: keep it as tall as the zoomed top bar.
  syncTitleBar();
  if (persist) useSettings.getState().update({ ui: { zoom } });
}

/** Boot: restore the stored level (after settings were loaded). */
export function restoreZoom(): void {
  const z = Number(uiSetting<number>('zoom', 1));
  if (z !== 1 || zoom !== 1) setZoom(z, false);
}

/**
 * Height of the window in CSS pixels as the layout sees it: Electron's native zoom already shrinks innerHeight; the
 * browser fallback (CSS zoom on <html>) does not, so divide by the level there.
 */
export function effectiveViewportHeight(): number {
  if (typeof window === 'undefined') return 800;
  return getPlatform().setZoomFactor ? window.innerHeight : window.innerHeight / zoom;
}

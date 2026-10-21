import { useEffect, useState } from 'react';
import { resetCellColors } from '../components/Grid/cellColors';
import { useSettings } from '../store/settings';
import { applyDocumentVars, applyEditorScope, documentVars, getActiveTheme, notifyThemeChange, setActiveTheme, type ActiveTheme } from './activeTheme';
import { applyMonacoTheme } from './monacoTheme';
import { appThemeFor, editorThemeIdFor, type ThemeVars } from './themes';
import { syncTitleBar } from './titlebar';

export type EffectiveTheme = 'light' | 'dark';

const QUERY = '(prefers-color-scheme: dark)';

export function systemTheme(): EffectiveTheme {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches ? 'dark' : 'light';
}

/** Applies a theme to <html> (data-theme) before React renders, so the first paint already matches the OS. */
export function applyThemeAttribute(theme: EffectiveTheme): void {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
}

// The last applied mode and themes, so the next start paints the user's theme before the settings arrive (per-viewer
// convenience only: the settings stay the source of truth).
const BOOT_KEY = 'dbstudio.theme';
interface BootTheme { pref: string; light: ThemeVars; dark: ThemeVars }

function readBoot(): BootTheme | null {
  try {
    const v = JSON.parse(localStorage.getItem(BOOT_KEY) ?? 'null') as BootTheme | null;
    return v && typeof v === 'object' && typeof v.light === 'object' && typeof v.dark === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeBoot(v: BootTheme): void {
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the first paint just uses the default theme */
  }
}

/** First paint (main.tsx): the cached mode and theme colours, else the OS mode. */
export function applyBootTheme(): void {
  const boot = readBoot();
  const base: EffectiveTheme = boot?.pref === 'light' || boot?.pref === 'dark' ? boot.pref : systemTheme();
  applyThemeAttribute(base);
  if (boot) applyDocumentVars(boot[base]);
}

/** Applies a selection to the document: data-theme, the theme's custom properties, the code theme's token scope. */
function applySelection(t: ActiveTheme): void {
  applyThemeAttribute(t.base);
  applyDocumentVars(documentVars(t));
  applyEditorScope(t);
}

/**
 * Resolves settings.theme ('system', the default, follows the OS live) and the chosen app / code themes
 * (settings.ui, theme/themes.ts) and applies them: <html data-theme> and the theme's custom properties, the density
 * to <html data-density>, the token-derived Monaco theme and the window chrome.
 */
export function useEffectiveTheme(): EffectiveTheme {
  const pref = useSettings((s) => s.settings.theme);
  const density = useSettings((s) => s.settings.grid.density);
  const ui = useSettings((s) => s.settings.ui);
  const loaded = useSettings((s) => s.loaded);
  const [sys, setSys] = useState<EffectiveTheme>(systemTheme);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(QUERY);
    const fn = () => setSys(mq.matches ? 'dark' : 'light');
    fn(); // the OS may have switched between the first render and this effect
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
    else (mq as MediaQueryList & { addListener?: (f: () => void) => void }).addListener?.(fn);
    return () => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', fn);
      else (mq as MediaQueryList & { removeListener?: (f: () => void) => void }).removeListener?.(fn);
    };
  }, []);
  const eff: EffectiveTheme = pref === 'light' || pref === 'dark' ? pref : sys;
  const app = appThemeFor(ui, eff);
  const editorId = editorThemeIdFor(ui);
  // Applied during render (idempotent) so children that read CSS variables while rendering — the canvas grid
  // theme — already see the new values; the effect covers StrictMode/edge cases.
  if (setActiveTheme({ base: eff, app, editorId }, { notify: false })) resetCellColors();
  applySelection(getActiveTheme());
  useEffect(() => {
    applySelection(getActiveTheme());
    notifyThemeChange();
    void applyMonacoTheme();
  }, [eff, app, editorId]);
  useEffect(() => {
    if (!loaded) return;
    writeBoot({ pref, light: appThemeFor(ui, 'light').vars, dark: appThemeFor(ui, 'dark').vars });
  }, [loaded, pref, ui]);
  // Desktop: the window chrome (native light/dark mode, Windows caption buttons) follows the theme setting.
  useEffect(() => syncTitleBar(eff), [eff, pref, app]);
  useEffect(() => {
    document.documentElement.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
  }, [density]);
  return eff;
}

/** Same value for components below the root without re-subscribing to matchMedia. */
export function currentTheme(): EffectiveTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

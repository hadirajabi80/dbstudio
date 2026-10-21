import { useEffect, useState } from 'react';
import { useSettings } from '../store/settings';
import { applyMonacoTheme } from './monacoTheme';
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

/**
 * Resolves settings.theme ('system', the default, follows the OS live) and applies it to <html data-theme>,
 * the density to <html data-density>, and the token-derived Monaco theme.
 */
export function useEffectiveTheme(): EffectiveTheme {
  const pref = useSettings((s) => s.settings.theme);
  const density = useSettings((s) => s.settings.grid.density);
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
  // Applied during render (idempotent) so children that read CSS variables while rendering — the canvas grid
  // theme — already see the new values; the effect covers StrictMode/edge cases.
  applyThemeAttribute(eff);
  useEffect(() => {
    applyThemeAttribute(eff);
    void applyMonacoTheme(eff);
  }, [eff]);
  // Desktop: the window chrome (native light/dark mode, Windows caption buttons) follows the theme setting.
  useEffect(() => syncTitleBar(eff), [eff, pref]);
  useEffect(() => {
    document.documentElement.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
  }, [density]);
  return eff;
}

/** Same value for components below the root without re-subscribing to matchMedia. */
export function currentTheme(): EffectiveTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

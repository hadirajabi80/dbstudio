import { useEffect, useState } from 'react';
import { useSettings } from '../store/settings';

export type EffectiveTheme = 'light' | 'dark';

function systemTheme(): EffectiveTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Resolves settings.theme ('system' follows the OS live) and applies it to <html data-theme>. */
export function useEffectiveTheme(): EffectiveTheme {
  const pref = useSettings((s) => s.settings.theme);
  const [sys, setSys] = useState<EffectiveTheme>(systemTheme);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSys(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const eff = pref === 'system' ? sys : pref;
  // Applied during render (idempotent) so children that read CSS variables while rendering — the canvas grid
  // theme — already see the new values; the effect covers StrictMode/edge cases.
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme !== eff) document.documentElement.dataset.theme = eff;
  useEffect(() => {
    document.documentElement.dataset.theme = eff;
  }, [eff]);
  return eff;
}

/** Same value for components below the root without re-subscribing to matchMedia. */
export function currentTheme(): EffectiveTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

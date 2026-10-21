// Applying the chosen themes: settings.theme picks the mode, settings.ui the app theme of that mode and the code
// theme; the app theme's tokens land on <html> as custom properties (and leave again), the code theme re-scopes the
// tokens inside Monaco, the grid's revision hook fires, and the next start paints the cached theme first.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, useSettings } from '../store/settings';
import { getActiveTheme, resetActiveTheme, themeRevision, useThemeRevision } from './activeTheme';
import { APP_THEME_DARK_KEY, APP_THEME_LIGHT_KEY, appThemeById, EDITOR_THEME_KEY } from './themes';
import { applyBootTheme, useEffectiveTheme } from './useTheme';

const monaco = vi.hoisted(() => ({ apply: vi.fn(async () => undefined) }));
vi.mock('./monacoTheme', () => ({ applyMonacoTheme: monaco.apply }));

const html = () => document.documentElement;
const settings = (theme: 'system' | 'light' | 'dark', ui: Record<string, unknown> = {}) =>
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, theme, ui }, loaded: true }));

beforeEach(() => {
  resetActiveTheme();
  localStorage.clear();
  html().removeAttribute('style');
  document.getElementById('dbstudio-editor-theme')?.remove();
  monaco.apply.mockClear();
});
afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: false });
});

describe('useEffectiveTheme', () => {
  it('applies the app theme of the mode as custom properties, and removes them again', () => {
    settings('dark', { [APP_THEME_DARK_KEY]: 'nord', [APP_THEME_LIGHT_KEY]: 'paper' });
    const { result } = renderHook(() => useEffectiveTheme());
    expect(result.current).toBe('dark');
    expect(html().dataset.theme).toBe('dark');
    expect(html().style.getPropertyValue('--bg-panel')).toBe(appThemeById('nord')!.vars['--bg-panel']);
    expect(getActiveTheme().app.id).toBe('nord');
    expect(monaco.apply).toHaveBeenCalled();

    settings('light', { [APP_THEME_DARK_KEY]: 'nord', [APP_THEME_LIGHT_KEY]: 'paper' });
    expect(html().dataset.theme).toBe('light');
    expect(html().style.getPropertyValue('--bg-panel')).toBe(appThemeById('paper')!.vars['--bg-panel']);

    settings('light', {});
    expect(html().style.getPropertyValue('--bg-panel')).toBe('');
    expect(html().style.getPropertyValue('--glass-bg')).toBe('');
  });

  it('leaves inline styles it does not own alone (the preload sets title bar variables on <html>)', () => {
    html().style.setProperty('--titlebar-drag', 'drag');
    settings('dark', { [APP_THEME_DARK_KEY]: 'violet' });
    renderHook(() => useEffectiveTheme());
    settings('dark', {});
    expect(html().style.getPropertyValue('--titlebar-drag')).toBe('drag');
  });

  it('a code theme of its own re-scopes the tokens inside Monaco and sets the code surface', () => {
    settings('light', { [EDITOR_THEME_KEY]: 'monokai' });
    renderHook(() => useEffectiveTheme());
    const scope = document.getElementById('dbstudio-editor-theme');
    expect(scope?.textContent).toMatch(/^\.monaco-editor, \.monaco-diff-editor, \.monaco-component \{ color-scheme: dark;/);
    expect(scope?.textContent).toContain('--bg-panel: #272822;');
    expect(html().style.getPropertyValue('--code-bg')).toBe('#272822');
    settings('light', {});
    expect(document.getElementById('dbstudio-editor-theme')).toBeNull();
    expect(html().style.getPropertyValue('--code-bg')).toBe('');
  });

  it('bumps the theme revision on a switch within one mode (the grid re-reads its colours)', () => {
    settings('dark', {});
    renderHook(() => useEffectiveTheme());
    const rev = renderHook(() => useThemeRevision());
    const before = rev.result.current;
    settings('dark', { [APP_THEME_DARK_KEY]: 'midnight' });
    expect(themeRevision()).toBeGreaterThan(before);
    expect(rev.result.current).toBe(themeRevision());
  });

  it('caches the mode and both themes, so the next start paints them before the settings arrive', () => {
    settings('dark', { [APP_THEME_DARK_KEY]: 'midnight' });
    renderHook(() => useEffectiveTheme());
    html().removeAttribute('style');
    delete html().dataset.theme;
    applyBootTheme();
    expect(html().dataset.theme).toBe('dark');
    expect(html().style.getPropertyValue('--bg-app')).toBe(appThemeById('midnight')!.vars['--bg-app']);
  });
});

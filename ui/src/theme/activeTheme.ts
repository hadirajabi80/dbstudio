// The theme the app shows right now: the base mode (data-theme), the app theme (inline custom properties on <html>)
// and the code theme (the Monaco theme, plus the editor's own token scope). useTheme.ts sets it from the settings;
// the Monaco theme builder, the title bar sync and canvas consumers (the grid) read the *effective* tokens from here.
import { useSyncExternalStore } from 'react';
import { parseColor, firstColor, themeTokens, type TokenMap } from './index';
import { APP_THEMES, editorThemeById, MATCH_APP, type AppTheme, type ThemeBase, type ThemeVars } from './themes';

export interface ActiveTheme {
  base: ThemeBase;
  app: AppTheme;
  /** A code theme id of EDITOR_THEMES, or MATCH_APP. */
  editorId: string;
}

let active: ActiveTheme = { base: 'light', app: APP_THEMES[0], editorId: MATCH_APP };
let revision = 0;
const listeners = new Set<() => void>();

export function getActiveTheme(): ActiveTheme {
  return active;
}

/** Bumped whenever the effective colours change (also between two themes of the same base). */
export function themeRevision(): number {
  return revision;
}

/** Re-render on every colour change: canvas consumers memoize their colours on it (glide grid theme). */
export function useThemeRevision(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    themeRevision,
    themeRevision,
  );
}

/**
 * Stores the selection; true when it changed. `notify: false` while rendering (components rendered after the caller
 * read the new revision anyway); call notifyThemeChange() from an effect then.
 */
export function setActiveTheme(next: ActiveTheme, opts: { notify?: boolean } = {}): boolean {
  if (next.base === active.base && next.app.id === active.app.id && next.editorId === active.editorId) return false;
  active = next;
  revision++;
  if (opts.notify !== false) notifyThemeChange();
  return true;
}

/** Runs the revision listeners (useThemeRevision re-renders only components that rendered an older revision). */
export function notifyThemeChange(): void {
  for (const l of [...listeners]) l();
}

/** Resolved tokens of the app theme in its base (tokens.css + the theme's overrides). */
export function appTokens(t: ActiveTheme = active, css?: string): TokenMap {
  return css === undefined ? themeTokens(t.base, t.app.vars) : themeTokens(t.base, t.app.vars, css);
}

export interface EditorColors {
  base: ThemeBase;
  tokens: TokenMap;
  /** A code theme of its own (not derived from the app theme): the editor gets its own token scope. */
  standalone: boolean;
}

/** The code theme's base and tokens: the app tokens for "Match app theme", otherwise the code theme's own set. */
export function editorColors(t: ActiveTheme = active, css?: string): EditorColors {
  const ed = t.editorId === MATCH_APP ? undefined : editorThemeById(t.editorId);
  if (!ed) return { base: t.base, tokens: appTokens(t, css), standalone: false };
  const tokens = css === undefined ? themeTokens(ed.base, ed.vars) : themeTokens(ed.base, ed.vars, css);
  return { base: ed.base, tokens, standalone: true };
}

/** Resolved colour-valued tokens (colours and shadows) of a token map, for scoping them onto an element. */
export function colorTokens(tokens: TokenMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!k.startsWith('--') || k.startsWith('--glass') || k.startsWith('--titlebar')) continue;
    if (parseColor(v) || firstColor(v)) out[k] = v;
  }
  return out;
}

/**
 * The inline custom properties on <html> for a selection: the app theme's overrides, and the code surface tokens
 * (--code-bg / --code-fg, used by code previews outside Monaco) when a standalone code theme is chosen.
 */
export function documentVars(t: ActiveTheme = active): ThemeVars {
  const ed = editorColors(t);
  if (!ed.standalone) return t.app.vars;
  return { ...t.app.vars, '--code-bg': ed.tokens['--bg-panel'], '--code-fg': ed.tokens['--fg'] };
}

let appliedVars: string[] = [];

/** Sets the theme's custom properties on <html> (and removes the previous theme's), leaving other inline styles alone. */
export function applyDocumentVars(vars: ThemeVars): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  const next = Object.keys(vars);
  for (const k of appliedVars) if (!(k in vars)) style.removeProperty(k);
  for (const k of next) if (style.getPropertyValue(k) !== vars[k]) style.setProperty(k, vars[k]);
  appliedVars = next;
}

const SCOPE_ID = 'dbstudio-editor-theme';
/** Every Monaco surface: editors, diff editors, and the context views / menus Monaco renders in the light DOM. */
const SCOPE = '.monaco-editor, .monaco-diff-editor, .monaco-component';

/**
 * A standalone code theme also re-scopes the design tokens inside Monaco, so editor-widgets.css (suggest list muted
 * text, kind icons, hover chips) reads the code theme's colours on its widgets instead of the app's.
 */
export function applyEditorScope(t: ActiveTheme = active): void {
  if (typeof document === 'undefined') return;
  const ed = editorColors(t);
  let el = document.getElementById(SCOPE_ID);
  if (!ed.standalone) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = SCOPE_ID;
    document.head.appendChild(el);
  }
  // built once per code theme (this runs on every render of the shell)
  if (el.dataset.editorTheme === t.editorId && el.textContent) return;
  const body = Object.entries(colorTokens(ed.tokens)).map(([k, v]) => `${k}: ${v};`).join(' ');
  el.textContent = `${SCOPE} { color-scheme: ${ed.base}; ${body} }`;
  el.dataset.editorTheme = t.editorId;
}

/** Tests. */
export function resetActiveTheme(): void {
  active = { base: 'light', app: APP_THEMES[0], editorId: MATCH_APP };
  appliedVars = [];
  revision++;
}

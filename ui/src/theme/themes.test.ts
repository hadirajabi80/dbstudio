// Colour and code themes (theme/themes.ts): every app theme meets the same contrast matrix as tokens.css, every
// code theme (and every app theme used as a code theme) gives Monaco readable text, widgets and kind icons, the
// overrides only name real tokens, and the effective selection drives the Monaco theme, the document variables and
// the title bar colours.
import { afterEach, describe, expect, it } from 'vitest';
import { appTokens, colorTokens, documentVars, editorColors, resetActiveTheme, setActiveTheme, type ActiveTheme } from './activeTheme';
import { matrixFailures, TEXT, UI, withGlass } from './contrastMatrix';
import { contrast, parseColor, parseTokenBlocks, type TokenMap } from './index';
import { buildMonacoTheme, effectiveMonacoTheme, SUGGEST_KIND_COLORS } from './monacoTheme';
import {
  APP_THEMES, appThemeFor, appThemeById, APP_THEME_DARK_KEY, APP_THEME_LIGHT_KEY, EDITOR_THEME_KEY, EDITOR_THEMES, editorThemeIdFor, MATCH_APP,
  type ThemeBase,
} from './themes';
import { titleBarOverlayColors } from './titlebar';

interface NodeFs { readFileSync(p: string, enc: 'utf8'): string }
const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as NodeFs;
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
// read from disk: the main vitest config has `css: false`, which blanks `tokens.css?raw` imports
const CSS = nodeFs.readFileSync(`${cwd}/src/theme/tokens.css`, 'utf8');
const RAW = parseTokenBlocks(CSS);

const sel = (base: ThemeBase, appId: string, editorId = MATCH_APP): ActiveTheme => ({ base, app: appThemeById(appId)!, editorId });

/** Monaco / IntelliSense requirements of a code theme (the editor-facing subset of the matrix plus the widget colours). */
function editorFailures(label: string, base: ThemeBase, t: TokenMap): string[] {
  const out: string[] = [];
  const need = (what: string, fg: string, bg: string, min: number, over?: string) => {
    const r = contrast(fg, bg, over ?? t['--bg-panel']);
    if (r + 1e-9 < min) out.push(`${label}: ${what} = ${r.toFixed(2)} < ${min}`);
  };
  const th = buildMonacoTheme(base, t);
  const c = th.colors;
  for (const [k, v] of Object.entries(c)) if (!parseColor(v)) out.push(`${label}: ${k}=${v} is not a colour`);
  for (const r of th.rules) if (!/^[0-9a-f]{6}$/.test(r.foreground ?? '')) out.push(`${label}: rule ${r.token} has no colour`);
  need('editor text', c['editor.foreground'], c['editor.background'], TEXT);
  for (const k of ['--syn-keyword', '--syn-string', '--syn-comment', '--syn-number', '--syn-function', '--syn-variable', '--syn-operator', '--syn-type']) {
    need(`${k} on the editor`, t[k], t['--bg-panel'], TEXT);
  }
  const surface = c['editorSuggestWidget.background'];
  need('suggest text', c['editorSuggestWidget.foreground'], surface, TEXT);
  need('suggest selected text', c['editorSuggestWidget.selectedForeground'], c['editorSuggestWidget.selectedBackground'], TEXT, surface);
  need('suggest hovered text', c['list.hoverForeground'], c['list.hoverBackground'], TEXT, surface);
  need('--fg-muted on the suggest list', t['--fg-muted'], surface, TEXT);
  need('--fg-muted-on-selected on a hovered row', t['--fg-muted-on-selected'], c['list.hoverBackground'], TEXT, surface);
  need('--fg-muted-on-selected on the selected row', t['--fg-muted-on-selected'], c['editorSuggestWidget.selectedBackground'], TEXT, surface);
  need('matched characters', c['editorSuggestWidget.highlightForeground'], surface, TEXT);
  need('matched characters on a hovered row', t['--accent-on-selected'], c['list.hoverBackground'], TEXT, surface);
  need('matched characters on the selected row', c['editorSuggestWidget.focusHighlightForeground'], c['editorSuggestWidget.selectedBackground'], TEXT, surface);
  need('hover widget text', c['editorHoverWidget.foreground'], c['editorHoverWidget.background'], TEXT);
  need('active parameter', c['editorHoverWidget.highlightForeground'], c['editorHoverWidget.background'], TEXT);
  need('parameter chip', t['--accent'], t['--accent-soft'], TEXT);
  need('links in hovers', c['textLink.foreground'], c['editorHoverWidget.background'], TEXT);
  need('inline code', t['--fg'], c['textCodeBlock.background'], TEXT);
  need('muted text in hovers', t['--fg-muted'], c['editorHoverWidget.background'], TEXT);
  need('menu selection', c['menu.selectionForeground'], c['menu.selectionBackground'], TEXT);
  need('quick input focus', c['quickInputList.focusForeground'], c['quickInputList.focusBackground'], TEXT, c['quickInput.background']);
  need('widget border', c['editorWidget.border'], c['editor.background'], UI);
  need('input border', c['input.border'], c['input.background'], UI);
  need('cursor', c['editorCursor.foreground'], c['editor.background'], UI);
  const hover = contrast(c['list.hoverBackground'], surface);
  const selected = contrast(c['editorSuggestWidget.selectedBackground'], surface);
  if (hover < 1.05) out.push(`${label}: hovered suggest row invisible (${hover.toFixed(2)})`);
  if (selected <= hover) out.push(`${label}: selected row (${selected.toFixed(2)}) not clearer than hover (${hover.toFixed(2)})`);
  for (const k of Object.keys(SUGGEST_KIND_COLORS)) {
    const fg = c[`symbolIcon.${k}Foreground`];
    for (const bg of [surface, c['editorSuggestWidget.selectedBackground'], c['list.hoverBackground']]) {
      const r = contrast(fg, bg, surface);
      if (r < UI) out.push(`${label}: kind icon ${k} ${fg} on ${bg} = ${r.toFixed(2)}`);
    }
  }
  const distinct = ['--kind-table', '--kind-view', '--kind-column', '--kind-function', '--kind-keyword', '--kind-snippet', '--kind-schema', '--kind-database', '--kind-alias'];
  const colors = distinct.map((k) => t[k]?.toLowerCase());
  if (new Set(colors).size !== distinct.length) out.push(`${label}: kind colours not distinct: ${distinct.map((k, i) => `${k}=${colors[i]}`).join(' ')}`);
  return out;
}

afterEach(() => resetActiveTheme());

describe('app themes', () => {
  it('has unique ids and names, both bases, and the tokens.css themes as the defaults', () => {
    expect(new Set(APP_THEMES.map((t) => t.id)).size).toBe(APP_THEMES.length);
    expect(new Set(APP_THEMES.map((t) => t.name)).size).toBe(APP_THEMES.length);
    expect(APP_THEMES.length).toBeGreaterThanOrEqual(6);
    expect(appThemeById('light')).toMatchObject({ base: 'light', vars: {} });
    expect(appThemeById('dark')).toMatchObject({ base: 'dark', vars: {} });
    expect(APP_THEMES.filter((t) => t.base === 'light').length).toBeGreaterThanOrEqual(2);
    expect(APP_THEMES.filter((t) => t.base === 'dark').length).toBeGreaterThanOrEqual(3);
  });

  it('overrides only tokens that exist in tokens.css, with colour values', () => {
    const known = new Set(Object.keys(RAW.light));
    const bad = [...APP_THEMES, ...EDITOR_THEMES].flatMap((t) => Object.entries(t.vars).flatMap(([k, v]) => [
      ...(known.has(k) ? [] : [`${t.id}: ${k} is not a token`]),
      ...(parseColor(v) ? [] : [`${t.id}: ${k}=${v} is not a colour`]),
    ]));
    expect(bad).toEqual([]);
  });

  /** The surfaces and text tokens a custom theme must define itself (inheriting them from the base would clash). */
  const CORE = ['--bg-app', '--bg-panel', '--bg-elevated', '--bg-hover', '--bg-selected', '--bg-sunken', '--bg-input', '--border', '--border-strong', '--fg', '--fg-muted',
    '--accent', '--accent-fg', '--accent-soft', '--focus-ring', '--syn-keyword', '--syn-string', '--syn-comment', '--glass-bg', '--glass-bg-native'];
  for (const theme of APP_THEMES.filter((t) => Object.keys(t.vars).length > 0)) {
    it(`${theme.name}: defines its own surfaces, text, accent, syntax and glass`, () => {
      expect(CORE.filter((k) => !(k in theme.vars))).toEqual([]);
    });
  }

  for (const theme of APP_THEMES) {
    it(`${theme.name}: meets every pair of the contrast matrix`, () => {
      const t = withGlass(appTokens(sel(theme.base, theme.id), CSS));
      expect(matrixFailures(theme.id, t)).toEqual([]);
    });

    it(`${theme.name}: gives Monaco readable text, widgets and kind icons (Match app theme)`, () => {
      const ed = editorColors(sel(theme.base, theme.id), CSS);
      expect(ed.standalone).toBe(false);
      expect(editorFailures(theme.id, theme.base, ed.tokens)).toEqual([]);
    });

    it(`${theme.name}: colours the Windows caption buttons from its top bar`, () => {
      const t = withGlass(appTokens(sel(theme.base, theme.id), CSS));
      const solid = titleBarOverlayColors(t, false);
      expect(solid.color).toBe(t['@topbar']);
      expect(contrast(solid.symbolColor, solid.color)).toBeGreaterThanOrEqual(UI);
      expect(titleBarOverlayColors(t, true).color).toMatch(/^#[0-9a-f]{6}00$/);
    });
  }
});

describe('code themes', () => {
  it('has unique ids and names and never uses the reserved "match" id', () => {
    expect(new Set(EDITOR_THEMES.map((t) => t.id)).size).toBe(EDITOR_THEMES.length);
    expect(new Set(EDITOR_THEMES.map((t) => t.name)).size).toBe(EDITOR_THEMES.length);
    expect(EDITOR_THEMES.some((t) => t.id === MATCH_APP)).toBe(false);
    expect(EDITOR_THEMES.length).toBeGreaterThanOrEqual(8);
  });

  for (const theme of EDITOR_THEMES) {
    it(`${theme.name}: readable editor, syntax, widgets and kind icons`, () => {
      const ed = editorColors({ base: theme.base === 'dark' ? 'light' : 'dark', app: appThemeById('light')!, editorId: theme.id }, CSS);
      expect(ed.standalone).toBe(true);
      expect(ed.base).toBe(theme.base);
      expect(editorFailures(theme.id, theme.base, ed.tokens)).toEqual([]);
    });
  }
});

describe('settings', () => {
  it('reads one theme per mode and the code theme from settings.ui, falling back to the defaults', () => {
    expect(appThemeFor({}, 'light').id).toBe('light');
    expect(appThemeFor({}, 'dark').id).toBe('dark');
    expect(appThemeFor({ [APP_THEME_DARK_KEY]: 'nord' }, 'dark').id).toBe('nord');
    expect(appThemeFor({ [APP_THEME_LIGHT_KEY]: 'nord' }, 'light').id, 'a dark theme in the light slot').toBe('light');
    expect(appThemeFor({ [APP_THEME_DARK_KEY]: 'gone' }, 'dark').id).toBe('dark');
    expect(editorThemeIdFor({})).toBe(MATCH_APP);
    expect(editorThemeIdFor({ [EDITOR_THEME_KEY]: 'monokai' })).toBe('monokai');
    expect(editorThemeIdFor({ [EDITOR_THEME_KEY]: 'nope' })).toBe(MATCH_APP);
  });
});

describe('effective theme', () => {
  it('derives the Monaco theme from the app theme, or from the chosen code theme', () => {
    setActiveTheme(sel('dark', 'nord'));
    const nord = effectiveMonacoTheme(sel('dark', 'nord'));
    expect(nord.base).toBe('vs-dark');
    // a light code theme in a dark app: a light Monaco theme
    expect(effectiveMonacoTheme(sel('dark', 'nord', 'github-light')).base).toBe('vs');
  });

  it('puts the app theme and the code surface on <html> as custom properties', () => {
    expect(documentVars(sel('light', 'light'))).toEqual({});
    expect(documentVars(sel('dark', 'midnight'))).toBe(appThemeById('midnight')!.vars);
    const mixed = documentVars(sel('light', 'paper', 'monokai'));
    expect(mixed['--bg-panel']).toBe(appThemeById('paper')!.vars['--bg-panel']);
    expect(mixed['--code-bg']).toBe(EDITOR_THEMES.find((t) => t.id === 'monokai')!.vars['--bg-panel']);
  });

  it('scopes only colour tokens onto the editor', () => {
    const scoped = colorTokens({ '--fg': '#000000', '--shadow-popup': '0 1px 2px rgb(0 0 0 / 10%)', '--radius': '6px', '--glass-bg': 'rgb(0 0 0 / 50%)' });
    expect(Object.keys(scoped).sort()).toEqual(['--fg', '--shadow-popup']);
  });
});

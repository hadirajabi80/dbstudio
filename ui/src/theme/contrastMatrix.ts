// The declared contrast matrix (QA 5.1, docs/PLAN-M1.5.md): every foreground/background pair the UI paints. Shared by
// the token tests (tokens.css light/dark) and the theme tests (every app theme of themes.ts). Test-only: nothing in
// the app imports it, so it never reaches the bundle.
import { blend, contrast, parseColor, toHex, type TokenMap } from './index';

/** One contrast requirement: `fg` on `bg` (translucent `bg` composited over `base`) must reach `min`. */
export type Pair = { fg: string; bg: string; min: number; base?: string; why: string };
export const TEXT = 4.5; // WCAG 1.4.3 normal text
export const UI = 3; // WCAG 1.4.11 icons, control boundaries, focus indicators
const pair = (fg: string, bg: string, min: number, why: string, base?: string): Pair => ({ fg, bg, min, why, base });

/**
 * The glass top bar is translucent: what text sits on is the tint composited over what is behind it. Two synthetic
 * surfaces for the matrix: `@topbar` (--glass-bg over --bg-app: browser and Windows 10) and `@topbar-native`
 * (--glass-bg-native over the assumed OS material --glass-material: Mica / vibrancy).
 */
export function withGlass(t: TokenMap): TokenMap {
  const over = (fg: string, bg: string) => toHex(blend(parseColor(t[fg])!, parseColor(t[bg])!));
  return { ...t, '@topbar': over('--glass-bg', '--bg-app'), '@topbar-native': over('--glass-bg-native', '--glass-material') };
}
export const GLASS = ['@topbar', '@topbar-native'];

export const SURFACES = ['--bg-panel', '--bg-app', '--bg-elevated', '--bg-hover', '--bg-sunken', '--bg-input', '--bg-grid-alt'];
export const CONTRAST_MATRIX: Pair[] = [
  ...[...SURFACES, '--bg-selected', '--bg-selected-inactive', '--bg-active'].map((bg) => pair('--fg', bg, TEXT, 'body text')),
  ...SURFACES.map((bg) => pair('--fg-muted', bg, TEXT, 'secondary text, menu shortcuts, counts, tab connection names')),
  pair('--fg-muted-on-selected', '--bg-selected', TEXT, 'secondary text on the focused palette/tree/switcher row'),
  pair('--fg-muted-on-selected', '--bg-selected-inactive', TEXT, 'secondary text on an unfocused selected row'),
  pair('--fg-muted-on-selected', '--bg-active', TEXT, 'count on the active results tab, muted pill, schema glyph'),
  pair('--accent-on-selected', '--bg-selected', TEXT, '"current" label and matched characters on a selected row'),
  pair('--accent', '--bg-panel', TEXT, 'links'), pair('--accent', '--bg-elevated', TEXT, 'links in dialogs'), pair('--accent', '--bg-app', TEXT, 'top bar links'),
  pair('--accent-fg', '--accent', TEXT, 'primary button / active menu item'), pair('--accent-fg', '--accent-hover', TEXT, 'primary button hover'),
  pair('--danger-fg', '--danger', TEXT, 'danger button'), pair('--success-fg', '--success', TEXT, 'Run button'),
  pair('--danger-fg', '--conn-red', TEXT, 'PROD tag on the Run button'),
  pair('--accent', '--accent-soft', TEXT, 'pills, chips, segmented "on"'), pair('--fg', '--accent-soft', TEXT, 'tip strip, pinned history'),
  pair('--success', '--success-soft', TEXT, '"Editable" badge, test result ok'), pair('--warning', '--warning-soft', TEXT, 'tx badge, conflicts'),
  pair('--danger-text', '--danger-soft', TEXT, 'engine banner, test result error'), pair('--info', '--info-soft', TEXT, 'info badges'),
  pair('--danger', '--bg-panel', TEXT, 'error text'), pair('--danger-text', '--bg-elevated', TEXT, 'danger menu item'),
  pair('--warning', '--bg-panel', TEXT, 'warning text'), pair('--success', '--bg-panel', TEXT, 'ok status text'),
  ...['--num', '--string', '--date', '--bool', '--null'].flatMap((k) => ['--bg-panel', '--bg-grid-alt'].map((bg) => pair(k, bg, TEXT, 'grid data kinds'))),
  ...['--syn-keyword', '--syn-string', '--syn-comment', '--syn-number', '--syn-function', '--syn-variable', '--syn-operator', '--syn-type']
    .map((k) => pair(k, '--bg-panel', TEXT, 'editor syntax')),
  // changed cells: text is --fg (a muted NULL on dark --cell-edited is ~3:1, so changed cells draw NULL in --fg)
  ...['--cell-edited', '--cell-inserted', '--cell-deleted'].flatMap((cell) => ['--bg-panel', '--bg-grid-alt'].map((base) => pair('--fg', cell, TEXT, 'changed-cell text', base))),
  pair('--fg', '--mark-bg', TEXT, 'search/filter highlight', '--bg-panel'),
  pair('--border', '--bg-panel', 1.5, 'decorative separators (5.1)'),
  pair('--border-strong', '--bg-panel', UI, 'control boundaries (5.1)'), pair('--border-strong', '--bg-input', UI, 'input boundaries'),
  ...['--bg-panel', '--bg-app', '--bg-elevated', '--bg-input', '--bg-selected'].map((bg) => pair('--focus-ring', bg, UI, 'focus ring')),
  ...['--success', '--warning', '--danger', '--info'].map((s) => pair(s, '--bg-panel', UI, 'status icons')),
  ...['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'].flatMap((c) => ['--bg-panel', '--bg-app'].map((bg) => pair(`--conn-${c}`, bg, UI, 'connection colour dots/bars'))),
  ...['table', 'view', 'routine', 'package', 'trigger', 'key', 'fk', 'db', 'other'].flatMap((o) => ['--bg-panel', '--bg-selected'].map((bg) => pair(`--obj-${o}`, bg, UI, 'object-type icons'))),
  pair('--fg-muted', '--bg-selected', UI, 'icons on a selected row'),
  ...['sqlserver', 'oracle', 'sqlite', 'postgresql', 'redis', 'mongodb', 'kafka', 'mysql', 'mariadb', 'clickhouse', 'snowflake', 'elasticsearch', 'cassandra']
    .map((p) => pair('--provider-fg', `--provider-${p}`, UI, 'provider tile glyph')),
  // M2: log level text in the Logs view (rows on panel / alternating rows, selected row)
  ...['debug', 'info', 'warn', 'error'].flatMap((l) => ['--bg-panel', '--bg-grid-alt'].map((bg) => pair(`--log-${l}`, bg, TEXT, 'log level text'))),
  ...['debug', 'info', 'warn', 'error'].map((l) => pair(`--log-${l}`, '--bg-selected', UI, 'log level glyph on a selected row')),
  pair('--brand-fg', '--brand', UI, 'brand mark'),
  // Glass top bar: text and icons on the bar, on its hover/pressed states and in the search box, in both the
  // fallback (blurred tint over --bg-app) and over the OS material.
  ...GLASS.flatMap((g) => [
    pair('--fg', g, TEXT, 'top bar text (brand, hovered buttons)'),
    pair('--fg-muted', g, TEXT, 'top bar button labels and icons'),
    pair('--fg', '--glass-hover', TEXT, 'hovered top bar button', g),
    pair('--fg', '--glass-active', TEXT, 'pressed / toggled-on top bar button', g),
    pair('--fg-muted', '--glass-input', TEXT, 'search box placeholder and icon', g),
    pair('--border-strong', '--glass-input', UI, 'search box boundary', g),
    pair('--focus-ring', g, UI, 'focus ring on the top bar'),
    pair('--titlebar-symbol', g, UI, 'Windows caption-button glyphs'),
    pair('--brand-fg', '--brand', UI, 'brand mark on the bar'),
  ]),
  pair('--fg-muted', '--glass-hover', TEXT, 'hovered (inactive) editor tab', '--bg-app'),
  pair('--fg', '--glass-hover', TEXT, 'hovered editor tab title', '--bg-app'),
];

/** Contrast of one matrix pair in a resolved token map (throws when a token is not a colour). */
export function pairRatio(t: TokenMap, p: Pair): number {
  const value = (name: string) => {
    const v = t[name];
    if (!v || !parseColor(v)) throw new Error(`${name} is not a colour (${v})`);
    return v;
  };
  return contrast(value(p.fg), value(p.bg), p.base ? value(p.base) : value('--bg-panel'));
}

/** Every failing pair of the matrix, as readable lines (empty when the token map passes). */
export function matrixFailures(label: string, t: TokenMap, matrix: readonly Pair[] = CONTRAST_MATRIX): string[] {
  return matrix.flatMap((p) => {
    const r = pairRatio(t, p);
    return r + 1e-9 >= p.min ? [] : [`${label}: ${p.fg} on ${p.bg}${p.base ? ` over ${p.base}` : ''} = ${r.toFixed(2)} < ${p.min} (${p.why})`];
  });
}

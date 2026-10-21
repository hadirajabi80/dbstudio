// Monaco themes, derived from the CSS tokens (docs/PLAN-M1.5.md section 3):
// background from --bg-panel, keywords --syn-keyword (accent family), strings, comments, numbers from --syn-*,
// widgets (suggest, hover, find, context menu, quick input) from the surface/selection tokens.
//
// The themes are built from tokens.css itself (theme/index.ts) plus the overrides of the chosen app / code theme
// (theme/themes.ts), not from the live <html> styles, so ensureMonacoSetup() can define them before the first editor
// paints. Monaco's theme is global: both THEME_IDS (`dbstudio-light` / `dbstudio-dark`, which every editor passes
// for the app's base mode) are defined as the *effective* code theme, so an editor mounting later never resets it.
// No literal colours here: every value comes from a token (QA 5.1 lint).
import { editorColors, getActiveTheme, type ActiveTheme } from './activeTheme';
import { firstColor, parseColor, themeTokens, toHex, type Rgba, type TokenMap } from './index';
import type { EffectiveTheme } from './useTheme';

/** Structurally identical to monaco.editor.IStandaloneThemeData (kept local so this module stays Monaco-free). */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

/**
 * Widget backgrounds that Monaco paints list rows on, by colour key prefix. Used by the tests to composite
 * translucent selection colours and to check every `*selected|Selection|focus|hoverBackground` against its
 * `*Foreground` counterpart.
 */
export const WIDGET_SURFACE: Record<string, string> = {
  editorSuggestWidget: 'editorSuggestWidget.background',
  list: 'editorWidget.background',
  quickInputList: 'quickInput.background',
  menu: 'menu.background',
};

/**
 * IntelliSense kind icon colours: Monaco colour key `symbolIcon.<key>Foreground` (the codicon the suggest list draws
 * for a CompletionItemKind) → design token. The SQL kinds map onto codicons in editor/monaco-setup.ts (KIND): table
 * Struct, view Interface, column Field, function Function, procedure Method, schema / package Module, database Folder,
 * keyword Keyword, snippet Snippet, alias Reference, CTE Class, variable Variable, parameter / type TypeParameter,
 * sequence Constant, synonym EnumMember, operator Operator. The Mongo and Redis consoles reuse the same codicons.
 */
export const SUGGEST_KIND_COLORS: Record<string, string> = {
  struct: '--kind-table',
  interface: '--kind-view',
  field: '--kind-column',
  function: '--kind-function',
  method: '--kind-function',
  constructor: '--kind-function',
  module: '--kind-schema',
  namespace: '--kind-schema',
  folder: '--kind-database',
  keyword: '--kind-keyword',
  snippet: '--kind-snippet',
  reference: '--kind-alias',
  class: '--kind-alias',
  variable: '--kind-variable',
  typeParameter: '--kind-variable',
  constant: '--kind-other',
  enumerator: '--kind-other',
  enumeratorMember: '--kind-other',
  operator: '--kind-other',
  property: '--kind-other',
  text: '--kind-other',
};

export function buildMonacoTheme(theme: EffectiveTheme, tokens: TokenMap = themeTokens(theme)): MonacoThemeData {
  const dark = theme === 'dark';
  const colorOf = (name: string): Rgba | null => parseColor(tokens[name] ?? '');
  /** Token as #rrggbb[aa]; '' when the token is missing (then the key is left to Monaco's base theme). */
  const c = (name: string): string => {
    const v = colorOf(name);
    return v ? toHex(v) : '';
  };
  /** Token with its alpha replaced (Monaco needs concrete colours, not CSS variables). */
  const a = (name: string, alpha: number): string => {
    const v = colorOf(name);
    return v ? toHex({ ...v, a: alpha }) : '';
  };
  const bare = (name: string) => c(name).replace('#', '').slice(0, 6);
  const shadow = firstColor(tokens['--shadow-popup'] ?? '');

  const rule = (token: string, name: string, fontStyle?: string) => ({ token, foreground: bare(name), ...(fontStyle ? { fontStyle } : {}) });
  const rules = [
    rule('', '--fg'),
    rule('keyword', '--syn-keyword', 'bold'),
    rule('keyword.contextual', '--syn-keyword'),
    rule('keyword.batch', '--syn-function', 'bold'),
    rule('type', '--syn-type'),
    rule('predefined', '--syn-function'),
    rule('identifier', '--fg'),
    rule('identifier.quote', '--fg'),
    rule('string', '--syn-string'),
    rule('number', '--syn-number'),
    rule('comment', '--syn-comment', 'italic'),
    rule('variable', '--syn-variable'),
    rule('operator', '--syn-operator'),
    rule('delimiter', '--syn-operator'),
    rule('delimiter.parenthesis', '--syn-operator'),
  ].filter((r) => r.foreground);

  const fg = c('--fg');
  const colors: Record<string, string> = {
    // editor surface
    'editor.background': c('--bg-panel'),
    'editor.foreground': fg,
    'editor.lineHighlightBackground': a('--bg-hover', 0.5),
    'editor.lineHighlightBorder': a('--bg-panel', 0),
    'editor.selectionBackground': a('--accent', dark ? 0.33 : 0.25),
    'editor.inactiveSelectionBackground': a('--accent', dark ? 0.19 : 0.13),
    'editor.findMatchHighlightBackground': c('--mark-bg'),
    'editorLineNumber.foreground': c('--fg-disabled'),
    'editorLineNumber.activeForeground': c('--fg-muted'),
    'editorCursor.foreground': c('--accent'),
    'editorIndentGuide.background1': c('--border-subtle'),
    'editorIndentGuide.activeBackground1': c('--border'),
    'editorWhitespace.foreground': c('--border'),
    'editorBracketMatch.background': a('--accent', 0.15),
    'editorBracketMatch.border': a('--accent', 0.5),
    'editorGutter.background': c('--bg-panel'),
    'editorError.foreground': c('--danger'),
    'editorWarning.foreground': c('--warning'),
    'editorInfo.foreground': c('--info'),
    'editorLink.activeForeground': c('--accent'),
    'editorOverviewRuler.border': a('--bg-panel', 0),
    'scrollbarSlider.background': c('--scrollbar'),
    'scrollbarSlider.hoverBackground': c('--scrollbar-hover'),
    'scrollbarSlider.activeBackground': c('--scrollbar-active'),
    // slim sliders without the drop shadow along the top edge (baseMonacoOptions: useShadows false)
    'scrollbar.shadow': a('--bg-panel', 0),

    // diff editor (Compare with server): soft tints, a faint hatch, solid gutter / overview marks
    'diffEditor.insertedLineBackground': c('--diff-inserted-line'),
    'diffEditor.insertedTextBackground': c('--diff-inserted-text'),
    'diffEditor.removedLineBackground': c('--diff-removed-line'),
    'diffEditor.removedTextBackground': c('--diff-removed-text'),
    'diffEditor.diagonalFill': c('--diff-diagonal'),
    'diffEditor.border': c('--border-subtle'),
    'diffEditorGutter.insertedLineBackground': c('--diff-inserted-line'),
    'diffEditorGutter.removedLineBackground': c('--diff-removed-line'),
    'diffEditorOverview.insertedForeground': c('--diff-inserted-mark'),
    'diffEditorOverview.removedForeground': c('--diff-removed-mark'),
    'editorOverviewRuler.addedForeground': c('--diff-inserted-mark'),
    'editorOverviewRuler.deletedForeground': c('--diff-removed-mark'),
    // keyboard focus inside widgets (find inputs, toggles); the editor's own ring is .editor-host:focus-within
    'focusBorder': c('--focus-ring'),

    // widgets: find/replace, hover, suggest
    'widget.shadow': shadow ? toHex(shadow) : '',
    'editorWidget.background': c('--bg-elevated'),
    'editorWidget.foreground': fg,
    'editorWidget.border': c('--border-strong'),
    'editorHoverWidget.background': c('--bg-elevated'),
    'editorHoverWidget.foreground': fg,
    'editorHoverWidget.border': c('--border'),
    // active parameter in the parameter hints, matched words in hovers
    'editorHoverWidget.highlightForeground': c('--accent'),
    'editorHoverWidget.statusBarBackground': c('--bg-sunken'),
    // markdown in hovers, parameter hints and the suggest details panel
    'textLink.foreground': c('--accent'),
    'textLink.activeForeground': c('--accent-hover'),
    'textCodeBlock.background': c('--bg-sunken'),
    'input.background': c('--bg-input'),
    'input.foreground': fg,
    'input.border': c('--border-strong'),
    'input.placeholderForeground': c('--fg-muted'),
    'inputOption.activeBorder': c('--accent'),
    'inputOption.activeBackground': a('--accent', 0.15),
    'inputOption.activeForeground': fg,

    // IntelliSense: the focused row is --bg-selected with --fg text and icons (never the base theme's white)
    'editorSuggestWidget.background': c('--bg-elevated'),
    'editorSuggestWidget.foreground': fg,
    'editorSuggestWidget.border': c('--border'),
    'editorSuggestWidget.selectedBackground': c('--bg-selected'),
    'editorSuggestWidget.selectedForeground': fg,
    'editorSuggestWidget.selectedIconForeground': fg,
    'editorSuggestWidget.highlightForeground': c('--accent'),
    'editorSuggestWidget.focusHighlightForeground': c('--accent-on-selected'),
    'editorSuggestWidgetStatus.foreground': c('--fg-muted'),
    // kind icons keep their hue on the selected row too (editor/editor-widgets.css)
    ...Object.fromEntries(Object.entries(SUGGEST_KIND_COLORS).map(([k, token]) => [`symbolIcon.${k}Foreground`, c(token)])),

    // lists (suggest details, reference/peek lists) and the quick input (F1 command palette)
    // every Monaco list sits on a popup (--bg-elevated): the hover step is measured from that surface
    'list.hoverBackground': c('--bg-hover-elevated'),
    'list.hoverForeground': fg,
    'list.activeSelectionBackground': c('--bg-selected'),
    'list.activeSelectionForeground': fg,
    'list.activeSelectionIconForeground': fg,
    'list.inactiveSelectionBackground': c('--bg-selected-inactive'),
    'list.inactiveSelectionForeground': fg,
    'list.focusBackground': c('--bg-selected'),
    'list.focusForeground': fg,
    'list.highlightForeground': c('--accent'),
    'list.focusHighlightForeground': c('--accent-on-selected'),
    'quickInput.background': c('--bg-elevated'),
    'quickInput.foreground': fg,
    'quickInputList.focusBackground': c('--bg-selected'),
    'quickInputList.focusForeground': fg,
    'quickInputList.focusIconForeground': fg,

    // editor context menu: same look as the app menus (.menu / .menu-item.active)
    'menu.background': c('--bg-elevated'),
    'menu.foreground': fg,
    'menu.border': c('--border'),
    'menu.selectionBackground': c('--accent'),
    'menu.selectionForeground': c('--accent-fg'),
    'menu.separatorBackground': c('--border'),
  };
  for (const k of Object.keys(colors)) if (!colors[k]) delete colors[k];
  return { base: dark ? 'vs-dark' : 'vs', inherit: true, rules, colors };
}

/** The Monaco theme of a selection: the code theme's colours, or the app theme's for "Match app theme". */
export function effectiveMonacoTheme(t: ActiveTheme = getActiveTheme()): MonacoThemeData {
  const ed = editorColors(t);
  return buildMonacoTheme(ed.base, ed.tokens);
}

/** Defines both DbStudio theme ids as the effective code theme (editor/monaco-setup.ts defineThemes, and every switch). */
export function defineMonacoThemes(
  editor: { defineTheme(id: string, data: MonacoThemeData): void },
  ids: { readonly light: string; readonly dark: string },
): void {
  const data = effectiveMonacoTheme();
  editor.defineTheme(ids.light, data);
  editor.defineTheme(ids.dark, data);
}

/** Re-defines the effective code theme and applies it to every editor (Monaco's theme is global). */
export async function applyMonacoTheme(): Promise<void> {
  try {
    const [{ ensureMonacoSetup, THEME_IDS }, monaco] = await Promise.all([import('../editor/monaco-setup'), import('../editor/monaco')]);
    ensureMonacoSetup();
    defineMonacoThemes(monaco.editor, THEME_IDS);
    monaco.editor.setTheme(getActiveTheme().base === 'dark' ? THEME_IDS.dark : THEME_IDS.light);
  } catch (e) {
    console.warn('[theme] monaco theme update failed', e);
  }
}

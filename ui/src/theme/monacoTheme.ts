// Monaco themes `dbstudio-light` / `dbstudio-dark` derived from the CSS tokens (section 3): background from
// --bg-panel, keywords --syn-keyword (accent family), strings, comments, numbers from the --syn-* tokens.
// Re-defined on every theme switch so the editor recolours without a reload.
import { cssVar } from './gridTheme';
import type { EffectiveTheme } from './useTheme';

const hex = (v: string, fallback: string) => {
  const s = v.trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
};
const bare = (v: string) => v.replace('#', '');

export function buildMonacoTheme(theme: EffectiveTheme) {
  const dark = theme === 'dark';
  const t = (name: string, light: string, darkFb: string) => hex(cssVar(name), dark ? darkFb : light);
  const bg = t('--bg-panel', '#ffffff', '#24272d');
  const fg = t('--fg', '#1c1f24', '#e6e8eb');
  const muted = t('--fg-muted', '#5f6673', '#9aa1ab');
  const accent = t('--accent', '#2563eb', '#5b9cff');
  const border = t('--border', '#d9dde3', '#3a3f48');
  const elevated = t('--bg-elevated', '#ffffff', '#2c3038');
  const hover = t('--bg-hover', '#eceef2', '#30343c');
  const selected = t('--bg-selected', '#dde8fb', '#2e4466');
  const kw = t('--syn-keyword', '#2563eb', '#5b9cff');
  const str = t('--syn-string', '#047857', '#6ee7b7');
  const comment = t('--syn-comment', '#5f6673', '#9aa1ab');
  const num = t('--syn-number', '#9a3412', '#fdba74');
  const fn = t('--syn-function', '#7c3aed', '#c4b5fd');
  const variable = t('--syn-variable', '#b45309', '#fbbf24');
  const op = t('--syn-operator', '#374151', '#cbd5e1');
  const type = t('--syn-type', '#0e7490', '#67e8f9');
  return {
    base: (dark ? 'vs-dark' : 'vs') as 'vs' | 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: bare(fg) },
      { token: 'keyword', foreground: bare(kw), fontStyle: 'bold' },
      { token: 'keyword.contextual', foreground: bare(kw) },
      { token: 'keyword.batch', foreground: bare(fn), fontStyle: 'bold' },
      { token: 'type', foreground: bare(type) },
      { token: 'predefined', foreground: bare(fn) },
      { token: 'identifier', foreground: bare(fg) },
      { token: 'identifier.quote', foreground: bare(fg) },
      { token: 'string', foreground: bare(str) },
      { token: 'number', foreground: bare(num) },
      { token: 'comment', foreground: bare(comment), fontStyle: 'italic' },
      { token: 'variable', foreground: bare(variable) },
      { token: 'operator', foreground: bare(op) },
      { token: 'delimiter', foreground: bare(op) },
      { token: 'delimiter.parenthesis', foreground: bare(op) },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editor.lineHighlightBackground': dark ? '#2a2e35' : '#f6f8fc',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': `${accent}${dark ? '55' : '40'}`,
      'editor.inactiveSelectionBackground': `${accent}${dark ? '30' : '22'}`,
      'editor.findMatchHighlightBackground': dark ? '#facc1540' : '#fde68aa0',
      'editorLineNumber.foreground': dark ? '#646a74' : '#a0a6b0',
      'editorLineNumber.activeForeground': muted,
      'editorCursor.foreground': accent,
      'editorIndentGuide.background1': dark ? '#30343c' : '#eceef2',
      'editorWhitespace.foreground': border,
      'editorBracketMatch.background': `${accent}26`,
      'editorBracketMatch.border': `${accent}80`,
      'editorGutter.background': bg,
      'editorWidget.background': elevated,
      'editorWidget.border': border,
      'editorSuggestWidget.background': elevated,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': selected,
      'editorSuggestWidget.highlightForeground': accent,
      'editorHoverWidget.background': elevated,
      'editorHoverWidget.border': border,
      'list.hoverBackground': hover,
      'focusBorder': `${accent}00`,
      'scrollbarSlider.background': dark ? '#ffffff22' : '#00000022',
      'scrollbarSlider.hoverBackground': dark ? '#ffffff38' : '#00000038',
    },
  };
}

/** Defines the effective theme from the current tokens and applies it to every editor. */
export async function applyMonacoTheme(theme: EffectiveTheme): Promise<void> {
  try {
    const [{ ensureMonacoSetup, THEME_IDS }, monaco] = await Promise.all([import('../editor/monaco-setup'), import('../editor/monaco')]);
    ensureMonacoSetup();
    const id = theme === 'dark' ? THEME_IDS.dark : THEME_IDS.light;
    monaco.editor.defineTheme(id, buildMonacoTheme(theme));
    monaco.editor.setTheme(id);
  } catch (e) {
    console.warn('[theme] monaco theme update failed', e);
  }
}

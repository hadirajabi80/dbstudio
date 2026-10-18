import type { Theme } from '@glideapps/glide-data-grid';
import type { EffectiveTheme } from './useTheme';

/** Current value of a CSS custom property on <html> (theme tokens). */
export function cssVar(name: string, fallback = ''): string {
  if (typeof document === 'undefined') return fallback;
  const s = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return s || fallback;
}

/** Grid row height for the density setting (section 3: 28 px comfortable, 24 px compact). */
export function gridRowHeight(density: 'comfortable' | 'compact' | undefined): number {
  return density === 'compact' ? 24 : 28;
}

/** "#rrggbb" + alpha → "rgba(r, g, b, a)" (glide needs concrete colours, not CSS variables). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** glide-data-grid theme derived from the CSS tokens; regenerate after a theme switch (pass the theme as a dep). */
export function makeGridTheme(theme: EffectiveTheme): Partial<Theme> {
  const dark = theme === 'dark';
  const accent = cssVar('--accent', dark ? '#5b9cff' : '#2563eb');
  const fg = cssVar('--fg', dark ? '#e6e8eb' : '#1c1f24');
  const muted = cssVar('--fg-muted', dark ? '#9aa1ab' : '#5f6673');
  const panel = cssVar('--bg-panel', dark ? '#24272d' : '#ffffff');
  const border = cssVar('--border', dark ? '#41464f' : '#ccd1d9');
  return {
    accentColor: accent,
    accentFg: cssVar('--accent-fg', dark ? '#0b1220' : '#ffffff'),
    accentLight: withAlpha(accent, dark ? 0.22 : 0.12),
    textDark: fg,
    textMedium: muted,
    textLight: muted,
    textBubble: fg,
    bgIconHeader: muted,
    fgIconHeader: panel,
    textHeader: fg,
    textHeaderSelected: cssVar('--accent-fg', '#ffffff'),
    bgCell: panel,
    bgCellMedium: cssVar('--bg-grid-alt', dark ? '#22252a' : '#fafbfc'),
    bgHeader: cssVar('--bg-app', dark ? '#1b1d21' : '#f5f6f8'),
    bgHeaderHasFocus: cssVar('--bg-selected', dark ? '#2e4466' : '#dde8fb'),
    bgHeaderHovered: cssVar('--bg-hover', dark ? '#30343c' : '#eceef2'),
    bgBubble: cssVar('--bg-hover', '#eceef2'),
    bgBubbleSelected: panel,
    bgSearchResult: withAlpha(dark ? '#facc15' : '#fde68a', dark ? 0.3 : 0.7),
    borderColor: withAlpha(border, dark ? 0.7 : 0.8),
    horizontalBorderColor: withAlpha(border, dark ? 0.45 : 0.55),
    // A decorative rule: --border (--border-strong is reserved for control boundaries, styles-r1-07).
    headerBottomBorderColor: border,
    drilldownBorder: 'rgba(0,0,0,0)',
    linkColor: accent,
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    headerFontStyle: '600 12px',
    headerIconSize: 16,
    baseFontStyle: '13px',
    markerFontStyle: '11px',
    fontFamily: cssVar('--font-mono', 'Cascadia Code, Consolas, monospace'),
    editorFontSize: '13px',
    lineHeight: 1.4,
    roundingRadius: 3,
  };
}

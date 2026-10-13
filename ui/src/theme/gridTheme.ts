import type { Theme } from '@glideapps/glide-data-grid';
import type { EffectiveTheme } from './useTheme';

function v(name: string, fallback: string): string {
  const s = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return s || fallback;
}

/** glide-data-grid theme derived from the CSS tokens; regenerate after a theme switch. */
export function makeGridTheme(theme: EffectiveTheme): Partial<Theme> {
  const dark = theme === 'dark';
  return {
    accentColor: v('--accent', '#3574f0'),
    accentFg: '#ffffff',
    accentLight: dark ? 'rgba(53, 116, 240, 0.22)' : 'rgba(53, 116, 240, 0.12)',
    textDark: v('--text', dark ? '#dfe1e5' : '#1e1f22'),
    textMedium: v('--text-muted', '#9da0a8'),
    textLight: v('--text-faint', '#a8adbd'),
    textBubble: v('--text', '#1e1f22'),
    bgIconHeader: v('--text-muted', '#6c707e'),
    fgIconHeader: v('--bg-panel', '#ffffff'),
    textHeader: v('--text', '#1e1f22'),
    textHeaderSelected: '#ffffff',
    bgCell: v('--bg-editor', dark ? '#1e1f22' : '#ffffff'),
    bgCellMedium: v('--bg-sunken', '#f2f3f5'),
    bgHeader: v('--bg-panel', dark ? '#2b2d30' : '#f7f8fa'),
    bgHeaderHasFocus: v('--bg-active', '#dfe1e5'),
    bgHeaderHovered: v('--bg-hover', '#ebecf0'),
    bgBubble: v('--bg-sunken', '#f2f3f5'),
    bgBubbleSelected: v('--bg-panel', '#ffffff'),
    bgSearchResult: dark ? '#5a4a1e' : '#fff2b3',
    borderColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    horizontalBorderColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    headerBottomBorderColor: v('--border-strong', '#d3d5db'),
    drilldownBorder: 'rgba(0,0,0,0)',
    linkColor: v('--accent', '#3574f0'),
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    headerFontStyle: '600 12px',
    headerIconSize: 16,
    baseFontStyle: '12.5px',
    markerFontStyle: '11px',
    fontFamily: v('--font-ui', 'Segoe UI, sans-serif'),
    editorFontSize: '12.5px',
    lineHeight: 1.4,
    roundingRadius: 3,
  };
}

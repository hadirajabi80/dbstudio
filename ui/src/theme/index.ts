// Theme token utilities shared by the Monaco theme builder and the token tests (docs/PLAN-M1.5.md section 3).
//
// tokens.css is the single place where colours are written down. This module parses it (both themes, independent
// of which one <html> currently shows), resolves var() aliases, converts CSS colours to RGBA, blends translucent
// colours over their background and measures WCAG 2.x contrast.
import tokensCss from './tokens.css?raw';
import type { EffectiveTheme } from './useTheme';

export type TokenMap = Readonly<Record<string, string>>;
export interface Rgba { r: number; g: number; b: number; a: number }

/** Light/dark selectors used in tokens.css. Light also applies under dark (`:root` always matches). */
const LIGHT_BLOCK = ":root[data-theme='light']";
const DARK_BLOCK = ":root[data-theme='dark']";

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Custom-property declarations of every top-level rule whose selector list contains `selector` exactly. */
function declarations(css: string, match: (selectors: string[]) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const text = stripComments(css);
  let depth = 0, start = 0, prelude = '', bodyStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) { prelude = text.slice(start, i).trim(); bodyStart = i + 1; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const selectors = prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ').replace(/"/g, "'"));
        if (!prelude.startsWith('@') && match(selectors)) {
          for (const m of text.slice(bodyStart, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
        }
        start = i + 1;
      }
    }
  }
  return out;
}

/** The raw (unresolved) token declarations of each theme, as the browser would cascade them on <html>. */
export function parseTokenBlocks(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const base = declarations(css, (s) => s.includes(':root') || s.includes(LIGHT_BLOCK));
  const dark = declarations(css, (s) => s.includes(DARK_BLOCK));
  // theme-independent `:root` blocks come after the theme blocks but never redefine theme colours
  return { light: { ...base }, dark: { ...base, ...dark } };
}

/** Resolves `var(--x)` / `var(--x, fallback)` references inside a token map (cycles resolve to ''). */
export function resolveTokens(raw: Record<string, string>): TokenMap {
  const out: Record<string, string> = {};
  const resolving = new Set<string>();
  const resolve = (name: string): string => {
    if (name in out) return out[name];
    if (resolving.has(name) || !(name in raw)) return '';
    resolving.add(name);
    const v = substitute(raw[name]);
    resolving.delete(name);
    out[name] = v;
    return v;
  };
  const substitute = (v: string): string => {
    let prev = '';
    let cur = v;
    while (cur !== prev && cur.includes('var(')) {
      prev = cur;
      cur = cur.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, n: string, fb?: string) => resolve(n) || (fb ?? '').trim());
    }
    return cur;
  };
  for (const name of Object.keys(raw)) resolve(name);
  return out;
}

let cache: Record<EffectiveTheme, TokenMap> | null = null;

/** Resolved tokens of a theme, parsed from tokens.css (works for both themes whatever <html> shows). */
export function themeTokens(theme: EffectiveTheme, css: string = tokensCss): TokenMap {
  if (css !== tokensCss) {
    const b = parseTokenBlocks(css);
    return resolveTokens(theme === 'dark' ? b.dark : b.light);
  }
  if (!cache) {
    const b = parseTokenBlocks(tokensCss);
    cache = { light: resolveTokens(b.light), dark: resolveTokens(b.dark) };
  }
  return cache[theme];
}

// ------------------------------------------------------------------ colours

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space syntax). Null otherwise. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (s: string, scale: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s));
  const [r, g, b] = parts.slice(0, 3).map((p) => clamp(Math.round(num(p, 255)), 0, 255));
  const a = parts[3] !== undefined ? clamp(num(parts[3], 1), 0, 1) : 1;
  if ([r, g, b, a].some((x) => Number.isNaN(x))) return null;
  return { r, g, b, a };
}

/** First colour literal inside a compound value such as a box-shadow (`0 8px 28px rgb(16 24 40 / 14%), ...`). */
export function firstColor(value: string): Rgba | null {
  const m = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(value);
  return m ? parseColor(m[0]) : null;
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` when the colour is translucent (the form Monaco themes accept). */
export function toHex(c: Rgba): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a >= 1 ? base : base + hex2(c.a * 255);
}

/** `fg` composited over an opaque `bg` (source-over). */
export function blend(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const ch = [c.r, c.g, c.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function asRgba(c: string | Rgba): Rgba {
  if (typeof c !== 'string') return c;
  const p = parseColor(c);
  if (!p) throw new Error(`not a colour: ${c}`);
  return p;
}

/**
 * WCAG contrast ratio. Translucent backgrounds are first composited over `base` (default white, pass the
 * surface they sit on); a translucent foreground is composited over the resulting background.
 */
export function contrast(fg: string | Rgba, bg: string | Rgba, base: string | Rgba = '#ffffff'): number {
  const b0 = asRgba(base);
  const bgc = blend(asRgba(bg), b0.a < 1 ? blend(b0, { r: 255, g: 255, b: 255, a: 1 }) : b0);
  const fgc = blend(asRgba(fg), bgc);
  const [x, y] = [luminance(fgc), luminance(bgc)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

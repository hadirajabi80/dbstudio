// QA 5.1 (docs/PLAN-M1.5.md): token table values, the 5.1 contrast targets, a declared contrast matrix of every
// foreground/background pair the UI paints (selected/hover/soft surfaces, blended --cell-* colours), the Monaco
// theme (selected rows, widgets, context menu), and the CSS lints: no literal colours outside src/theme/,
// --fg-disabled only on disabled controls, theme typography on the scale, one rule per selector in app/shell.css.
import { describe, expect, it } from 'vitest';
import { contrast, parseColor, parseTokenBlocks, resolveTokens, type TokenMap } from './index';
import { buildMonacoTheme, WIDGET_SURFACE } from './monacoTheme';

// Node APIs, typed locally (the app tsconfig has no Node types; vitest runs on Node).
interface NodeFs { readFileSync(p: string, enc: 'utf8'): string; readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean } }
const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as NodeFs;
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const SRC = `${cwd}/src`;
// read from disk: the main vitest config has `css: false`, which blanks `tokens.css?raw` imports
const css = nodeFs.readFileSync(`${SRC}/theme/tokens.css`, 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of nodeFs.readdirSync(dir)) {
    const p = `${dir}/${f}`;
    if (nodeFs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|tsx?)$/.test(f)) out.push(p);
  }
  return out;
}
const SOURCES: Record<string, string> = Object.fromEntries(walk(SRC).map((p) => [p.slice(SRC.length + 1), nodeFs.readFileSync(p, 'utf8')]));

const RAW = parseTokenBlocks(css);
const TOKENS: Record<'light' | 'dark', TokenMap> = { light: resolveTokens(RAW.light), dark: resolveTokens(RAW.dark) };
const THEMES = ['light', 'dark'] as const;

// docs/PLAN-M1.5.md section 3 token table.
const SPEC: [string, string, string][] = [
  ['--bg-app', '#f5f6f8', '#1b1d21'], ['--bg-panel', '#ffffff', '#24272d'], ['--bg-elevated', '#ffffff', '#2c3038'],
  ['--bg-hover', '#eceef2', '#30343c'], ['--bg-selected', '#dde8fb', '#2e4466'], ['--bg-grid-alt', '#fafbfc', '#22252a'],
  ['--border', '#ccd1d9', '#41464f'], ['--border-strong', '#8a919c', '#6f7682'], ['--fg', '#1c1f24', '#e6e8eb'],
  ['--fg-muted', '#5f6673', '#9aa1ab'], ['--fg-disabled', '#a0a6b0', '#646a74'], ['--accent', '#2563eb', '#5b9cff'],
  ['--accent-fg', '#ffffff', '#0b1220'], ['--focus-ring', '#2563eb', '#8ab4ff'], ['--success', '#15803d', '#4ade80'],
  ['--warning', '#b45309', '#fbbf24'], ['--danger', '#b91c1c', '#f87171'], ['--info', '#0e7490', '#67e8f9'],
  ['--cell-edited', 'rgb(253 230 138 / 35%)', 'rgb(250 204 21 / 25%)'], ['--cell-inserted', 'rgb(187 247 208 / 40%)', 'rgb(34 197 94 / 22%)'],
  ['--cell-deleted', 'rgb(254 202 202 / 40%)', 'rgb(239 68 68 / 22%)'],
  ['--conn-red', '#dc2626', '#e76868'], ['--conn-orange', '#ea580c', '#f6874d'], ['--conn-yellow', '#b47c03', '#fbb420'],
  ['--conn-green', '#16a34a', '#24e16a'], ['--conn-blue', '#2563eb', '#6b95f1'], ['--conn-purple', '#7c3aed', '#ab80f3'],
  ['--conn-grey', '#6b7280', '#9399a5'],
];
const SPEC_SCALE: [string, string][] = [
  ['--text-xs', '11px'], ['--text-sm', '12px'], ['--text-md', '13px'], ['--text-lg', '15px'], ['--text-xl', '20px'], ['--text-2xl', '26px'],
  ['--weight-regular', '400'], ['--weight-strong', '600'], ['--icon-size', '16px'], ['--icon-size-sm', '14px'], ['--input-h', '28px'], ['--input-h-sm', '24px'],
];

/** One contrast requirement: `fg` on `bg` (translucent `bg` composited over `base`) must reach `min`. */
type Pair = { fg: string; bg: string; min: number; base?: string; why: string };
const TEXT = 4.5; // WCAG 1.4.3 normal text
const UI = 3; // WCAG 1.4.11 icons, control boundaries, focus indicators
const pair = (fg: string, bg: string, min: number, why: string, base?: string): Pair => ({ fg, bg, min, why, base });

const SURFACES = ['--bg-panel', '--bg-app', '--bg-elevated', '--bg-hover', '--bg-sunken', '--bg-input', '--bg-grid-alt'];
const CONTRAST_MATRIX: Pair[] = [
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
  ...['sqlserver', 'oracle', 'sqlite'].map((p) => pair('--provider-fg', `--provider-${p}`, UI, 'provider tile glyph')),
  pair('--brand-fg', '--brand', UI, 'brand mark'),
];

function ratio(t: TokenMap, p: Pair): number {
  const value = (name: string) => {
    const v = t[name];
    if (!v || !parseColor(v)) throw new Error(`${name} is not a colour (${v})`);
    return v;
  };
  return contrast(value(p.fg), value(p.bg), p.base ? value(p.base) : value('--bg-panel'));
}

describe('design tokens', () => {
  it('defines every spec token with the listed value in both themes', () => {
    for (const [name, l, d] of SPEC) {
      expect(RAW.light[name], `${name} light`).toBe(l);
      expect(RAW.dark[name], `${name} dark`).toBe(d);
    }
    for (const [name, v] of SPEC_SCALE) expect(RAW.light[name], name).toBe(v);
  });

  it('keeps --border-control only as an alias of --border-strong (deprecated)', () => {
    expect(RAW.light['--border-control']).toBe('var(--border-strong)');
    expect(RAW.dark['--border-control']).toBe('var(--border-strong)');
  });

  for (const theme of THEMES) {
    it(`meets the 5.1 contrast targets on the spec names (${theme})`, () => {
      const t = TOKENS[theme];
      expect(contrast(t['--fg'], t['--bg-panel'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--fg-muted'], t['--bg-panel'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--border'], t['--bg-panel'])).toBeGreaterThanOrEqual(1.5);
      expect(contrast(t['--border-strong'], t['--bg-panel'])).toBeGreaterThanOrEqual(3);
      expect(contrast(t['--accent-fg'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
    });

    it(`meets every pair of the contrast matrix (${theme})`, () => {
      const t = TOKENS[theme];
      const failures = CONTRAST_MATRIX.flatMap((p) => {
        const r = ratio(t, p);
        return r + 1e-9 >= p.min ? [] : [`${theme}: ${p.fg} on ${p.bg}${p.base ? ` over ${p.base}` : ''} = ${r.toFixed(2)} < ${p.min} (${p.why})`];
      });
      expect(failures).toEqual([]);
    });
  }

  it('draws triggers in amber, never in the error or warning colour (design-21 e)', () => {
    for (const theme of THEMES) {
      const t = TOKENS[theme];
      expect(t['--obj-trigger'], theme).toBe(theme === 'light' ? '#a16207' : '#facc15');
      expect(t['--obj-trigger'], `${theme}: trigger vs --danger`).not.toBe(t['--danger']);
      expect(t['--obj-trigger'], `${theme}: trigger vs --warning`).not.toBe(t['--warning']);
      expect(contrast(t['--obj-trigger'], t['--bg-panel']), `${theme}: trigger icon on --bg-panel`).toBeGreaterThanOrEqual(UI);
    }
    expect(CONTRAST_MATRIX.some((p) => p.fg === '--obj-trigger' && p.bg === '--bg-panel' && p.min >= UI)).toBe(true);
  });

  it('resolves var() aliases and translucent colours', () => {
    expect(TOKENS.dark['--text-faint']).toBe('#646a74');
    expect(TOKENS.light['--fg-muted-on-selected']).toBe('#5f6673');
    expect(contrast('rgb(0 0 0 / 0%)', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#000000', 'rgb(0 0 0 / 50%)', '#ffffff')).toBeGreaterThan(1);
  });
});

describe('Monaco theme (styles-02/12/13)', () => {
  for (const theme of THEMES) {
    const th = buildMonacoTheme(theme, TOKENS[theme]);
    const surfaceOf = (key: string) => th.colors[WIDGET_SURFACE[key.split('.')[0]] ?? 'editor.background'] ?? th.colors['editor.background'];

    it(`uses only token colours, all valid (${theme})`, () => {
      expect(th.base).toBe(theme === 'dark' ? 'vs-dark' : 'vs');
      for (const [k, v] of Object.entries(th.colors)) expect(parseColor(v), `${k}=${v}`).not.toBeNull();
      for (const r of th.rules) expect(r.foreground, r.token).toMatch(/^[0-9a-f]{6}$/);
      expect(th.colors['editor.background']).toBe(TOKENS[theme]['--bg-panel']);
      expect(contrast(th.colors['editor.foreground'], th.colors['editor.background'])).toBeGreaterThanOrEqual(4.5);
    });

    it(`gives every selected/focused/hovered row background a readable foreground (${theme})`, () => {
      // list-like rows only: not the editor's text selection (editor.*) nor the scrollbar thumb
      const keys = Object.keys(th.colors).filter((k) => /(selected|[sS]election|focus|hover)Background$/.test(k) && !/^(editor|scrollbarSlider)\./.test(k));
      expect(keys).toEqual(expect.arrayContaining(['editorSuggestWidget.selectedBackground', 'list.activeSelectionBackground', 'quickInputList.focusBackground', 'menu.selectionBackground']));
      const failures = keys.flatMap((bgKey) => {
        const fgKey = bgKey.replace(/Background$/, 'Foreground');
        const fg = th.colors[fgKey];
        if (!fg) return [`${theme}: ${bgKey} has no ${fgKey} (Monaco's base theme would pick its own, e.g. white)`];
        const r = contrast(fg, th.colors[bgKey], surfaceOf(bgKey));
        return r >= 4.5 ? [] : [`${theme}: ${fgKey} on ${bgKey} = ${r.toFixed(2)} < 4.5`];
      });
      expect(failures).toEqual([]);
      for (const k of ['editorSuggestWidget.selectedIconForeground', 'list.activeSelectionIconForeground', 'quickInputList.focusIconForeground']) {
        expect(th.colors[k], k).toBe(th.colors['editor.foreground']);
      }
    });

    it(`keeps matched characters readable in the suggest list (${theme})`, () => {
      const c = th.colors;
      expect(contrast(c['editorSuggestWidget.highlightForeground'], c['editorSuggestWidget.background'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c['editorSuggestWidget.focusHighlightForeground'], c['editorSuggestWidget.selectedBackground'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c['list.focusHighlightForeground'], c['list.focusBackground'])).toBeGreaterThanOrEqual(4.5);
    });

    it(`separates widgets from the editor and shows keyboard focus (${theme})`, () => {
      const c = th.colors;
      expect(contrast(c['editorWidget.border'], c['editor.background'])).toBeGreaterThanOrEqual(3);
      expect(contrast(c['input.border'], c['input.background'])).toBeGreaterThanOrEqual(3);
      expect(parseColor(c['widget.shadow'])!.a).toBeGreaterThan(0);
      expect(c['focusBorder']).toBe(TOKENS[theme]['--focus-ring']);
      expect(parseColor(c['menu.background'])!.a).toBe(1);
    });
  }

  it('has no colour literals in the Monaco theme builder or the editor setup', () => {
    for (const f of ['theme/monacoTheme.ts', 'editor/monaco-setup.ts', 'editor/SqlEditor.tsx', 'editor/monacoOptions.ts']) {
      expect(SOURCES[f], f).toBeTruthy();
      const code = SOURCES[f].replace(/\/\/.*$/gm, '');
      expect(code.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [], f).toEqual([]);
    }
  });
});

describe('Monaco context view (styles-01)', () => {
  // A context menu inside Monaco's default shadow root gets none of the theme variables and renders transparent.
  // With baseMonacoOptions() it renders in the light DOM, where the injected theme stylesheet colours it.
  for (const theme of THEMES) {
    it(`renders the editor context menu with an opaque themed background (${theme})`, async () => {
      const canvas = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
      const getContext = canvas.getContext;
      const noop: ProxyHandler<object> = { get: (_t, p) => (p === 'measureText' ? () => ({ width: 0 }) : p === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined), set: () => true };
      canvas.getContext = () => new Proxy({}, noop);
      const monaco = await import('../editor/monaco');
      const { baseMonacoOptions } = await import('../editor/monacoOptions');
      const id = `qa-${theme}`;
      const th = buildMonacoTheme(theme, TOKENS[theme]);
      monaco.editor.defineTheme(id, th as Parameters<typeof monaco.editor.defineTheme>[1]);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const ed = monaco.editor.create(host, { ...baseMonacoOptions(), value: 'SELECT 1', theme: id, fixedOverflowWidgets: true, minimap: { enabled: false } });
      try {
        ed.focus();
        await ed.getAction('editor.action.showContextMenu')!.run();
        await new Promise((r) => setTimeout(r, 30));
        expect(document.querySelector('.shadow-root-host'), 'context view inside a shadow root').toBeNull();
        const view = document.querySelector<HTMLElement>('.context-view');
        expect(view, 'context view in the light DOM').not.toBeNull();
        expect(view!.querySelector('.monaco-menu'), 'menu rendered').not.toBeNull();
        // resolve --vscode-menu-background the way the browser would: the theme stylesheet rule that matches it
        const sheet = [...document.querySelectorAll('style.monaco-colors')].map((s) => s.textContent ?? '').join('\n');
        let bg: string | null = null;
        for (const m of sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
          const v = /--vscode-menu-background:\s*([^;]+);/.exec(m[2]);
          if (v && view!.closest(m[1].trim())) bg = v[1].trim();
        }
        expect(bg, 'menu background variable reaches the context view').not.toBeNull();
        expect(parseColor(bg!)?.a, `menu background ${bg}`).toBe(1);
        expect(bg).toBe(TOKENS[theme]['--bg-elevated']);
      } finally {
        ed.dispose();
        host.remove();
        document.querySelectorAll('.context-view').forEach((n) => n.remove());
        canvas.getContext = getContext;
      }
    }, 20000);
  }
});

// ------------------------------------------------------------------ CSS lints

/** Top-level and at-rule-nested style rules of a stylesheet (comments stripped). */
function cssRules(text: string): { ctx: string; selectors: string[]; body: string; line: number }[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: { ctx: string; selectors: string[]; body: string; line: number }[] = [];
  const stack: { pre: string; body: number }[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '{') { stack.push({ pre: t.slice(start, i).trim(), body: i + 1 }); start = i + 1; }
    else if (t[i] === '}') {
      const top = stack.pop();
      if (top && !top.pre.startsWith('@') && !/^(from|to|[\d.]+%)$/.test(top.pre)) {
        const selectors: string[] = [];
        let depth = 0, cur = '';
        for (const ch of top.pre) {
          if (ch === '(' || ch === '[') depth++;
          if (ch === ')' || ch === ']') depth--;
          if (ch === ',' && depth === 0) { selectors.push(cur.trim().replace(/\s+/g, ' ')); cur = ''; } else cur += ch;
        }
        selectors.push(cur.trim().replace(/\s+/g, ' '));
        out.push({ ctx: stack.map((s) => s.pre.replace(/\s+/g, ' ')).join(' > '), selectors, body: t.slice(top.body, i), line: t.slice(0, top.body).split('\n').length });
      }
      start = i + 1;
    } else if (t[i] === ';' && stack.length === 0) start = i + 1;
  }
  return out;
}

/** Files the colour lint covers: app code outside src/theme/; tests and mock data (stored profile colours) excluded. */
const LINTED = Object.entries(SOURCES).filter(([p]) => !p.startsWith('theme/') && !/\.test\.tsx?$/.test(p) && !p.startsWith('mocks/') && !p.startsWith('test/'));

describe('token lint (QA 5.1)', () => {
  it('has no hex colours in .css/.ts/.tsx outside src/theme/', () => {
    expect(LINTED.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const [path, text] of LINTED) {
      text.split('\n').forEach((line, i) => {
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('has no rgb()/rgba()/hsl()/hsla() colour literals outside src/theme/', () => {
    const offenders: string[] = [];
    for (const [path, text] of LINTED) {
      text.split('\n').forEach((line, i) => {
        if (/\b(?:rgba?|hsla?)\(/.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('uses --fg-disabled / --text-faint only for disabled controls (2.5:1 is never informative text)', () => {
    const DISABLED = /:disabled|\.disabled\b|\[disabled\]|\[aria-disabled/;
    // documented exceptions (not text a user has to read)
    const ALLOWED: Record<string, string> = { 'theme/monacoTheme.ts': 'editor line numbers (incidental gutter text)' };
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(SOURCES)) {
      if (path === 'theme/tokens.css' || path in ALLOWED || /\.test\.tsx?$/.test(path)) continue;
      if (!/--(?:fg-disabled|text-faint)\b/.test(text)) continue;
      if (!path.endsWith('.css')) {
        offenders.push(`${path}: uses --fg-disabled/--text-faint outside a stylesheet (no :disabled context)`);
        continue;
      }
      for (const r of cssRules(text)) {
        if (!/var\(\s*--(?:fg-disabled|text-faint)\b/.test(r.body)) continue;
        const bad = r.selectors.filter((s) => !DISABLED.test(s));
        if (bad.length) offenders.push(`${path}:${r.line}: ${bad.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the theme stylesheets on the type scale (sizes via --text-*, weights 400/600 via --weight-*)', () => {
    const offenders: string[] = [];
    for (const f of ['theme/app.css', 'theme/shell.css']) {
      for (const r of cssRules(SOURCES[f])) {
        for (const m of r.body.matchAll(/(font-size|font-weight)\s*:\s*([^;]+)/g)) {
          const v = m[2].trim();
          const ok = m[1] === 'font-size' ? /^var\(--(text-(xs|sm|md|lg|xl|2xl)|fs(-sm|-xs)?)\)$|^inherit$/.test(v) : /^var\(--weight-(regular|strong)\)$|^inherit$/.test(v);
          if (!ok) offenders.push(`${f}:${r.line}: ${r.selectors.join(', ')} { ${m[1]}: ${v} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('icon sizing (styles-10, styles-r1-02)', () => {
  const rules = ['theme/app.css', 'theme/shell.css'].flatMap((f) => cssRules(SOURCES[f]).filter((r) => !r.ctx).map((r) => ({ ...r, file: f })));
  /** Declarations of the top-level rules whose selector list contains `selector`, later rules winning. */
  const decls = (selector: string) => {
    const out: Record<string, string> = {};
    for (const r of rules.filter((x) => x.selectors.includes(selector))) {
      for (const m of r.body.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) out[m[1]] = m[2].trim();
    }
    return out;
  };

  it('resets the UA button padding on icon buttons, so a 16/14 px icon keeps its size in a 20-28 px button', () => {
    // The default button padding (1px 6px) left a 12 px content box in a 24 px .icon-btn.sm and a flex-shrunk svg.
    for (const sel of ['.icon-btn', '.tab-close', '.split-caret', '.search-toggle']) {
      expect(decls(sel).padding, `${sel} { padding }`).toBe('0');
    }
    expect(decls('svg.lucide')['flex-shrink'], 'svg.lucide { flex-shrink }').toBe('0');
  });

  it('sizes icons with the tokens: 16 px in buttons, menus and the palette; 14 px only in the documented dense spots', () => {
    for (const sel of ['.icon-btn > svg.lucide', '.btn > svg.lucide', '.menu-icon > svg.lucide', '.palette-icon > svg.lucide']) {
      expect(decls(sel), sel).toMatchObject({ width: 'var(--icon-size)', height: 'var(--icon-size)' });
    }
    for (const sel of ['.statusbar svg.lucide', '.chip > svg.lucide', '.tab-close > svg.lucide', '.dock-tab > svg.lucide', '.split-caret > svg.lucide', '.btn-xs > svg.lucide']) {
      expect(decls(sel), sel).toMatchObject({ width: 'var(--icon-size-sm)', height: 'var(--icon-size-sm)' });
    }
  });

  it('defaults the stroke to 1.5 but lets icons that opt out with data-stroke keep their own width', () => {
    // A CSS stroke-width beats the SVG attribute: an unconditional rule would thin the 9 px PK/FK badge to 0.56 px.
    expect(decls('svg.lucide')['stroke-width']).toBeUndefined();
    expect(decls('svg.lucide:not([data-stroke])')['stroke-width']).toBe('1.5');
    const other = rules.filter((r) => /stroke-width/.test(r.body) && !r.selectors.includes('svg.lucide:not([data-stroke])'));
    expect(other.map((r) => `${r.file}:${r.line}`)).toEqual([]);
    // the deliberate exceptions carry the opt-out
    expect(SOURCES['components/common/icons.tsx']).toMatch(/strokeWidth=\{2\} data-stroke=""/);
    expect(SOURCES['components/common/icons.tsx'].match(/strokeWidth=\{2\.5\} data-stroke=""/g)).toHaveLength(2);
    expect(SOURCES['components/common/Select.tsx']).toMatch(/<Check size=\{14\} strokeWidth=\{2\} data-stroke="" \/>/);
  });
});

describe('one rule per selector (styles-21)', () => {
  const files = ['theme/app.css', 'theme/shell.css'];
  const rules = files.flatMap((f) => cssRules(SOURCES[f]).map((r) => ({ ...r, file: f })));

  it('defines no selector in both app.css and shell.css', () => {
    const where = new Map<string, Set<string>>();
    for (const r of rules) for (const s of r.selectors) {
      const k = `${r.ctx ? `${r.ctx} > ` : ''}${s}`;
      if (!where.has(k)) where.set(k, new Set());
      where.get(k)!.add(r.file);
    }
    expect([...where].filter(([, fs]) => fs.size > 1).map(([k]) => k)).toEqual([]);
  });

  it('has no duplicate selector (list) within a stylesheet', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const r of rules) {
      const k = `${r.file}|${r.ctx}|${[...r.selectors].sort().join(', ')}`;
      if (seen.has(k)) dups.push(`${r.file}:${r.line} repeats ${seen.get(k)}: ${r.selectors.join(', ')}`);
      else seen.set(k, `${r.file}:${r.line}`);
    }
    expect(dups).toEqual([]);
  });
});

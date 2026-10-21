// IntelliSense widget look (editor/editor-widgets.css + the Monaco theme): kind icon colours per completion kind,
// contrast of every colour the suggest list, its details panel, parameter hints and hovers paint, and the stylesheet
// lints (tokens only, the type scale, and the layout fixes that keep the last row from being clipped).
import { describe, expect, it } from 'vitest';
import { blend, contrast, parseColor, parseTokenBlocks, resolveTokens, toHex, type TokenMap } from './index';
import { buildMonacoTheme, SUGGEST_KIND_COLORS } from './monacoTheme';

interface NodeFs { readFileSync(p: string, enc: 'utf8'): string }
const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as NodeFs;
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const read = (p: string) => nodeFs.readFileSync(`${cwd}/src/${p}`, 'utf8');

const TOKENS_CSS = read('theme/tokens.css');
const RAW = parseTokenBlocks(TOKENS_CSS);
const TOKENS: Record<'light' | 'dark', TokenMap> = { light: resolveTokens(RAW.light), dark: resolveTokens(RAW.dark) };
const THEMES = ['light', 'dark'] as const;
const WIDGET_CSS = read('editor/editor-widgets.css');
const CSS_NO_COMMENTS = WIDGET_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const TEXT = 4.5;
const UI = 3;

/** Monaco CompletionItemKind → the `symbolIcon.<key>Foreground` colour of the codicon it draws. */
const CODICON_KEY: Record<string, string> = {
  Struct: 'struct', Interface: 'interface', Field: 'field', Reference: 'reference', Module: 'module', Folder: 'folder',
  Class: 'class', Function: 'function', Method: 'method', Keyword: 'keyword', Snippet: 'snippet', Variable: 'variable',
  TypeParameter: 'typeParameter', Constant: 'constant', EnumMember: 'enumeratorMember', Operator: 'operator',
  Value: 'enumerator', Constructor: 'constructor', Property: 'property', Text: 'text',
};

/** DbStudio completion kind → Monaco kind, read from editor/monaco-setup.ts (KIND), so the test follows the code. */
function sqlKinds(): Record<string, string> {
  const src = read('editor/monaco-setup.ts');
  const block = /const KIND[^{]*\{([\s\S]*?)\n\};/.exec(src);
  expect(block, 'KIND table in monaco-setup.ts').not.toBeNull();
  return Object.fromEntries([...block![1].matchAll(/(\w+): monaco\.languages\.CompletionItemKind\.(\w+)/g)].map((m) => [m[1], m[2]]));
}

describe('IntelliSense kind icons', () => {
  const kinds = sqlKinds();
  /** The kinds the suggest list must tell apart at a glance. */
  const DISTINCT = ['table', 'view', 'column', 'function', 'keyword', 'snippet', 'schema', 'database', 'alias'];

  it('gives every SQL completion kind a themed codicon colour', () => {
    expect(Object.keys(kinds).length).toBeGreaterThanOrEqual(DISTINCT.length);
    for (const [kind, monacoKind] of Object.entries(kinds)) {
      const key = CODICON_KEY[monacoKind];
      expect(key, `${kind} → CompletionItemKind.${monacoKind} has a codicon colour key`).toBeTruthy();
      expect(SUGGEST_KIND_COLORS[key], `${kind}: symbolIcon.${key}Foreground has a token`).toMatch(/^--kind-/);
    }
    // the Mongo and Redis consoles reuse codicons too
    for (const f of ['components/Mongo/language.ts', 'redis/language.ts']) {
      for (const m of read(f).matchAll(/CompletionItemKind\.(\w+)/g)) expect(SUGGEST_KIND_COLORS[CODICON_KEY[m[1]]], `${f}: ${m[1]}`).toBeTruthy();
    }
  });

  for (const theme of THEMES) {
    const th = buildMonacoTheme(theme, TOKENS[theme]);
    const c = th.colors;
    const colorOf = (kind: string) => c[`symbolIcon.${CODICON_KEY[kinds[kind]]}Foreground`];

    it(`tells table, view, column, function, keyword, snippet, schema, database and alias apart (${theme})`, () => {
      const colors = DISTINCT.map((k) => {
        const v = colorOf(k);
        expect(parseColor(v ?? ''), `${theme}: ${k} colour ${v}`).not.toBeNull();
        return v.toLowerCase();
      });
      expect(new Set(colors).size, `${theme}: ${DISTINCT.map((k, i) => `${k}=${colors[i]}`).join(' ')}`).toBe(DISTINCT.length);
      // procedures read as routines (same hue as functions); packages as schema-like containers
      expect(colorOf('procedure')).toBe(colorOf('function'));
      expect(colorOf('package')).toBe(colorOf('schema'));
    });

    it(`keeps every kind icon visible on the list and on the selected row (${theme})`, () => {
      const failures = Object.keys(SUGGEST_KIND_COLORS).flatMap((k) => {
        const fg = c[`symbolIcon.${k}Foreground`];
        if (!fg) return [`${theme}: symbolIcon.${k}Foreground missing`];
        return [['editorSuggestWidget.background', c['editorSuggestWidget.background']], ['editorSuggestWidget.selectedBackground', c['editorSuggestWidget.selectedBackground']], ['list.hoverBackground', c['list.hoverBackground']]]
          .flatMap(([name, bg]) => {
            const r = contrast(fg, bg, c['editorSuggestWidget.background']);
            return r >= UI ? [] : [`${theme}: ${k} ${fg} on ${name} ${bg} = ${r.toFixed(2)} < ${UI}`];
          });
      });
      expect(failures).toEqual([]);
    });
  }
});

describe('IntelliSense widget colours', () => {
  for (const theme of THEMES) {
    const t = TOKENS[theme];
    const c = buildMonacoTheme(theme, t).colors;
    const surface = c['editorSuggestWidget.background'];

    it(`reads the list text, the muted type/detail column and the matched characters (${theme})`, () => {
      expect(contrast(c['editorSuggestWidget.foreground'], surface)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['editorSuggestWidget.selectedForeground'], c['editorSuggestWidget.selectedBackground'], surface)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['list.hoverForeground'], c['list.hoverBackground'], surface)).toBeGreaterThanOrEqual(TEXT);
      // the type/detail column: --fg-muted, --fg-muted-on-selected on the focused row (editor-widgets.css)
      // (hovered rows switch to the on-selected tokens: plain --fg-muted / --accent fall under 4.5:1 on the hover tint)
      expect(contrast(t['--fg-muted'], surface)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(t['--fg-muted-on-selected'], c['list.hoverBackground'], surface)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(t['--fg-muted-on-selected'], c['editorSuggestWidget.selectedBackground'], surface)).toBeGreaterThanOrEqual(TEXT);
      // matched characters in the accent colour, on plain, hovered and selected rows
      expect(c['editorSuggestWidget.highlightForeground']).toBe(t['--accent']);
      expect(contrast(c['editorSuggestWidget.highlightForeground'], surface)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(t['--accent-on-selected'], c['list.hoverBackground'], surface)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['editorSuggestWidget.focusHighlightForeground'], c['editorSuggestWidget.selectedBackground'], surface)).toBeGreaterThanOrEqual(TEXT);
    });

    it(`separates hovered and selected rows from the list softly but visibly (${theme})`, () => {
      const hover = contrast(c['list.hoverBackground'], surface);
      const selected = contrast(c['editorSuggestWidget.selectedBackground'], surface);
      expect(hover, 'hover is subtle').toBeLessThan(1.5);
      expect(hover, 'hover is visible').toBeGreaterThanOrEqual(1.1);
      expect(selected, 'selection is clearer than hover').toBeGreaterThan(hover);
      expect(selected, 'selection stays soft').toBeLessThan(2);
    });

    it(`colours the details panel, parameter hints and hovers from the tokens (${theme})`, () => {
      const hover = c['editorHoverWidget.background'];
      expect(hover).toBe(t['--bg-elevated']);
      expect(contrast(c['editorHoverWidget.foreground'], hover)).toBeGreaterThanOrEqual(TEXT);
      // active parameter: accent text, on the soft accent chip of editor-widgets.css too
      expect(c['editorHoverWidget.highlightForeground']).toBe(t['--accent']);
      expect(contrast(c['editorHoverWidget.highlightForeground'], hover)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(t['--accent'], t['--accent-soft'])).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['textLink.foreground'], hover)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['textLink.activeForeground'], hover)).toBeGreaterThanOrEqual(TEXT);
      // inline code: body text on the code background; table headers and types in hovers: muted text
      expect(contrast(t['--fg'], c['textCodeBlock.background'])).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(t['--fg-muted'], hover)).toBeGreaterThanOrEqual(TEXT);
      expect(contrast(c['editorSuggestWidgetStatus.foreground'], surface)).toBeGreaterThanOrEqual(TEXT);
      // widget edges against the editor
      expect(parseColor(c['editorSuggestWidget.border'])).not.toBeNull();
      expect(contrast(c['editorSuggestWidget.border'], c['editor.background'])).toBeGreaterThanOrEqual(1.2);
    });
  }
});

describe('Compare diff and scrollbar colours', () => {
  const SYNTAX = ['--fg', '--syn-keyword', '--syn-string', '--syn-comment', '--syn-number', '--syn-function', '--syn-variable', '--syn-operator', '--syn-type'];
  for (const theme of THEMES) {
    const t = TOKENS[theme];
    const c = buildMonacoTheme(theme, t).colors;
    const over = (top: string, bottom: string) => toHex(blend(parseColor(top)!, parseColor(bottom)!));
    const panel = c['editor.background'];

    it(`keeps body and syntax text readable on every diff tint, a wholly inserted line (line + text tint) too (${theme})`, () => {
      const surfaces: Record<string, string> = {
        insertedLine: over(c['diffEditor.insertedLineBackground'], panel),
        insertedText: over(c['diffEditor.insertedTextBackground'], over(c['diffEditor.insertedLineBackground'], panel)),
        removedLine: over(c['diffEditor.removedLineBackground'], panel),
        removedText: over(c['diffEditor.removedTextBackground'], over(c['diffEditor.removedLineBackground'], panel)),
      };
      const failures = Object.entries(surfaces).flatMap(([name, bg]) => SYNTAX.flatMap((fg) => {
        const r = contrast(t[fg], bg);
        return r >= TEXT ? [] : [`${theme}: ${fg} on ${name} ${bg} = ${r.toFixed(2)}`];
      }));
      expect(failures).toEqual([]);
    });

    it(`tints softly: changes visible, the hatch faint (${theme})`, () => {
      for (const k of ['diffEditor.insertedLineBackground', 'diffEditor.removedLineBackground']) {
        const r = contrast(over(c[k], panel), panel);
        expect(r, k).toBeGreaterThan(1.02);
        expect(r, k).toBeLessThan(1.25);
      }
      expect(contrast(over(c['diffEditor.diagonalFill'], panel), panel)).toBeLessThan(1.15);
      expect(parseColor(c['diffEditorOverview.insertedForeground'])!.a).toBeGreaterThan(0.3);
      expect(c['diffEditor.insertedLineBackground']).not.toBe(c['diffEditor.removedLineBackground']);
    });

    it(`steps the scrollbar slider: rest < hover < dragging, no shadow (${theme})`, () => {
      const step = (k: string) => contrast(over(c[k], panel), panel);
      expect(step('scrollbarSlider.hoverBackground')).toBeGreaterThan(step('scrollbarSlider.background'));
      expect(step('scrollbarSlider.activeBackground')).toBeGreaterThan(step('scrollbarSlider.hoverBackground'));
      expect(parseColor(c['scrollbar.shadow'])!.a).toBe(0);
    });
  }
});

describe('editor-widgets.css', () => {
  const rules = [...CSS_NO_COMMENTS.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
  const decl = (selector: string, prop: string) => {
    const r = rules.filter((x) => x.selector.split(',').map((s) => s.trim()).includes(selector));
    const v = r.flatMap((x) => [...x.body.matchAll(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim()));
    return v[v.length - 1];
  };

  it('is loaded with Monaco, after its CSS', () => {
    const src = read('editor/monaco.ts');
    expect(src.indexOf("import './editor-widgets.css'")).toBeGreaterThan(src.indexOf("import 'monaco-editor/features/register.all'"));
  });

  it('uses only design tokens and Monaco theme variables: no colour literals, no undefined tokens', () => {
    expect(CSS_NO_COMMENTS.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\b(?:white|black)\b/g) ?? []).toEqual([]);
    const defined = new Set(Object.keys(RAW.light));
    const used = [...CSS_NO_COMMENTS.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    const unknown = used.filter((v) => !v.startsWith('--vscode-') && v !== '--suggest-kind-fg' && !defined.has(v));
    expect(unknown).toEqual([]);
    // every theme colour the stylesheet reads is one the Monaco theme defines
    const th = buildMonacoTheme('light', TOKENS.light).colors;
    const missing = [...new Set(used.filter((v) => /^--vscode-(symbolIcon|editorSuggestWidget|editorHoverWidget)-/.test(v)))]
      .map((v) => v.slice('--vscode-'.length).replace('-', '.'))
      .filter((k) => !th[k]);
    expect(missing).toEqual([]);
  });

  it('keeps sizes on the type scale (font sizes via --text-*, weights via --weight-*)', () => {
    const offenders: string[] = [];
    for (const r of rules) {
      for (const m of r.body.matchAll(/(font-size|font-weight)\s*:\s*([^;]+)/g)) {
        const v = m[2].trim();
        const ok = m[1] === 'font-size'
          ? /^var\(--text-(xs|sm|md)\)$|^max\(var\(--text-(xs|sm|md)\), [\d.]+em\)$/.test(v)
          : /^var\(--weight-(regular|strong)\)$/.test(v);
        if (!ok) offenders.push(`${r.selector} { ${m[1]}: ${v} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never clips the last suggestion row', () => {
    // Monaco sizes the widget and the details panel as content + 1 px borders: content-box, not the app's border-box
    expect(decl('.monaco-editor .suggest-widget', 'box-sizing')).toBe('content-box');
    expect(decl('.monaco-editor .suggest-details', 'box-sizing')).toBe('content-box');
    // the list container is a `.tree`, which app.css styles for the Explorer (padding-bottom, overflow)
    expect(read('theme/app.css')).toMatch(/\n\.tree \{[^}]*padding-bottom/);
    expect(decl('.monaco-editor .suggest-widget > .tree', 'padding')).toBe('0');
    expect(decl('.monaco-editor .suggest-widget > .tree', 'overflow')).toBe('hidden');
    // the row highlight is inset with transparent side borders only: the laid-out row height is untouched
    const row = '.monaco-editor .suggest-widget .monaco-list .monaco-list-row';
    expect(decl(row, 'border-inline')).toMatch(/transparent/);
    expect(decl(row, 'background-clip')).toBe('padding-box');
    expect(rules.filter((r) => r.selector.includes('.monaco-list-row') && /(^|;)\s*(padding|border|margin)(-top|-bottom|-block)?\s*:/.test(r.body) && !/border-inline/.test(r.body))).toEqual([]);
  });

  it('rounds the popups and gives them the app popup shadow', () => {
    for (const sel of ['.monaco-editor .suggest-widget', '.monaco-editor .suggest-details', '.monaco-editor .parameter-hints-widget', '.monaco-editor .monaco-resizable-hover']) {
      expect(decl(sel, 'border-radius'), sel).toBe('var(--radius-lg)');
      expect(decl(sel, 'box-shadow'), sel).toBe('var(--shadow-popup)');
    }
  });

  it('shows the type/detail on every row, right-aligned and muted, and keeps kind colours on the focused row', () => {
    const details = '.monaco-editor .suggest-widget .monaco-list .monaco-list-row > .contents > .main > .right > .details-label';
    expect(decl(details, 'display')).toBe('inline');
    expect(decl(details, 'color')).toBe('var(--fg-muted)');
    expect(decl('.monaco-editor .suggest-widget .monaco-list .monaco-list-row.focused > .contents > .main > .right > .details-label', 'color')).toBe('var(--fg-muted-on-selected)');
    expect(decl('.monaco-editor .suggest-widget .monaco-list .monaco-list-row:hover > .contents > .main > .right > .details-label', 'color')).toBe('var(--fg-muted-on-selected)');
    expect(decl('.monaco-editor .suggest-widget .monaco-list .monaco-list-row:hover:not(.focused) > .contents > .main .monaco-highlighted-label .highlight', 'color')).toBe('var(--accent-on-selected)');
    expect(decl('.monaco-editor .suggest-widget .monaco-list .monaco-list-row.focused .suggest-icon.codicon', 'color')).toMatch(/var\(--suggest-kind-fg/);
    for (const k of Object.keys(SUGGEST_KIND_COLORS)) expect(CSS_NO_COMMENTS, k).toContain(`var(--vscode-symbolIcon-${k}Foreground)`);
  });
});

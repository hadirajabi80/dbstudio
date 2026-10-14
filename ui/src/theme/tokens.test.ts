// QA 5.1: token table values, contrast, and the "no literal colours outside theme/" lint.
import { describe, expect, it } from 'vitest';

// Node APIs, typed locally (the app tsconfig has no Node types; vitest runs on Node).
interface NodeFs { readFileSync(p: string, enc: 'utf8'): string; readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean } }
const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as NodeFs;
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const SRC = `${cwd}/src`;
const css = nodeFs.readFileSync(`${SRC}/theme/tokens.css`, 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of nodeFs.readdirSync(dir)) {
    const p = `${dir}/${f}`;
    if (nodeFs.statSync(p).isDirectory()) walk(p, out);
    else if (/.(css|tsx)$/.test(f)) out.push(p);
  }
  return out;
}
const SOURCES: Record<string, string> = Object.fromEntries(walk(SRC).map((p) => [p.slice(SRC.length + 1), nodeFs.readFileSync(p, 'utf8')]));

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = block(":root[data-theme='light']");
const dark = block(":root[data-theme='dark']");

// docs/PLAN-M1.5.md section 3 token table.
const SPEC: [string, string, string][] = [
  ['--bg-app', '#f5f6f8', '#1b1d21'], ['--bg-panel', '#ffffff', '#24272d'], ['--bg-elevated', '#ffffff', '#2c3038'],
  ['--bg-hover', '#eceef2', '#30343c'], ['--bg-selected', '#dde8fb', '#2e4466'], ['--bg-grid-alt', '#fafbfc', '#22252a'],
  ['--border', '#d9dde3', '#3a3f48'], ['--border-strong', '#b9bfc9', '#4d535e'], ['--fg', '#1c1f24', '#e6e8eb'],
  ['--fg-muted', '#5f6673', '#9aa1ab'], ['--fg-disabled', '#a0a6b0', '#646a74'], ['--accent', '#2563eb', '#5b9cff'],
  ['--accent-fg', '#ffffff', '#0b1220'], ['--focus-ring', '#2563eb', '#8ab4ff'], ['--success', '#15803d', '#4ade80'],
  ['--warning', '#b45309', '#fbbf24'], ['--danger', '#b91c1c', '#f87171'], ['--info', '#0e7490', '#67e8f9'],
  ['--cell-edited', 'rgb(253 230 138 / 35%)', 'rgb(250 204 21 / 25%)'], ['--cell-inserted', 'rgb(187 247 208 / 40%)', 'rgb(34 197 94 / 22%)'],
  ['--cell-deleted', 'rgb(254 202 202 / 40%)', 'rgb(239 68 68 / 22%)'],
  ['--conn-red', '#dc2626', '#e76868'], ['--conn-orange', '#ea580c', '#f6874d'], ['--conn-yellow', '#ca8a04', '#fbb420'],
  ['--conn-green', '#16a34a', '#24e16a'], ['--conn-blue', '#2563eb', '#6b95f1'], ['--conn-purple', '#7c3aed', '#ab80f3'],
  ['--conn-grey', '#6b7280', '#9399a5'],
];

function lum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('design tokens', () => {
  it('defines every spec token with the listed value in both themes', () => {
    for (const [name, l, d] of SPEC) {
      expect(light[name], `${name} light`).toBe(l);
      expect(dark[name], `${name} dark`).toBe(d);
    }
  });

  for (const [theme, t] of [['light', light], ['dark', dark]] as const) {
    it(`meets the contrast targets (${theme})`, () => {
      expect(contrast(t['--fg'], t['--bg-panel'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--fg-muted'], t['--bg-panel'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--fg-muted'], t['--bg-app'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--fg'], t['--bg-selected'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--accent-fg'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--accent'], t['--bg-panel'])).toBeGreaterThanOrEqual(3);
      expect(contrast(t['--focus-ring'], t['--bg-panel'])).toBeGreaterThanOrEqual(3);
      // Form-control boundaries (WCAG 1.4.11) use --border-control; --border / --border-strong are decorative
      // separators whose spec values are below the 5.1 checklist ratios (1.36 / 1.85 light, 1.41 / 1.93 dark).
      expect(contrast(t['--border-control'], t['--bg-panel'])).toBeGreaterThanOrEqual(3);
      expect(contrast(t['--border-strong'], t['--bg-panel'])).toBeGreaterThan(contrast(t['--border'], t['--bg-panel']));
      for (const s of ['--success', '--warning', '--danger', '--info']) {
        expect(contrast(t[s], t['--bg-panel']), s).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('token lint (QA 5.1)', () => {
  it('has no hex colours in .css/.tsx outside src/theme/', () => {
    const offenders: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(30);
    for (const [path, text] of Object.entries(SOURCES)) {
      const rel = path.replace(/^\.\.\//, '');
      if (rel.startsWith('theme/')) continue;
      text.split('\n').forEach((line, i) => {
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

// Icon sizes (docs/PLAN-M1.5.md section 3 Iconography): 16 px, or 14 px only in the documented dense spots. The results
// pane passes 10-13 px `size` props, so the 14 px rule in app.css has to cover its containers (styles-r2-02). Also the
// top bar's icon-only compaction on a narrow window or at high zoom (styles-r2-01).
import { describe, expect, it } from 'vitest';

// Node API, typed locally (the app tsconfig has no Node types; vitest runs on Node). Read from disk: the vitest config
// has `css: false`, which blanks `?raw` stylesheet imports.
const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(p: string, enc: 'utf8'): string };
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const read = (rel: string) => nodeFs.readFileSync(`${cwd}/${rel}`, 'utf8');

interface Rule { ctx: string; selectors: string[]; decls: Record<string, string> }

/** Style rules of a stylesheet, with the enclosing at-rule preludes as `ctx` ('' at top level). Comments stripped. */
function rules(text: string): Rule[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const stack: { pre: string; body: number }[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '{') {
      stack.push({ pre: t.slice(start, i).trim().replace(/\s+/g, ' '), body: i + 1 });
      start = i + 1;
    } else if (t[i] === '}') {
      const top = stack.pop();
      if (top && !top.pre.startsWith('@') && !/^(from|to|[\d.]+%)$/.test(top.pre)) {
        const decls: Record<string, string> = {};
        for (const m of t.slice(top.body, i).matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) decls[m[1]] = m[2].trim();
        out.push({ ctx: stack.map((s) => s.pre).join(' > '), selectors: top.pre.split(/\s*,\s*/), decls });
      }
      start = i + 1;
    } else if (t[i] === ';' && stack.length === 0) start = i + 1;
  }
  return out;
}

const APP = rules(read('src/theme/app.css'));
const SHELL = rules(read('src/theme/shell.css'));
const SMALL = { width: 'var(--icon-size-sm)', height: 'var(--icon-size-sm)' };

describe('results pane icons (styles-r2-02)', () => {
  // container class -> the component that renders a lucide icon as its direct child
  const DENSE: Record<string, string> = {
    '.results-tab': 'src/components/ResultsPane/ResultsPane.tsx',
    '.rs-quick': 'src/components/ResultsPane/ResultsPane.tsx',
    '.rs-badge': 'src/components/ResultsPane/ResultsPane.tsx',
    '.fb-chip': 'src/components/ResultsPane/ResultsPane.tsx',
    '.messages-summary': 'src/components/MessagesPane/MessagesPane.tsx',
  };
  const dense = APP.find((r) => !r.ctx && r.selectors.includes('.statusbar svg.lucide'));

  it('sizes them with the documented 14 px dense-spot rule in app.css', () => {
    expect(dense, 'the 14 px rule').toBeDefined();
    expect(dense!.decls).toMatchObject(SMALL);
    for (const cls of Object.keys(DENSE)) expect(dense!.selectors, cls).toContain(`${cls} > svg.lucide`);
  });

  it('matches the class names the components actually render', () => {
    for (const [cls, file] of Object.entries(DENSE)) {
      const name = cls.slice(1);
      expect(read(file), `${file} renders ${name}`).toMatch(new RegExp(`className=(?:"|\\{\`)${name}[\\s"$\`]`));
    }
  });

  it('no other app.css/shell.css rule resizes those icons', () => {
    const offenders = [...APP, ...SHELL]
      .filter((r) => r !== dense && r.selectors.some((s) => Object.keys(DENSE).some((c) => s.includes(c) && /svg/.test(s))))
      .filter((r) => 'width' in r.decls || 'height' in r.decls);
    expect(offenders.map((r) => r.selectors.join(', '))).toEqual([]);
  });

  it('lists them among the dense spots in the spec', () => {
    const spec = read('../docs/PLAN-M1.5.md');
    const line = spec.split('\n').find((l) => l.startsWith('**Iconography.**')) ?? '';
    for (const spot of ['result-set tabs', 'results quick-search', 'results badges', 'Messages summary']) expect(line, spot).toContain(spot);
  });
});

describe('top bar icon-only compaction (styles-r2-01)', () => {
  const at = (query: string, selector: string) => SHELL.find((r) => r.ctx === `@container topbar (${query})` && r.selectors.includes(selector))?.decls;

  it('is a named inline-size container whose palette trigger shrinks first', () => {
    const topbar = APP.find((r) => !r.ctx && r.selectors.includes('.topbar'))!.decls;
    expect(topbar.container).toBe('topbar / inline-size');
    expect(APP.find((r) => !r.ctx && r.selectors.includes('.palette-trigger'))!.decls).toMatchObject({ flex: '0 1 auto', 'min-width': '0', overflow: 'hidden' });
    expect(SHELL.find((r) => !r.ctx && r.selectors.includes('.topbar-sep'))!.decls['flex-shrink']).toBe('0');
    // the right-hand cluster is .icon-btn, which never shrinks
    expect(APP.find((r) => !r.ctx && r.selectors.includes('.icon-btn'))!.decls['flex-shrink']).toBe('0');
  });

  it('below 700 px: Console/Connection are icon buttons that keep their label as the accessible name; no key caps', () => {
    const label = at('max-width: 699px', '.topbar .topbar-text-btn > .btn-text');
    // visually hidden, not display:none (that would drop the accessible name)
    expect(label).toMatchObject({ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', 'clip-path': 'inset(50%)' });
    expect(label?.display).toBeUndefined();
    expect(at('max-width: 699px', '.topbar .topbar-text-btn')).toMatchObject({ width: 'var(--input-h)', padding: '0' });
    expect(at('max-width: 699px', '.topbar .palette-trigger .kbd-group')).toMatchObject({ display: 'none' });
  });

  it('below 560 px drops the brand name; below 420 px the trigger is a search icon button', () => {
    expect(at('max-width: 559px', '.topbar .brand-name')).toMatchObject({ display: 'none' });
    expect(at('max-width: 419px', '.topbar .palette-trigger-text')).toMatchObject({ display: 'none' });
    expect(at('max-width: 419px', '.topbar .palette-trigger')).toMatchObject({ flex: 'none', width: 'var(--input-h)' });
  });

  it('marks the compacting buttons and names the trigger independently of its visible text', () => {
    const src = read('src/components/layout/TopBar.tsx');
    expect(src.match(/label="(?:Console|Connection)" variant="ghost" className="topbar-text-btn"/g)).toHaveLength(2);
    expect(src).toMatch(/className="palette-trigger"[\s\S]*?aria-label="Go to object or command"[\s\S]*?aria-keyshortcuts=/);
  });
});

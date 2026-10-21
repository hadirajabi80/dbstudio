import { describe, expect, it } from 'vitest';
import { catalogObject, SHOP_TABLES } from '../../../mocks/fixtures';
import { routeEdges } from '../edges';
import { exportScale, MAX_SIDE } from '../exportPng';
import { buildSvg } from '../exportSvg';
import { buildModel, geometryOf } from '../model';
import { buildScene, fit, readSceneTheme, type SceneTheme } from '../scene';

const THEME: SceneTheme = {
  bg: 'white', panel: 'white', sunken: 'whitesmoke', border: 'silver', borderStrong: 'gray', borderSubtle: 'gainsboro', fg: 'black',
  muted: 'dimgray', accent: 'royalblue', table: 'royalblue', view: 'purple', key: 'goldenrod', fk: 'teal', fontUi: 'Segoe UI, sans-serif', fontMono: 'Consolas, monospace',
};

function input(extra?: (s: ReturnType<typeof catalogObject>[]) => void) {
  const objects = SHOP_TABLES.map((t) => catalogObject(t, 'main'));
  extra?.(objects);
  const model = buildModel({ schemas: [{ name: 'main', version: 1, objects }], defaultSchema: 'main', scope: { database: null, schema: 'main' } });
  const geom = geometryOf(model, { columns: 'all', types: true });
  const positions: Record<string, [number, number]> = {};
  model.nodes.forEach((n, i) => (positions[n.key] = [(i % 3) * 360, Math.floor(i / 3) * 320]));
  return { model, geom, positions, edges: routeEdges(model, positions, geom), showTypes: true };
}

describe('SVG export', () => {
  it('is a well-formed SVG with every table, column and relationship (whole diagram)', () => {
    const svg = buildSvg(input(), THEME);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const root = doc.documentElement;
    expect(root.tagName).toBe('svg');
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    const texts = [...doc.getElementsByTagName('text')].map((t) => t.textContent);
    for (const t of SHOP_TABLES) expect(texts).toContain(t.name);
    expect(texts).toContain('customer_id');
    expect(texts).toContain('DECIMAL(12,2)');
    expect(texts).toContain('PK');
    expect(doc.querySelectorAll('path.edge, path.edgeOptional')).toHaveLength(5);
    expect(doc.getElementsByTagName('foreignObject')).toHaveLength(0);
    // theme colours are embedded
    expect(svg).toContain('.card{fill:white;stroke:silver');
    expect(svg).toContain('font-family:Consolas, monospace');
  });

  it('escapes markup in names and honours the types toggle', () => {
    const svg = buildSvg({ ...input((objs) => objs.push({ t: 'table', n: 'a<b>&"c"', c: [['x', 'int', 0, 1, 0, null]], pk: ['x'] })), showTypes: false }, THEME);
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
    expect(new DOMParser().parseFromString(svg, 'image/svg+xml').getElementsByTagName('parsererror')).toHaveLength(0);
    expect(svg).not.toContain('DECIMAL(12,2)');
  });

  it('builds the scene around every card with padding', () => {
    const inp = input();
    const scene = buildScene(inp);
    expect(scene.bounds.x).toBeLessThan(0);
    expect(scene.items[0]).toMatchObject({ kind: 'rect', role: 'bg' });
    expect(fit('abcdefghij', 35, 7)).toBe('abcd…');
    expect(fit('abc', 35, 7)).toBe('abc');
  });

  it('PNG export uses 2× unless the bitmap would exceed canvas limits', () => {
    expect(exportScale(2000, 1500)).toBe(2);
    expect(exportScale(20000, 3000) * 20000).toBeLessThanOrEqual(MAX_SIDE + 1);
  });

  it('reads the theme tokens with fallbacks', () => {
    const t = readSceneTheme(document.documentElement);
    expect(t.fontUi).toBeTruthy();
    expect(t.panel).toBeTruthy();
  });
});

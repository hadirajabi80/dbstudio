import { describe, expect, it } from 'vitest';
import { computeLayout, components, CLUSTER_THRESHOLD, type LayoutInput } from '../layout';
import { buildModel, geometryOf } from '../model';
import { gridBlock, placeNew, shelfPack, tileBlocks } from '../place';
import { syntheticSchemas } from '../synthetic';

function inputOf(tables: number, fks: number, mode: LayoutInput['mode'] = 'layered-lr', schemas = 1): LayoutInput {
  const s = syntheticSchemas({ tables, columns: 8, fks, schemas, seed: 7 });
  const model = buildModel({ schemas: s, defaultSchema: s[0].name, scope: schemas === 1 ? { database: null, schema: s[0].name } : { database: null, tables: s.flatMap((x) => x.objects.map((o) => `${x.name}.${o.n}`)) } });
  const geom = geometryOf(model, { columns: 'all', types: true });
  return {
    nodes: model.nodes.map((n) => ({ key: n.key, w: geom.get(n.key)!.w, h: geom.get(n.key)!.h, schema: n.schema })),
    edges: model.edges.map((e) => ({ from: e.from, to: e.to })),
    mode,
  };
}

function overlaps(input: LayoutInput, positions: Record<string, [number, number]>): number {
  let n = 0;
  const rects = input.nodes.map((x) => ({ ...x, x: positions[x.key][0], y: positions[x.key][1] }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
    }
  }
  return n;
}

describe('auto layout (dagre)', () => {
  it('is deterministic on 50 nodes and places every node without overlaps', () => {
    const input = inputOf(50, 60);
    const a = computeLayout(input);
    const b = computeLayout({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
    expect(Object.keys(a.positions)).toHaveLength(50);
    expect(a.positions).toEqual(b.positions);
    expect(overlaps(input, a.positions)).toBe(0);
  });

  it('ranks referenced tables before referencing ones (LR: parents on the left, TB: on top)', () => {
    const input: LayoutInput = {
      nodes: [{ key: 'm.orders', w: 200, h: 120, schema: 'm' }, { key: 'm.customers', w: 200, h: 120, schema: 'm' }, { key: 'm.lines', w: 200, h: 100, schema: 'm' }],
      edges: [{ from: 'm.orders', to: 'm.customers' }, { from: 'm.lines', to: 'm.orders' }],
      mode: 'layered-lr',
    };
    const lr = computeLayout(input).positions;
    expect(lr['m.customers'][0]).toBeLessThan(lr['m.orders'][0]);
    expect(lr['m.orders'][0]).toBeLessThan(lr['m.lines'][0]);
    // ranksep 80 between ranks
    expect(lr['m.orders'][0] - (lr['m.customers'][0] + 200)).toBeGreaterThanOrEqual(80);
    const tb = computeLayout({ ...input, mode: 'layered-tb' }).positions;
    expect(tb['m.customers'][1]).toBeLessThan(tb['m.orders'][1]);
  });

  it('grid layout keeps related tables together and never overlaps', () => {
    const input = inputOf(40, 30, 'grid');
    const r = computeLayout(input);
    expect(overlaps(input, r.positions)).toBe(0);
    expect(r.components).toBe(1);
  });

  it('keeps pinned cards where they are', () => {
    const input = inputOf(20, 20);
    const key = input.nodes[3].key;
    const r = computeLayout({ ...input, pinned: { [key]: [-500, -400] } });
    expect(r.positions[key]).toEqual([-500, -400]);
    expect(Object.keys(r.positions)).toHaveLength(20);
  });

  it('splits components and tiles them', () => {
    const comps = components(
      [{ key: 'a', w: 1, h: 1, schema: 's' }, { key: 'b', w: 1, h: 1, schema: 's' }, { key: 'c', w: 1, h: 1, schema: 's' }],
      [{ from: 'a', to: 'b' }, { from: 'c', to: 'c' }],
    );
    expect(comps.map((c) => c.map((n) => n.key))).toEqual([['a', 'b'], ['c']]);
  });

  it('500 tables × 20 columns × 700 FKs lays out in under 4 s (clustered per schema above 300)', () => {
    const s = syntheticSchemas({ tables: 500, columns: 20, fks: 700, seed: 11 });
    const model = buildModel({ schemas: s, defaultSchema: 'main', scope: { database: null, schema: 'main' } });
    expect(model.nodes).toHaveLength(500);
    expect(model.edges).toHaveLength(700);
    const geom = geometryOf(model, { columns: 'all', types: true });
    const input: LayoutInput = {
      nodes: model.nodes.map((n) => ({ key: n.key, w: geom.get(n.key)!.w, h: geom.get(n.key)!.h, schema: n.schema })),
      edges: model.edges.map((e) => ({ from: e.from, to: e.to })),
      mode: 'layered-lr',
    };
    const r = computeLayout(input);
    expect(Object.keys(r.positions)).toHaveLength(500);
    expect(r.ms).toBeLessThan(4000);
    expect(overlaps(input, r.positions)).toBe(0);
    expect(500).toBeGreaterThan(CLUSTER_THRESHOLD);
  }, 20_000);

  it('clusters a multi-schema catalog per schema', () => {
    const input = inputOf(360, 300, 'layered-lr', 3);
    const r = computeLayout(input);
    expect(r.clusters).toBe(3);
    expect(overlaps(input, r.positions)).toBe(0);
  }, 20_000);
});

describe('packing', () => {
  it('shelf packs into rows', () => {
    expect(shelfPack([{ w: 100, h: 10 }, { w: 100, h: 20 }, { w: 100, h: 5 }], 220, 10)).toEqual([[0, 0], [110, 0], [0, 30]]);
  });

  it('tiles blocks largest first', () => {
    const t = tileBlocks([{ w: 10, h: 10, positions: { a: [0, 0] } }, { w: 100, h: 100, positions: { b: [5, 5] } }], 20);
    expect(t.positions.b).toEqual([5, 5]);
    expect(t.positions.a[0]).toBeGreaterThanOrEqual(120);
  });

  it('grids boxes row-major', () => {
    const g = gridBlock([{ key: 'a', w: 100, h: 50 }, { key: 'b', w: 80, h: 70 }, { key: 'c', w: 120, h: 30 }], 10, 10, 2);
    expect(g.positions).toEqual({ a: [0, 0], b: [130, 0], c: [0, 80] });
  });

  it('places new cards below the existing ones', () => {
    const p = placeNew({ x: [100, 0] }, [{ key: 'n1', w: 50, h: 50 }], () => ({ w: 200, h: 300 }));
    expect(p.n1[0]).toBe(100);
    expect(p.n1[1]).toBeGreaterThan(300);
  });
});

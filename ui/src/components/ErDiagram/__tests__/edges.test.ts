import { describe, expect, it } from 'vitest';
import { cardRect, diagramBounds, edgeSides, rectsIntersect, routeEdge, routeEdges, routeOne } from '../edges';
import { buildModel, CARD, geometryOf, rowAnchorY } from '../model';
import { catalogObject, SHOP_TABLES } from '../../../mocks/fixtures';

const box = (x: number, y = 0, w = 200, h = 150) => ({ x, y, w, h });

describe('edge routing', () => {
  it('picks the facing sides, or the right side for stacked cards', () => {
    expect(edgeSides(box(0), box(400))).toEqual({ from: 'right', to: 'left' });
    expect(edgeSides(box(400), box(0))).toEqual({ from: 'left', to: 'right' });
    expect(edgeSides(box(0), box(50, 300))).toEqual({ from: 'right', to: 'right' });
  });

  it('starts at the FK row and ends at the referenced row with horizontal tangents', () => {
    const g = routeEdge('e', box(0), 60, box(400, 100), 160);
    expect(g.start).toEqual([200, 60]);
    expect(g.end).toEqual([400, 160]);
    expect(g.d.startsWith('M200 60C')).toBe(true);
    expect(g.d.endsWith(' 400 160')).toBe(true);
    // control points on the rows (horizontal tangents)
    const nums = g.d.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number);
    expect(nums[3]).toBe(60);
    expect(nums[5]).toBe(160);
    expect(g.mid[0]).toBeCloseTo(300, 0);
    expect(g.rings).toHaveLength(0); // mandatory: bars, no rings
    expect(rectsIntersect(g.bbox, { x: 299, y: 100, w: 2, h: 2 })).toBe(true);
  });

  it('draws rings for optional relationships and loops self references on the right', () => {
    const opt = routeEdge('e', box(0), 60, box(400), 60, { optional: true });
    expect(opt.rings).toHaveLength(2);
    const self = routeEdge('s', box(0), 60, box(0), 104, { self: true });
    expect(self.fromSide).toBe('right');
    expect(self.start).toEqual([200, 60]);
    expect(self.end).toEqual([200, 104]);
    expect(self.bbox.x).toBe(200);
    expect(self.bbox.w).toBeGreaterThan(40);
  });

  it('anchors at the right rows after a card moves', () => {
    const schema = { name: 'main', version: 1, objects: SHOP_TABLES.map((t) => catalogObject(t, 'main')) };
    const model = buildModel({ schemas: [schema], defaultSchema: 'main', scope: { database: null, schema: 'main' } });
    const geom = geometryOf(model, { columns: 'all', types: true });
    const positions: Record<string, [number, number]> = {};
    model.nodes.forEach((n, i) => (positions[n.key] = [i * 400, 0]));
    const e = model.edges.find((x) => x.from === 'main.orders' && x.to === 'main.customers')!;
    const before = routeOne(e, positions, geom)!;
    const ordersG = geom.get('main.orders')!;
    expect(before.start[1]).toBe(rowAnchorY(ordersG, 'customer_id'));
    expect(before.start[1]).toBe(CARD.headerH + CARD.padY + CARD.rowH * 1.5); // customer_id is row 2
    positions['main.orders'] = [1000, 333];
    const after = routeEdges(model, positions, geom).get(e.id)!;
    expect(after.start[1]).toBe(333 + rowAnchorY(ordersG, 'customer_id'));
    expect(after.end[1]).toBe(rowAnchorY(geom.get('main.customers')!, 'id'));
  });

  it('computes bounds of placed cards', () => {
    const geom = new Map([['a', { w: 100, h: 50, rows: [], more: 0, moreRow: false }], ['b', { w: 10, h: 10, rows: [], more: 0, moreRow: false }]]);
    expect(diagramBounds({ a: [10, 20], b: [200, -5] }, geom)).toEqual({ x: 10, y: -5, w: 200, h: 75 });
    expect(diagramBounds({}, geom)).toBeNull();
    expect(cardRect([1, 2], geom.get('a')!)).toEqual({ x: 1, y: 2, w: 100, h: 50 });
  });
});

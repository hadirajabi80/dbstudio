// 500-table performance check (docs/PLAN-M2.md section 3 acceptance): the per-frame work of scripted panning (culling
// of cards and edges) must fit a 60 fps frame with room to spare, the render set stays small at every level of detail,
// and the model / geometry / routing of 500 tables × 20 columns × 700 FKs is fast. Real frame rates are a manual QA item
// (docs/qa/er-walkthrough.md) since jsdom does not paint.
import { describe, expect, it } from 'vitest';
import { routeEdges } from '../edges';
import { computeLayout } from '../layout';
import { buildModel, geometryOf } from '../model';
import { syntheticSchemas } from '../synthetic';
import { contains, fitTransform, lodOf, visibleEdges, visibleNodes, worldViewport, type Transform } from '../viewport';
import { diagramBounds } from '../edges';

const now = () => performance.now();

describe('ER diagram, 500 tables × 20 columns × 700 FKs', () => {
  const t0 = now();
  const schemas = syntheticSchemas({ tables: 500, columns: 20, fks: 700, seed: 3 });
  const model = buildModel({ schemas, defaultSchema: 'main', scope: { database: null, schema: 'main' } });
  const geom = geometryOf(model, { columns: 'all', types: true });
  const buildMs = now() - t0;
  const layout = computeLayout({
    nodes: model.nodes.map((n) => ({ key: n.key, w: geom.get(n.key)!.w, h: geom.get(n.key)!.h, schema: n.schema })),
    edges: model.edges.map((e) => ({ from: e.from, to: e.to })),
    mode: 'layered-lr',
  });
  const positions = layout.positions;
  const keys = model.nodes.map((n) => n.key);

  it('builds the model and geometry quickly and lays out in under 4 s', () => {
    expect(model.memberCount).toBe(500);
    expect(model.edges).toHaveLength(700);
    expect(buildMs).toBeLessThan(500);
    expect(layout.ms).toBeLessThan(4000);
  });

  it('routes all 700 edges in well under a frame', () => {
    // Median of 10 timed runs after a warm-up (as the formatter perf tests do): a busy machine or a parallel test
    // worker stalls single runs, which an average would count against the router. Budget unchanged.
    routeEdges(model, positions, geom);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = now();
      routeEdges(model, positions, geom);
      times.push(now() - t);
    }
    expect(times.sort((a, b) => a - b)[5]).toBeLessThan(16);
  });

  it('culling during 2 s of scripted panning (120 frames) costs < 2 ms per frame and re-renders rarely', () => {
    const W = 1440;
    const H = 860;
    const edges = routeEdges(model, positions, geom);
    let tr: Transform = { x: 0, y: 0, k: 1 };
    let cullRect = worldViewport(tr, W, H, 0.5);
    let recomputes = 0;
    let maxCards = 0;
    let worst = 0;
    const start = now();
    for (let f = 0; f < 120; f++) {
      const t = now();
      tr = { ...tr, x: tr.x - 18, y: tr.y - 6 }; // ~1 000 px/s pan
      const vp = worldViewport(tr, W, H, 0);
      if (!contains(cullRect, vp)) {
        cullRect = worldViewport(tr, W, H, 0.5);
        recomputes++;
      }
      const cards = visibleNodes(keys, positions, geom, cullRect);
      visibleEdges(edges, cullRect);
      maxCards = Math.max(maxCards, cards.length);
      worst = Math.max(worst, now() - t);
    }
    const perFrame = (now() - start) / 120;
    expect(perFrame).toBeLessThan(2);
    expect(worst).toBeLessThan(16);
    // the padded region is reused for most frames: React re-renders the card set only a few times per second
    expect(recomputes).toBeLessThan(30);
    // at 100 % only a small part of the 500 cards is mounted
    expect(maxCards).toBeLessThan(120);
  });

  it('fit-to-window shows (nearly) every card at box LOD; the folded layout keeps a screen-like shape', () => {
    const fit = fitTransform(diagramBounds(positions, geom), 1440, 860);
    expect(lodOf(fit.k)).not.toBe('full');
    const all = visibleNodes(keys, positions, geom, worldViewport(fit, 1440, 860, 0.5));
    expect(all.length).toBeGreaterThan(450);
    const b = diagramBounds(positions, geom)!;
    expect(b.w / b.h).toBeGreaterThan(0.8);
    expect(b.w / b.h).toBeLessThan(3);
    expect(lodOf(0.3)).toBe('header');
    expect(lodOf(0.15)).toBe('box');
    expect(lodOf(1)).toBe('full');
  });
});

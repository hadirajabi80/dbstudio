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

// Timing on a shared machine: the app suite runs test files in parallel (and other jobs may share the CPU), so a
// single sample measures the machine as much as the code. As in the formatter perf tests, every check times the median
// of several runs after a warm-up, and CI (shared runners, 2-4x slower and noisy) fails only on a clear 4x regression.
// The local budgets are the PLAN-M2 figures, unchanged. Load only ever adds time, so a batch whose median is over
// budget is measured again (at most three batches, best median kept): a real regression fails every batch, a load
// spike from a parallel worker does not.
const onCi = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI;
const budget = (localMs: number) => (onCi ? localMs * 4 : localMs);

const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Median of `runs` calls of `sample` (each returns a duration in ms); re-measured while over `limit`, best of 3. */
function settledMedian(sample: () => number, limit: number, runs: number): number {
  let best = Infinity;
  for (let batch = 0; batch < 3 && best >= limit; batch++) best = Math.min(best, median(Array.from({ length: runs }, sample)));
  return best;
}

/** A sampler for `settledMedian`: the wall time of one call of `fn`. */
const timed = (fn: () => unknown) => () => {
  const t = now();
  fn();
  return now() - t;
};

describe('ER diagram, 500 tables × 20 columns × 700 FKs', () => {
  const schemas = syntheticSchemas({ tables: 500, columns: 20, fks: 700, seed: 3 });
  const build = () => {
    const m = buildModel({ schemas, defaultSchema: 'main', scope: { database: null, schema: 'main' } });
    return { model: m, geom: geometryOf(m, { columns: 'all', types: true }) };
  };
  const { model, geom } = build(); // also the warm-up of the build timing below
  const layoutInput = {
    nodes: model.nodes.map((n) => ({ key: n.key, w: geom.get(n.key)!.w, h: geom.get(n.key)!.h, schema: n.schema })),
    edges: model.edges.map((e) => ({ from: e.from, to: e.to })),
    mode: 'layered-lr' as const,
  };
  const layout = computeLayout(layoutInput); // the warm-up of the layout timing below
  const positions = layout.positions;
  const keys = model.nodes.map((n) => n.key);

  it('builds the model and geometry quickly and lays out in under 4 s', () => {
    expect(model.memberCount).toBe(500);
    expect(model.edges).toHaveLength(700);
    expect(settledMedian(timed(build), budget(500), 5)).toBeLessThan(budget(500));
    // timed by the layout itself (layout.ms, the figure the status bar reports)
    expect(settledMedian(() => computeLayout(layoutInput).ms, budget(4000), 3)).toBeLessThan(budget(4000));
  }, 60_000);

  it('routes all 700 edges in well under a frame', () => {
    routeEdges(model, positions, geom); // warm-up
    expect(settledMedian(timed(() => routeEdges(model, positions, geom)), budget(16), 10)).toBeLessThan(budget(16));
  });

  it('culling during 2 s of scripted panning (120 frames) costs < 2 ms per frame and re-renders rarely', () => {
    const W = 1440;
    const H = 860;
    const edges = routeEdges(model, positions, geom);
    /** One scripted 2 s pan from the origin: per-frame average and worst frame, plus the (deterministic) counts. */
    const pan = () => {
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
      return { perFrame: (now() - start) / 120, worst, recomputes, maxCards };
    };
    const first = pan(); // warm-up; its counts are what the pan does
    expect(settledMedian(() => pan().perFrame, budget(2), 5)).toBeLessThan(budget(2));
    // a single frame may be hit by a GC pause or a parallel worker; the median pan's worst frame may not
    expect(settledMedian(() => pan().worst, budget(16), 5)).toBeLessThan(budget(16));
    // the padded region is reused for most frames: React re-renders the card set only a few times per second
    expect(first.recomputes).toBeLessThan(30);
    // at 100 % only a small part of the 500 cards is mounted
    expect(first.maxCards).toBeLessThan(120);
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

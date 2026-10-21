// Viewport math of the diagram canvas: the transform (screen = world × k + (x, y)), zoom at a point, fit, level of
// detail and culling (docs/PLAN-M2.md D6: only cards and edges inside the padded viewport are rendered).
import type { CardGeom } from './model';
import type { EdgeGeom, Rect } from './edges';

export interface Transform { x: number; y: number; k: number }

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
/** Below this zoom cards draw their header only (no column text). */
export const LOD_HEADER = 0.45;
/** Below this zoom cards are coloured boxes (name on hover). */
export const LOD_BOX = 0.2;
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export type Lod = 'full' | 'header' | 'box';

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function lodOf(k: number): Lod {
  return k < LOD_BOX ? 'box' : k < LOD_HEADER ? 'header' : 'full';
}

/** New transform after zooming to `k` while the screen point (sx, sy) stays over the same world point. */
export function zoomAt(t: Transform, k: number, sx: number, sy: number): Transform {
  const nk = clampZoom(k);
  const wx = (sx - t.x) / t.k;
  const wy = (sy - t.y) / t.k;
  return { k: nk, x: sx - wx * nk, y: sy - wy * nk };
}

/** Next zoom step up/down from `k` (toolbar +/-, keyboard). */
export function stepZoom(k: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > k + 1e-3) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < k - 1e-3) ?? MIN_ZOOM;
}

/** Transform showing `bounds` centred in a viewport of w × h with `pad` px around (never zooms in past `maxK`). */
export function fitTransform(bounds: Rect | null, w: number, h: number, pad = 32, maxK = 1): Transform {
  if (!bounds || w <= 0 || h <= 0) return { x: pad, y: pad, k: 1 };
  const k = clampZoom(Math.min(maxK, (w - pad * 2) / Math.max(1, bounds.w), (h - pad * 2) / Math.max(1, bounds.h)));
  return { k, x: (w - bounds.w * k) / 2 - bounds.x * k, y: (h - bounds.h * k) / 2 - bounds.y * k };
}

/** Transform that centres the world point (wx, wy) at zoom k. */
export function centerOn(wx: number, wy: number, w: number, h: number, k: number): Transform {
  return { k, x: w / 2 - wx * k, y: h / 2 - wy * k };
}

/** The world rectangle visible in a w × h viewport, grown by `margin` × its size on every side. */
export function worldViewport(t: Transform, w: number, h: number, margin = 0): Rect {
  const ww = w / t.k;
  const wh = h / t.k;
  return { x: -t.x / t.k - ww * margin, y: -t.y / t.k - wh * margin, w: ww * (1 + 2 * margin), h: wh * (1 + 2 * margin) };
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Keys of the cards intersecting `view` (the culling pass; linear, ~0.02 ms for 500 cards). */
export function visibleNodes(
  keys: readonly string[],
  positions: Readonly<Record<string, readonly [number, number]>>,
  geom: ReadonlyMap<string, CardGeom>,
  view: Rect,
): string[] {
  const out: string[] = [];
  const x2 = view.x + view.w;
  const y2 = view.y + view.h;
  for (const k of keys) {
    const p = positions[k];
    const g = geom.get(k);
    if (!p || !g) continue;
    if (p[0] < x2 && p[0] + g.w > view.x && p[1] < y2 && p[1] + g.h > view.y) out.push(k);
  }
  return out;
}

/** Ids of the routed edges whose bounding box intersects `view`. */
export function visibleEdges(edges: ReadonlyMap<string, EdgeGeom>, view: Rect): string[] {
  const out: string[] = [];
  const x2 = view.x + view.w;
  const y2 = view.y + view.h;
  for (const [id, e] of edges) {
    const b = e.bbox;
    if (b.x < x2 && b.x + b.w > view.x && b.y < y2 && b.y + b.h > view.y) out.push(id);
  }
  return out;
}

// Edge routing (docs/PLAN-M2.md section 3): a cubic path from the FK column row of the referencing card to the
// referenced key row of the other card, plus crow's-foot cardinality glyphs (many side: crow's foot; one side: bar).
// Pure geometry in diagram coordinates, shared by the live SVG layer, the PNG painter and the SVG exporter.
import { CARD, rowAnchorY, type CardGeom, type DiagramModel, type ErEdge } from './model';

export interface Rect { x: number; y: number; w: number; h: number }
export type Side = 'left' | 'right';

export interface EdgeGeom {
  id: string;
  /** Main curve. */
  d: string;
  /** Glyph strokes (crow's foot, bars) as one path. */
  marks: string;
  /** Optional-cardinality rings. */
  rings: { cx: number; cy: number; r: number }[];
  /** Point on the curve at t = 0.5 (tooltips). */
  mid: [number, number];
  /** Contains the curve and its glyphs (culling). */
  bbox: Rect;
  start: [number, number];
  end: [number, number];
  fromSide: Side;
  toSide: Side;
}

/** Horizontal gap below which two cards count as stacked (both ends then leave on the right). */
const STACK_GAP = 28;
const GLYPH = 12;
const HALF = 6;

const f = (n: number) => (Math.round(n * 10) / 10).toString();

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Which sides an edge leaves `src` and enters `dst` from. */
export function edgeSides(src: Rect, dst: Rect): { from: Side; to: Side } {
  if (dst.x >= src.x + src.w + STACK_GAP) return { from: 'right', to: 'left' };
  if (dst.x + dst.w <= src.x - STACK_GAP) return { from: 'left', to: 'right' };
  return { from: 'right', to: 'right' };
}

/** Crow's foot (many) at an end point; `dir` points away from the card (+1 right side, -1 left side). */
function manyGlyph(x: number, y: number, dir: number, optional: boolean, rings: EdgeGeom['rings']): string {
  const tip = x + dir * GLYPH;
  let d = `M${f(tip)} ${f(y)}L${f(x)} ${f(y - HALF)}M${f(tip)} ${f(y)}L${f(x)} ${f(y + HALF)}M${f(tip)} ${f(y)}L${f(x)} ${f(y)}`;
  const bar = x + dir * (GLYPH + 4);
  if (optional) rings.push({ cx: x + dir * (GLYPH + 7.5), cy: y, r: 3.5 });
  else d += `M${f(bar)} ${f(y - HALF)}L${f(bar)} ${f(y + HALF)}`;
  return d;
}

/** One (bar) at an end point: two bars = exactly one; bar + ring = zero or one. */
function oneGlyph(x: number, y: number, dir: number, optional: boolean, rings: EdgeGeom['rings']): string {
  const b1 = x + dir * 7;
  let d = `M${f(b1)} ${f(y - HALF)}L${f(b1)} ${f(y + HALF)}`;
  if (optional) rings.push({ cx: x + dir * 15, cy: y, r: 3.5 });
  else {
    const b2 = x + dir * 12;
    d += `M${f(b2)} ${f(y - HALF)}L${f(b2)} ${f(y + HALF)}`;
  }
  return d;
}

/**
 * Route one relationship. `fromY` / `toY` are absolute diagram y of the anchoring rows. `optional` = nullable FK
 * columns (the zero-or-… ends). Self references loop out on the right side.
 */
export function routeEdge(id: string, src: Rect, fromY: number, dst: Rect, toY: number, opts: { self?: boolean; optional?: boolean } = {}): EdgeGeom {
  const optional = !!opts.optional;
  const rings: EdgeGeom['rings'] = [];
  if (opts.self) {
    const x = src.x + src.w;
    let y1 = fromY;
    let y2 = toY;
    if (Math.abs(y1 - y2) < 8) {
      y1 -= 8;
      y2 += 8;
    }
    const reach = 46 + Math.min(60, Math.abs(y2 - y1) * 0.25);
    const d = `M${f(x)} ${f(y1)}C${f(x + reach)} ${f(y1)} ${f(x + reach)} ${f(y2)} ${f(x)} ${f(y2)}`;
    const marks = manyGlyph(x, y1, 1, optional, rings) + oneGlyph(x, y2, 1, optional, rings);
    const top = Math.min(y1, y2) - HALF;
    return {
      id, d, marks, rings, mid: [x + reach * 0.75, (y1 + y2) / 2], bbox: { x, y: top, w: reach + 2, h: Math.abs(y2 - y1) + HALF * 2 },
      start: [x, y1], end: [x, y2], fromSide: 'right', toSide: 'right',
    };
  }
  const sides = edgeSides(src, dst);
  const sx = sides.from === 'right' ? src.x + src.w : src.x;
  const tx = sides.to === 'right' ? dst.x + dst.w : dst.x;
  const sd = sides.from === 'right' ? 1 : -1;
  const td = sides.to === 'right' ? 1 : -1;
  const dx = Math.abs(tx - sx);
  const dy = Math.abs(toY - fromY);
  const k = sides.from === sides.to ? Math.min(220, 48 + dy * 0.18 + dx * 0.5) : Math.min(180, Math.max(40, dx * 0.45));
  const c1x = sx + sd * k;
  const c2x = tx + td * k;
  // horizontal tangents at both ends: the glyphs sit on the straight first/last few pixels of the curve
  const d = `M${f(sx)} ${f(fromY)}C${f(c1x)} ${f(fromY)} ${f(c2x)} ${f(toY)} ${f(tx)} ${f(toY)}`;
  const marks = manyGlyph(sx, fromY, sd, optional, rings) + oneGlyph(tx, toY, td, optional, rings);
  const xs = [sx, c1x, c2x, tx, sx + sd * (GLYPH + 11), tx + td * 19];
  const ys = [fromY - HALF, fromY + HALF, toY - HALF, toY + HALF];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    id, d, marks, rings,
    mid: [cubicAt(sx, c1x, c2x, tx, 0.5), cubicAt(fromY, fromY, toY, toY, 0.5)],
    bbox: { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY },
    start: [sx, fromY], end: [tx, toY], fromSide: sides.from, toSide: sides.to,
  };
}

/** Rectangle of a card at its position. */
export function cardRect(pos: readonly [number, number], g: CardGeom): Rect {
  return { x: pos[0], y: pos[1], w: g.w, h: g.h };
}

/** Route every edge whose two cards have a position. */
export function routeEdges(
  model: Pick<DiagramModel, 'edges'>,
  positions: Readonly<Record<string, readonly [number, number]>>,
  geom: ReadonlyMap<string, CardGeom>,
): Map<string, EdgeGeom> {
  const out = new Map<string, EdgeGeom>();
  for (const e of model.edges) {
    const g = routeOne(e, positions, geom);
    if (g) out.set(e.id, g);
  }
  return out;
}

export function routeOne(e: ErEdge, positions: Readonly<Record<string, readonly [number, number]>>, geom: ReadonlyMap<string, CardGeom>): EdgeGeom | null {
  const pa = positions[e.from];
  const pb = positions[e.to];
  const ga = geom.get(e.from);
  const gb = geom.get(e.to);
  if (!pa || !pb || !ga || !gb) return null;
  const a = cardRect(pa, ga);
  const b = cardRect(pb, gb);
  const fromY = a.y + rowAnchorY(ga, e.cols[0]);
  // the referenced key row: the named column, else the first PK row, else the header
  const toCol = e.rcols[0] ?? gb.rows.find((r) => r.col.pk)?.col.name;
  const toY = b.y + rowAnchorY(gb, toCol);
  return routeEdge(e.id, a, fromY, b, toY, { self: e.self, optional: e.optional });
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Bounds of every positioned card (and its loop room), or null when nothing is placed. */
export function diagramBounds(positions: Readonly<Record<string, readonly [number, number]>>, geom: ReadonlyMap<string, CardGeom>, keys?: Iterable<string>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const k of keys ?? geom.keys()) {
    const p = positions[k];
    const g = geom.get(k);
    if (!p || !g) continue;
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0] + g.w);
    maxY = Math.max(maxY, p[1] + g.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export { CARD };

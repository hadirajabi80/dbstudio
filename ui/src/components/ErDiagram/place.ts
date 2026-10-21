// Packing helpers shared by the layout worker (tiling components and schema clusters, the Grid layout) and the view
// (placing tables that have no saved position yet). No dagre here, so the view chunk stays small.

export interface Box { key: string; w: number; h: number }
export interface Block { w: number; h: number; positions: Record<string, [number, number]> }

/**
 * Shelf packing: blocks left to right in rows no wider than `rowWidth` (a block wider than that gets its own row),
 * `gap` between them. Returns each block's top-left offset.
 */
export function shelfPack(sizes: readonly { w: number; h: number }[], rowWidth: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out.push([x, y]);
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return out;
}

/** Target row width for a set of blocks: roughly a 16:10 overall shape, never narrower than the widest block. */
export function rowWidthFor(sizes: readonly { w: number; h: number }[], gap: number): number {
  const area = sizes.reduce((a, s) => a + (s.w + gap) * (s.h + gap), 0);
  const widest = sizes.reduce((m, s) => Math.max(m, s.w), 0);
  return Math.max(widest, Math.sqrt(area * 1.6));
}

/** Tiles blocks into one block (largest first, so the big components sit top-left). */
export function tileBlocks(blocks: readonly Block[], gap: number): Block {
  const order = [...blocks].sort((a, b) => b.w * b.h - a.w * a.h);
  const offsets = shelfPack(order, rowWidthFor(order, gap), gap);
  const positions: Record<string, [number, number]> = {};
  let w = 0;
  let h = 0;
  order.forEach((b, i) => {
    const [ox, oy] = offsets[i];
    for (const [k, [x, y]] of Object.entries(b.positions)) positions[k] = [ox + x, oy + y];
    w = Math.max(w, ox + b.w);
    h = Math.max(h, oy + b.h);
  });
  return { w, h, positions };
}

/** Cards in a grid (row-major, `cols` per row, rows as tall as their tallest card). */
/** Columns that give a grid of these boxes roughly a 16:10 shape. */
export function gridColumns(boxes: readonly Box[], gapX = 48, gapY = 40): number {
  if (!boxes.length) return 1;
  const w = boxes.reduce((a, b) => a + b.w, 0) / boxes.length + gapX;
  const h = boxes.reduce((a, b) => a + b.h, 0) / boxes.length + gapY;
  return Math.max(1, Math.min(boxes.length, Math.round(Math.sqrt((1.6 * boxes.length * h) / w))));
}

export function gridBlock(boxes: readonly Box[], gapX = 48, gapY = 40, cols = gridColumns(boxes, gapX, gapY)): Block {
  const positions: Record<string, [number, number]> = {};
  const colW: number[] = [];
  boxes.forEach((b, i) => {
    const c = i % cols;
    colW[c] = Math.max(colW[c] ?? 0, b.w);
  });
  const colX: number[] = [];
  let acc = 0;
  for (let c = 0; c < colW.length; c++) {
    colX[c] = acc;
    acc += colW[c] + gapX;
  }
  let y = 0;
  let h = 0;
  for (let i = 0; i < boxes.length; i += cols) {
    const row = boxes.slice(i, i + cols);
    const rowH = row.reduce((m, b) => Math.max(m, b.h), 0);
    row.forEach((b, j) => {
      positions[b.key] = [colX[j], y];
    });
    h = y + rowH;
    y += rowH + gapY;
  }
  return { w: Math.max(0, acc - gapX), h, positions };
}

/**
 * Positions for cards that have none yet (a table added since the layout was saved): a grid below the existing
 * cards, left-aligned with them.
 */
export function placeNew(
  existing: Readonly<Record<string, readonly [number, number]>>,
  boxes: readonly Box[],
  sizeOf: (key: string) => { w: number; h: number } | undefined,
): Record<string, [number, number]> {
  if (!boxes.length) return {};
  let minX = Infinity;
  let maxY = -Infinity;
  for (const [k, p] of Object.entries(existing)) {
    const s = sizeOf(k);
    if (!s) continue;
    minX = Math.min(minX, p[0]);
    maxY = Math.max(maxY, p[1] + s.h);
  }
  const ox = Number.isFinite(minX) ? minX : 0;
  const oy = Number.isFinite(maxY) ? maxY + 96 : 0;
  const block = gridBlock(boxes, 48, 40, Math.max(1, Math.min(8, Math.ceil(Math.sqrt(boxes.length * 1.5)))));
  const out: Record<string, [number, number]> = {};
  for (const [k, [x, y]] of Object.entries(block.positions)) out[k] = [ox + x, oy + y];
  return out;
}

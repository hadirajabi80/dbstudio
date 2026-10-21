// Text cell drawing for the results/data grid: ellipsis instead of a mid-glyph clip (styles-15), and right-to-left
// values (Persian, Arabic, Hebrew, ...) drawn with the canvas in RTL mode, right-aligned within the cell padding, so
// the browser's bidi algorithm orders mixed Persian/Latin/number runs and the ellipsis lands on the left.
import { GridCellKind, drawTextCell, type GridCell, type Theme } from '@glideapps/glide-data-grid';
import { isRtlText } from '../../lib/bidi';
import { canvasMeasure, ellipsize } from './columnWidth';

export type CellAlign = 'left' | 'right' | 'center';

/**
 * Alignment of a text value: the column's alignment (numbers right, booleans centred), except that left-aligned
 * (text) columns put RTL values on the right.
 */
export function textAlignFor(columnAlign: CellAlign, text: string): CellAlign {
  return columnAlign === 'left' && isRtlText(text) ? 'right' : columnAlign;
}

/** Whether a cell is drawn right-to-left (a right-aligned text cell whose value is RTL by the first strong char). */
export function isRtlCell(cell: GridCell): boolean {
  return cell.kind === GridCellKind.Text && cell.contentAlign === 'right' && isRtlText(cell.displayData);
}

export interface TextDrawArgs {
  ctx: CanvasRenderingContext2D;
  rect: { x: number; y: number; width: number; height: number };
  theme: Theme;
  cell: GridCell;
}

/**
 * Draw a cell's content: glide's own renderer (`drawContent`) when the text fits, else the ellipsized text. RTL
 * values switch the canvas to `direction = 'rtl'` for the draw and back to `inherit` after: glide tracks the fill
 * colour and font between cells, so this must not save/restore around `drawContent`.
 * `cache` holds truncated strings per (font, width, text).
 */
export function drawCellText(a: TextDrawArgs, drawContent: () => void, cache: Map<string, string>): void {
  const { ctx, rect, cell } = a;
  if (cell.kind !== GridCellKind.Text) {
    drawContent();
    return;
  }
  const rtl = isRtlCell(cell);
  if (rtl) ctx.direction = 'rtl';
  try {
    if (cell.displayData.length <= 3) {
      drawContent();
      return;
    }
    const th = a.theme;
    const font = `${th.baseFontStyle} ${th.fontFamily}`;
    const avail = rect.width - th.cellHorizontalPadding * 2 - 1;
    if (canvasMeasure(cell.displayData, font) <= avail && !cell.displayData.includes('\n')) {
      drawContent();
      return;
    }
    const key = `${font}\u0001${Math.round(avail)}\u0001${cell.displayData}`;
    let shown = cache.get(key);
    if (shown === undefined) {
      shown = ellipsize(cell.displayData, avail, font);
      if (cache.size > 5000) cache.clear();
      cache.set(key, shown);
    }
    ctx.save();
    ctx.font = font;
    drawTextCell({ ctx, rect, theme: th } as Parameters<typeof drawTextCell>[0], shown, cell.contentAlign);
    ctx.restore();
  } finally {
    if (rtl) ctx.direction = 'inherit';
  }
}

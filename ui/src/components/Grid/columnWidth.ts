// Auto column widths (styles-15): measured with the grid's own font (canvas measureText) on a sample of rows plus
// the header; date/time columns always fit their full formatted value; spare horizontal space is handed to the
// columns that were truncated, up to a cap. Pure apart from the default canvas measurer.
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';

export type Measure = (text: string, font: string) => number;

const KIND_MIN: Partial<Record<ColumnKind, number>> = { bool: 64, int: 70, date: 100, time: 90, datetime: 170, datetimeoffset: 200, guid: 290 };
const FULL_WIDTH_KINDS = new Set<ColumnKind>(['date', 'time', 'datetime', 'datetimeoffset', 'guid']);

let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

/** Canvas text measurer (falls back to a monospace estimate where canvas is unavailable, e.g. jsdom). */
export const canvasMeasure: Measure = (text, font) => {
  if (ctx === undefined) {
    const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
    ctx = typeof document === 'undefined' || jsdom ? null : document.createElement('canvas').getContext('2d');
  }
  if (!ctx) return estimateMeasure(text, font);
  const key = `${font}\u0001${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  if (cache.size > 20_000) cache.clear();
  cache.set(key, w);
  return w;
};

/** ~0.55 em per character (monospace at the font's px size). */
export const estimateMeasure: Measure = (text, font) => {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 13);
  return text.length * px * 0.55;
};

export interface WidthOptions {
  measure?: Measure;
  /** Cell font, e.g. "13px Cascadia Code". */
  font: string;
  /** Header font, e.g. "600 12px Cascadia Code". */
  headerFont: string;
  /** Horizontal cell padding (each side). */
  padding?: number;
  /** Text columns never start wider than this. */
  maxText?: number;
  sampleRows?: number;
  /** Columns with an FK chevron need extra room. */
  extraRight?: (col: number) => number;
}

export interface ColumnWidth {
  /** Initial width. */
  width: number;
  /** Width that shows the widest sampled value completely. */
  desired: number;
}

/** Row indices to sample: the first rows plus an even spread over the rest. */
function sampleIndices(length: number, n: number): number[] {
  if (length <= n) return Array.from({ length }, (_, i) => i);
  const head = Math.floor(n / 2);
  const out = Array.from({ length: head }, (_, i) => i);
  const step = (length - head) / (n - head);
  for (let i = 0; i < n - head; i++) out.push(head + Math.floor(i * step));
  return out;
}

export function naturalWidths(
  columns: readonly ColumnInfo[],
  rows: { length: number; get(i: number): readonly CellValue[] | undefined },
  format: (v: CellValue, c: ColumnInfo, col: number) => string,
  o: WidthOptions,
): ColumnWidth[] {
  const measure = o.measure ?? canvasMeasure;
  const pad = (o.padding ?? 8) * 2 + 2;
  const maxText = o.maxText ?? 420;
  const idx = sampleIndices(rows.length, o.sampleRows ?? 200);
  return columns.map((c, col) => {
    // header: icon (16) + gap + title + room for a sort arrow / order number
    const header = measure(c.name || `column${col + 1}`, o.headerFont) + pad + 16 + 6 + 18;
    let widest = 0;
    for (const i of idx) {
      const v = rows.get(i)?.[col] ?? null;
      const t = format(v, c, col);
      if (!t) continue;
      // long text: measuring 2,000 characters is pointless beyond the cap
      const w = measure(t.length > 400 ? t.slice(0, 400) : t, o.font);
      if (w > widest) widest = w;
    }
    const extra = o.extraRight?.(col) ?? 0;
    const desired = Math.ceil(Math.max(header, widest + pad + extra));
    const min = KIND_MIN[c.kind] ?? 60;
    const width = FULL_WIDTH_KINDS.has(c.kind) ? Math.max(min, desired) : Math.max(min, Math.min(desired, maxText));
    return { width, desired: Math.max(width, desired) };
  });
}

/**
 * Give unused horizontal space to truncated columns (proportionally to what they miss), never beyond `cap`.
 * Columns that already fit keep their width, so a narrow result is not stretched across the screen.
 */
export function distributeSpare(cols: readonly ColumnWidth[], available: number, cap = 800): number[] {
  const widths = cols.map((c) => c.width);
  const used = widths.reduce((a, b) => a + b, 0);
  let spare = Math.floor(available - used);
  if (spare <= 0) return widths;
  const need = cols.map((c) => Math.max(0, Math.min(c.desired, cap) - c.width));
  const totalNeed = need.reduce((a, b) => a + b, 0);
  if (totalNeed === 0) return widths;
  const ratio = Math.min(1, spare / totalNeed);
  return widths.map((w, i) => {
    const add = Math.floor(need[i] * ratio);
    spare -= add;
    return w + add;
  });
}

/** Text that fits `maxWidth` with a trailing ellipsis (binary search on the measured width). */
export function ellipsize(text: string, maxWidth: number, font: string, measure: Measure = canvasMeasure): string {
  if (maxWidth <= 0) return '';
  const line = text.includes('\n') ? text.split(/\r?\n/, 1)[0] : text;
  if (measure(line, font) <= maxWidth && line === text) return text;
  const ell = '…';
  if (measure(ell, font) > maxWidth) return '';
  let lo = 0;
  let hi = Math.min(line.length, 2000);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(line.slice(0, mid) + ell, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return line.slice(0, lo).trimEnd() + ell;
}

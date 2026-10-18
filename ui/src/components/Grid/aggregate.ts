// Selection aggregates for the status row (prop-01): Count / Sum / Avg / Min / Max over the numeric cells of the
// selection and "distinct N" for text, like the SSMS status bar or the DataGrip / DBeaver calculators.
// Pure: no React, no stores. Decimal values are summed exactly (BigInt) so reconciliation totals do not drift.
import type { CellValue, ColumnKind } from '../../api/types';
import { isNumericKind, rawText } from '../../lib/format';

export interface SelectionAggregates {
  /** Selected cells (including NULLs). */
  cells: number;
  /** Non-NULL cells. */
  count: number;
  /** Numeric cells used for sum/avg/min/max. */
  numeric: number;
  /** Decimal text (exact when every value is a plain decimal), or null without numeric cells. */
  sum: string | null;
  avg: string | null;
  min: string | null;
  max: string | null;
  /** Distinct non-NULL values of the non-numeric cells; null when the selection is purely numeric. */
  distinct: number | null;
}

const DECIMAL = /^([-+]?)(\d+)(?:\.(\d+))?$/;

/** Plain decimal text of a value (no exponent), or null when it cannot be written exactly. */
function decimalText(v: number | string): string | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
  return DECIMAL.test(s) ? s : null;
}

const scaleOf = (text: string) => (DECIMAL.exec(text)?.[3] ?? '').length;

/** Exact sum of plain decimal strings. */
function exactSum(values: readonly string[]): string {
  const scale = values.reduce((m, v) => Math.max(m, scaleOf(v)), 0);
  let total = 0n;
  for (const v of values) {
    const m = DECIMAL.exec(v)!;
    const n = BigInt(`${m[2]}${(m[3] ?? '').padEnd(scale, '0')}`);
    total += m[1] === '-' ? -n : n;
  }
  const neg = total < 0n;
  const digits = (neg ? -total : total).toString().padStart(scale + 1, '0');
  const int = scale ? digits.slice(0, -scale) : digits;
  const frac = scale ? digits.slice(-scale) : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Fixed-point text with at most `digits` decimals, trailing zeros removed. */
function fixed(n: number, digits: number): string {
  const s = n.toFixed(Math.min(Math.max(digits, 0), 12));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Aggregate a selection; `cells` yields each selected cell with its column kind. */
export function aggregateCells(cells: Iterable<{ value: CellValue; kind: ColumnKind }>, maxDistinct = 100_000): SelectionAggregates {
  let total = 0;
  let count = 0;
  let numeric = 0;
  const decimals: string[] = [];
  let floatSum = 0;
  let exact = true;
  let maxScale = 0;
  let min: { n: number; text: string } | null = null;
  let max: { n: number; text: string } | null = null;
  const distinct = new Set<string>();
  let other = 0;
  for (const { value, kind } of cells) {
    total++;
    if (value === null || value === undefined) continue;
    count++;
    if (isNumericKind(kind) && (typeof value === 'number' || typeof value === 'string')) {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) {
        numeric++;
        floatSum += n;
        const text = decimalText(value);
        if (text) {
          decimals.push(text);
          maxScale = Math.max(maxScale, scaleOf(text));
        } else exact = false;
        const shown = text ?? String(n);
        if (!min || n < min.n) min = { n, text: shown };
        if (!max || n > max.n) max = { n, text: shown };
        continue;
      }
    }
    other++;
    if (distinct.size < maxDistinct) distinct.add(rawText(value) ?? '');
  }
  let sum: string | null = null;
  let avg: string | null = null;
  if (numeric > 0) {
    sum = exact ? exactSum(decimals) : fixed(floatSum, Math.max(maxScale, 6));
    avg = fixed((exact ? Number(sum) : floatSum) / numeric, maxScale + 2);
  }
  return {
    cells: total, count, numeric, sum, avg, min: min?.text ?? null, max: max?.text ?? null,
    distinct: numeric > 0 && other === 0 ? null : distinct.size,
  };
}

/** "4512.3" → "4,512.3" (display only; copying uses the raw text). */
export function groupDigits(text: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!m) return text;
  return `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] ?? ''}`;
}

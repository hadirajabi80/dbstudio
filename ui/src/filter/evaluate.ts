// Client-side evaluation: a filter tree compiles once per change into a `(row) => boolean` predicate.
// SQL NULL semantics: every comparison with NULL is false (also for negated operators); only isNull matches NULL.
import type { CellValue, ColumnInfo } from '../api/types';
import { isNumericKind, rawText } from '../lib/format';
import {
  kindClass, resolveColumn, type FilterCondition, type FilterGroup, type FilterNode, type GridViewModel, type SortKey,
} from './model';
import {
  addDays, cellBool, compareNumericCell, conditionProblem, filledValues, isDateOnly, normDateTime, parseDateOperand,
  parseNumber, parsePeriod, parseTimeOperand, periodBounds, type NumOperand,
} from './values';

export type Row = readonly CellValue[];
export type Pred = (row: Row) => boolean;

export interface RowSource {
  readonly length: number;
  get(i: number): Row | undefined;
}

export interface CompileOptions {
  /** Reference time for last/next (tests). */
  now?: Date;
}

/** "10:00:00.1230000" → "10:00:00.123", "10:00:00.0000000" → "10:00:00". */
function trimFraction(s: string): string {
  return s.replace(/(\.\d*?)0+(?=$|[+Z-])/, '$1').replace(/\.(?=$|[+Z-])/, '');
}

function textOf(v: CellValue): string | null {
  if (typeof v === 'string') return v;
  return rawText(v);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

/** Datetime text with a space separator normalized to ISO "T" (cells normally arrive as ISO already). */
function isoCell(v: string): string {
  return v.length > 10 && v.charCodeAt(10) === 32 ? normDateTime(v) : v;
}

interface Compiled {
  pred: Pred;
  /** Relative evaluation cost, so AND/OR groups test cheap conditions first (result is order-independent). */
  cost: number;
}

function compileCondition(c: FilterCondition, columns: readonly ColumnInfo[], opts: CompileOptions): Compiled | null {
  if (c.enabled === false) return null;
  const col = resolveColumn(columns, c.column, c.ordinal);
  if (col < 0) return null;
  const kind = columns[col].kind;
  if (conditionProblem(c, kind)) return null;
  const cls = kindClass(kind);
  const cs = !!c.caseSensitive;
  const fold = (s: string) => (cs ? s : s.toLowerCase());
  const v0 = c.values[0];
  const done = (pred: Pred, cost: number): Compiled => ({ pred, cost });

  switch (c.op) {
    case 'isNull': return done((r) => r[col] === null || r[col] === undefined, 1);
    case 'isNotNull': return done((r) => r[col] !== null && r[col] !== undefined, 1);
    case 'isEmpty': return done((r) => r[col] === '', 1);
    case 'isTrue': return done((r) => cellBool(r[col]) === true, 1);
    case 'isFalse': return done((r) => cellBool(r[col]) === false, 1);
    case 'contains': case 'notContains': case 'startsWith': case 'endsWith': {
      const raw = String(v0);
      const neg = c.op === 'notContains';
      let test: (t: string) => boolean;
      if (cs) {
        test = c.op === 'startsWith' ? (t) => t.startsWith(raw) : c.op === 'endsWith' ? (t) => t.endsWith(raw) : (t) => t.includes(raw);
      } else {
        // Case-insensitive through one compiled /i regex: no lower-cased copy of every cell.
        const esc = escapeRegExp(raw);
        const re = new RegExp(c.op === 'startsWith' ? `^${esc}` : c.op === 'endsWith' ? `${esc}$` : esc, 'i');
        test = (t) => re.test(t);
      }
      return done((r) => {
        const v = r[col];
        const t = typeof v === 'string' ? v : textOf(v);
        if (t === null) return false;
        return neg ? !test(t) : test(t);
      }, 4);
    }
    case 'regex': {
      const re = new RegExp(String(v0), cs ? '' : 'i');
      return done((r) => { const t = textOf(r[col]); return t !== null && re.test(t); }, 8);
    }
    case 'in': case 'notIn': {
      const neg = c.op === 'notIn';
      const vals = filledValues(c);
      if (cls === 'number') {
        const nums = vals.map(parseNumber).filter((x): x is NumOperand => x !== null);
        return done((r) => {
          const v = r[col];
          if (v === null || v === undefined) return false;
          const hit = nums.some((n) => compareNumericCell(v, n) === 0);
          return neg ? !hit : hit;
        }, 3);
      }
      const set = new Set(vals.map((v) => fold(String(v).trim())));
      return done((r) => {
        const t = textOf(r[col]);
        if (t === null) return false;
        const hit = set.has(fold(t));
        return neg ? !hit : hit;
      }, 3);
    }
    case 'last': case 'next': {
      const p = parsePeriod(c.values)!;
      const { from, to } = periodBounds(c.op, p.count, p.unit, opts.now);
      const last = c.op === 'last';
      return done((r) => {
        const v = r[col];
        if (typeof v !== 'string') return false;
        const t = isoCell(v);
        return last ? t >= from && t <= to : t >= from && t < to;
      }, 2);
    }
  }

  if (cls === 'date') return dateCondition(c, col);

  // Comparisons: eq neq lt lte gt gte between before after onDate
  const cmp = comparator(c, cls, col, fold);
  if (!cmp) return null;
  const cost = cls === 'number' || cls === 'bool' ? 3 : 2;
  switch (c.op) {
    case 'eq': case 'onDate': return done((r) => cmp(r, 0) === 0, cost);
    case 'neq': return done((r) => { const x = cmp(r, 0); return x !== null && x !== 0; }, cost);
    case 'lt': case 'before': return done((r) => { const x = cmp(r, 0); return x !== null && x < 0; }, cost);
    case 'lte': return done((r) => { const x = cmp(r, 0); return x !== null && x <= 0; }, cost);
    case 'gt': case 'after': return done((r) => { const x = cmp(r, 0); return x !== null && x > 0; }, cost);
    case 'gte': return done((r) => { const x = cmp(r, 0); return x !== null && x >= 0; }, cost);
    case 'between': return done((r) => { const a = cmp(r, 0); const b = cmp(r, 1); return a !== null && b !== null && a >= 0 && b <= 0; }, cost * 2);
  }
  return null;
}

/**
 * Date/datetime conditions as plain string range tests on ISO text (no per-row allocation). Date-only operands
 * compare on the date part: "after 2026-01-03" means from 2026-01-04 on; onDate ignores the time.
 */
function dateCondition(c: FilterCondition, col: number): Compiled | null {
  const ops = c.values.slice(0, c.op === 'between' ? 2 : 1).map(parseDateOperand);
  if (ops.some((d) => d === null)) return null;
  const a = ops[0]!;
  const b = ops[1] ?? null;
  const dayOnly = c.op === 'onDate' || ops.every((d) => isDateOnly(d!));
  // [lo, hi) bounds; null = open
  let lo: string | null = null;
  let hi: string | null = null;
  let loIncl = true;
  let hiIncl = false;
  let negate = false;
  const day = (s: string) => s.slice(0, 10);
  if (dayOnly) {
    switch (c.op) {
      case 'onDate': case 'eq': lo = day(a); hi = addDays(a, 1); break;
      case 'neq': lo = day(a); hi = addDays(a, 1); negate = true; break;
      case 'before': case 'lt': hi = day(a); break;
      case 'lte': hi = addDays(a, 1); break;
      case 'after': case 'gt': lo = addDays(a, 1); break;
      case 'gte': lo = day(a); break;
      case 'between': lo = day(a); hi = addDays(b!, 1); break;
      default: return null;
    }
  } else {
    switch (c.op) {
      case 'eq': lo = a; hi = a; hiIncl = true; break;
      case 'neq': lo = a; hi = a; hiIncl = true; negate = true; break;
      case 'before': case 'lt': hi = a; break;
      case 'lte': hi = a; hiIncl = true; break;
      case 'after': case 'gt': lo = a; loIncl = false; break;
      case 'gte': lo = a; break;
      case 'between': lo = a; hi = b; hiIncl = true; break;
      default: return null;
    }
  }
  const full = !dayOnly;
  const test = (raw: string): boolean => {
    const t = full ? trimFraction(isoCell(raw)) : isoCell(raw);
    if (lo !== null && (loIncl ? t < lo : t <= lo)) return false;
    if (hi !== null) {
      // full datetime equality/inclusive bounds compare on the operand's precision
      const tt = full && hiIncl ? t.slice(0, hi.length) : t;
      if (hiIncl ? tt > hi : tt >= hi) return false;
    }
    return true;
  };
  return {
    pred: (r) => {
      const v = r[col];
      if (typeof v !== 'string') return false;
      return negate ? !test(v) : test(v);
    },
    cost: 2,
  };
}

/** Returns cmp(row, operandIndex): sign of (cell - operand), or null when not comparable / NULL. */
function comparator(
  c: FilterCondition, cls: ReturnType<typeof kindClass>, col: number, fold: (s: string) => string,
): ((r: Row, i: number) => number | null) | null {
  const operands = c.values.slice(0, c.op === 'between' ? 2 : 1);
  if (cls === 'number' || cls === 'bool') {
    const nums = operands.map(parseNumber);
    if (nums.some((n) => n === null)) return null;
    return (r, i) => {
      const v = r[col];
      if (v === null || v === undefined) return null;
      return compareNumericCell(v, nums[i]!);
    };
  }
  if (cls === 'time') {
    const ts = operands.map(parseTimeOperand);
    if (ts.some((t) => t === null)) return null;
    return (r, i) => {
      const v = r[col];
      if (typeof v !== 'string') return null;
      const m = /(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/.exec(v);
      if (!m) return null;
      const a = trimFraction(m[1].length === 5 ? `${m[1]}:00` : m[1]);
      const b = ts[i]!;
      return a < b ? -1 : a > b ? 1 : 0;
    };
  }
  // string / other: text comparison (case-insensitive unless caseSensitive)
  const keys = operands.map((v) => fold(String(v)));
  return (r, i) => {
    const t = textOf(r[col]);
    if (t === null) return null;
    const a = fold(t);
    return a < keys[i] ? -1 : a > keys[i] ? 1 : 0;
  };
}

function compileNode(node: FilterNode, columns: readonly ColumnInfo[], opts: CompileOptions): Compiled | null {
  if (node.kind === 'condition') return compileCondition(node, columns, opts);
  const parts = node.items.map((i) => compileNode(i, columns, opts)).filter((p): p is Compiled => p !== null);
  if (parts.length === 0) return null;
  parts.sort((a, b) => a.cost - b.cost);
  const preds = parts.map((p) => p.pred);
  const cost = parts.reduce((s, p) => s + p.cost, 0);
  let base: Pred;
  if (preds.length === 1) base = preds[0];
  else if (preds.length === 2) {
    const [a, b] = preds;
    base = node.logic === 'and' ? (r) => a(r) && b(r) : (r) => a(r) || b(r);
  } else if (preds.length === 3) {
    const [a, b, c] = preds;
    base = node.logic === 'and' ? (r) => a(r) && b(r) && c(r) : (r) => a(r) || b(r) || c(r);
  } else if (node.logic === 'and') {
    base = (r) => {
      for (let i = 0; i < preds.length; i++) if (!preds[i](r)) return false;
      return true;
    };
  } else {
    base = (r) => {
      for (let i = 0; i < preds.length; i++) if (preds[i](r)) return true;
      return false;
    };
  }
  return { pred: node.negate ? (r) => !base(r) : base, cost };
}

export function compileFilter(node: FilterNode | null | undefined, columns: readonly ColumnInfo[], opts: CompileOptions = {}): Pred | null {
  if (!node) return null;
  return compileNode(node, columns, opts)?.pred ?? null;
}

/** Free-text search over every column's text. */
export function compileQuick(q: string | undefined): Pred | null {
  const needle = (q ?? '').trim();
  if (!needle) return null;
  const re = new RegExp(escapeRegExp(needle), 'i');
  return (row) => {
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      const t = typeof v === 'string' ? v : textOf(v);
      if (t !== null && re.test(t)) return true;
    }
    return false;
  };
}

export function combine(a: Pred | null, b: Pred | null): Pred | null {
  if (a && b) return (r) => a(r) && b(r);
  return a ?? b;
}

function numericOf(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

export function compareValues(a: CellValue, b: CellValue, numericCol: boolean): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? 1 : -1; // NULLs last
  if (numericCol || (typeof a === 'number' && typeof b === 'number')) {
    const x = numericOf(a);
    const y = numericOf(b);
    if (x !== null && y !== null) return x - y;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const sa = rawText(a) ?? '';
  const sb = rawText(b) ?? '';
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function sortIndex(idx: Uint32Array, rows: RowSource, columns: readonly ColumnInfo[], sort: readonly SortKey[]): Uint32Array {
  if (sort.length === 0) return idx;
  const keys = sort.map((k) => ({ ...k, num: isNumericKind(columns[k.column]?.kind ?? 'string'), sign: k.dir === 'asc' ? 1 : -1 }));
  const arr = Array.from(idx);
  arr.sort((x, y) => {
    const rx = rows.get(x)!;
    const ry = rows.get(y)!;
    for (const k of keys) {
      const c = compareValues(rx[k.column], ry[k.column], k.num);
      if (c !== 0) {
        const nx = rx[k.column] === null;
        const ny = ry[k.column] === null;
        return nx || ny ? c : c * k.sign; // NULLs last regardless of direction
      }
    }
    return x - y;
  });
  return Uint32Array.from(arr);
}

/**
 * Map of visible row → source row for the view, or null when the view is the identity
 * (no filter, no sort, nothing hidden) so the grid can index rows directly.
 */
export function computeView(
  rows: RowSource,
  columns: readonly ColumnInfo[],
  view: Pick<GridViewModel, 'quickFilter' | 'filter' | 'sort'>,
  opts: CompileOptions & { hidden?: (i: number) => boolean; extraPredicate?: Pred | null } = {},
): Uint32Array | null {
  const pred = combine(combine(compileFilter(view.filter, columns, opts), compileQuick(view.quickFilter)), opts.extraPredicate ?? null);
  const hidden = opts.hidden;
  if (!pred && view.sort.length === 0 && !hidden) return null;
  const n = rows.length;
  let idx = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (hidden && hidden(i)) continue;
    const r = rows.get(i);
    if (r && (!pred || pred(r))) idx[m++] = i;
  }
  if (m !== n) idx = idx.slice(0, m);
  return sortIndex(idx, rows, columns, view.sort);
}

/** Count of rows matching (no sort, no index allocation). */
export function countMatches(rows: RowSource, columns: readonly ColumnInfo[], node: FilterNode | null, opts: CompileOptions = {}): number {
  const pred = compileFilter(node, columns, opts);
  if (!pred) return rows.length;
  let m = 0;
  for (let i = 0; i < rows.length; i++) if (pred(rows.get(i)!)) m++;
  return m;
}

export type { FilterGroup };

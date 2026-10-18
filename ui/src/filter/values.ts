// Operand parsing shared by the client evaluator and the server predicate builder.
import type { ColumnInfo, ColumnKind } from '../api/types';
import { kindClass, resolveColumn, type FilterCondition, type FilterNode, type FilterValue, type PeriodUnit } from './model';
import { arityOf } from './operators';

/** Decimal strings with more significant digits than this are compared as strings, not via Number. */
const SAFE_DIGITS = 15;

export interface NumOperand {
  num: number;
  /** Normalized decimal text ("-12.5"), used when the cell is a long decimal string. */
  str: string;
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function parseNumber(v: FilterValue): NumOperand | null {
  if (typeof v === 'number') return Number.isFinite(v) ? { num: v, str: normalizeDecimal(String(v)) } : null;
  if (typeof v === 'boolean') return { num: v ? 1 : 0, str: v ? '1' : '0' };
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[\s_]/g, '');
  if (!s || !NUM_RE.test(s)) return null;
  return { num: Number(s), str: normalizeDecimal(s) };
}

/** "+0012.500" → "12.5", "-0.0" → "0". Exponent forms go through Number. */
export function normalizeDecimal(s: string): string {
  if (/e/i.test(s)) return String(Number(s));
  let neg = false;
  if (s[0] === '+' || s[0] === '-') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  let [int, frac = ''] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return neg && out !== '0' ? `-${out}` : out;
}

function significantDigits(s: string): number {
  return s.replace(/^[+-]/, '').replace('.', '').replace(/^0+/, '').length;
}

/** Compare two normalized decimal strings exactly. */
export function compareDecimalStrings(a: string, b: string): number {
  const na = a[0] === '-';
  const nb = b[0] === '-';
  if (na !== nb) return na ? -1 : 1;
  const sign = na ? -1 : 1;
  const [ia, fa = ''] = (na ? a.slice(1) : a).split('.');
  const [ib, fb = ''] = (nb ? b.slice(1) : b).split('.');
  if (ia.length !== ib.length) return (ia.length < ib.length ? -1 : 1) * sign;
  if (ia !== ib) return (ia < ib ? -1 : 1) * sign;
  const len = Math.max(fa.length, fb.length);
  const pa = fa.padEnd(len, '0');
  const pb = fb.padEnd(len, '0');
  return pa === pb ? 0 : (pa < pb ? -1 : 1) * sign;
}


const D0 = 48;
const D9 = 57;

/**
 * Compare decimal text `a` ([-]digits[.digits]) with a normalized operand `b` without allocating.
 * Returns undefined when `a` is not plain decimal text (exponent, spaces, …) so callers fall back.
 */
export function compareDecimalText(a: string, b: string): number | undefined {
  const n = a.length;
  if (n === 0) return undefined;
  let i = 0;
  let neg = false;
  const c0 = a.charCodeAt(0);
  if (c0 === 45 /* - */ || c0 === 43 /* + */) {
    neg = c0 === 45;
    i = 1;
  }
  while (i < n - 1 && a.charCodeAt(i) === D0 && a.charCodeAt(i + 1) !== 46) i++; // leading zeros
  const intStart = i;
  while (i < n) {
    const c = a.charCodeAt(i);
    if (c < D0 || c > D9) break;
    i++;
  }
  const intEnd = i;
  let fracStart = n;
  let fracEnd = n;
  if (i < n) {
    if (a.charCodeAt(i) !== 46 /* . */) return undefined;
    fracStart = i + 1;
    for (let k = fracStart; k < n; k++) {
      const c = a.charCodeAt(k);
      if (c < D0 || c > D9) return undefined;
    }
    while (fracEnd > fracStart && a.charCodeAt(fracEnd - 1) === D0) fracEnd--;
  }
  if (intEnd === intStart && fracStart >= n) return undefined;
  const intLen = intEnd - intStart;
  const isZero = (intLen === 0 || (intLen === 1 && a.charCodeAt(intStart) === D0)) && fracEnd <= fracStart;
  if (isZero) neg = false;
  if (b.includes("e")) return undefined;
  const bNeg = b.charCodeAt(0) === 45;
  const bStart = bNeg ? 1 : 0;
  const bDot = b.indexOf('.', bStart);
  const bIntEnd = bDot < 0 ? b.length : bDot;
  const bIntLen = bIntEnd - bStart;
  if (neg !== bNeg) return neg ? -1 : 1;
  const sign = neg ? -1 : 1;
  const aIntLen = intLen === 1 && a.charCodeAt(intStart) === D0 ? 1 : intLen;
  const bIntLenN = bIntLen;
  // integer parts ("0" operand has length 1; a's "0" too)
  const aLen = aIntLen === 0 ? 1 : aIntLen;
  if (aLen !== bIntLenN) return (aLen < bIntLenN ? -1 : 1) * sign;
  for (let k = 0; k < aLen; k++) {
    const ca = aIntLen === 0 ? D0 : a.charCodeAt(intStart + k);
    const cb = b.charCodeAt(bStart + k);
    if (ca !== cb) return (ca < cb ? -1 : 1) * sign;
  }
  const bFracStart = bDot < 0 ? b.length : bDot + 1;
  const fa = fracEnd - fracStart;
  const fb = b.length - bFracStart;
  const m = Math.max(fa, fb);
  for (let k = 0; k < m; k++) {
    const ca = k < fa ? a.charCodeAt(fracStart + k) : D0;
    const cb = k < fb ? b.charCodeAt(bFracStart + k) : D0;
    if (ca !== cb) return (ca < cb ? -1 : 1) * sign;
  }
  return 0;
}

/** Cell (number or decimal string) vs operand; null when the cell is not numeric. */
export function compareNumericCell(cell: unknown, t: NumOperand): number | null {
  if (typeof cell === 'number') return cell - t.num;
  if (typeof cell === 'string') {
    // Plain decimal text ("1250.00", "-5"): exact digit comparison, no float parsing (hot path on large results).
    const fast = compareDecimalText(cell, t.str);
    if (fast !== undefined) return fast;
    if (cell.length <= SAFE_DIGITS + 2 || significantDigits(cell) <= SAFE_DIGITS) {
      const n = Number(cell);
      return Number.isNaN(n) || cell.trim() === '' ? null : n - t.num;
    }
    if (!NUM_RE.test(cell)) return null;
    return compareDecimalStrings(normalizeDecimal(cell), t.str);
  }
  if (typeof cell === 'boolean') return (cell ? 1 : 0) - t.num;
  return null;
}

// ---------------------------------------------------------------- dates

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Wire ISO-ish date/time text → comparable form ("YYYY-MM-DDTHH:MM:SS…"). */
export function normDateTime(s: string): string {
  const t = s.trim();
  return t.length > 10 && t[10] === ' ' ? `${t.slice(0, 10)}T${t.slice(11)}` : t;
}

export function isDateOnly(s: string): boolean {
  return DATE_ONLY.test(s.trim());
}

/** Validates "YYYY-MM-DD" or "YYYY-MM-DD[ T]HH:MM[:SS[.fff]]". */
export function parseDateOperand(v: FilterValue): string | null {
  if (typeof v !== 'string') return null;
  const s = normDateTime(v);
  if (DATE_ONLY.test(s)) return validDate(s) ? s : null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(s);
  if (!m || !validDate(m[1])) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}${m[5] ?? ''}`;
}

function validDate(s: string): boolean {
  const [y, mo, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** "YYYY-MM-DD" + n days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local wall-clock ISO without zone, the format datetime cells arrive in. */
export function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Bounds of a relative period. last N days = from the start of the day N days ago up to now;
 * next N days = from now up to the end of the day N days ahead. Weeks = 7 days, months are calendar months.
 */
export function periodBounds(op: 'last' | 'next', count: number, unit: PeriodUnit, now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (sign: 1 | -1): Date => {
    const d = new Date(start);
    if (unit === 'months') d.setMonth(d.getMonth() + sign * count);
    else d.setDate(d.getDate() + sign * count * (unit === 'weeks' ? 7 : 1));
    return d;
  };
  if (op === 'last') return { from: localIso(shift(-1)), to: localIso(now) };
  const end = shift(1);
  end.setDate(end.getDate() + 1);
  return { from: localIso(now), to: localIso(end) };
}

export function parsePeriod(values: FilterValue[]): { count: number; unit: PeriodUnit } | null {
  const n = typeof values[0] === 'number' ? values[0] : Number(String(values[0] ?? '').trim());
  if (!Number.isInteger(n) || n <= 0 || n > 100000) return null;
  const u = values[1];
  const unit: PeriodUnit = u === 'weeks' || u === 'months' ? u : 'days';
  return { count: n, unit };
}

// ---------------------------------------------------------------- time

export function parseTimeOperand(v: FilterValue): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(v.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) return null;
  return `${pad(Number(m[1]))}:${m[2]}:${m[3] ?? '00'}${m[4] ?? ''}`;
}

// ---------------------------------------------------------------- bool

export function cellBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'y' || s === 'yes' || s === 't') return true;
    if (s === '0' || s === 'false' || s === 'n' || s === 'no' || s === 'f') return false;
  }
  return null;
}

// ---------------------------------------------------------------- validation

export function isBlank(v: FilterValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Operands that are present (not blank). */
export function filledValues(c: FilterCondition): FilterValue[] {
  return c.values.filter((v) => !isBlank(v));
}

/**
 * Why a condition cannot be evaluated yet (incomplete or invalid operands), or null when it is ready.
 * Incomplete conditions are ignored by the evaluator (half-typed values never blank the grid).
 */
export function conditionProblem(c: FilterCondition, kind: ColumnKind | undefined): string | null {
  const arity = arityOf(c.op);
  if (arity === 'none') return null;
  const cls = kindClass(kind);
  if (arity === 'period') return parsePeriod(c.values) ? null : 'Enter a positive number';
  let operands: FilterValue[];
  if (arity === 'two') {
    operands = c.values.slice(0, 2);
    if (operands.length < 2 || operands.some(isBlank)) return 'Enter both values';
  } else if (arity === 'list') {
    operands = filledValues(c);
    if (operands.length === 0) return 'Enter at least one value';
  } else {
    operands = c.values.slice(0, 1);
    if (operands.length === 0 || isBlank(operands[0])) return 'Enter a value';
  }
  if (c.op === 'regex') {
    try {
      new RegExp(String(operands[0]));
    } catch {
      return 'Invalid regular expression';
    }
    return null;
  }
  const textOps = c.op === 'contains' || c.op === 'notContains' || c.op === 'startsWith' || c.op === 'endsWith';
  if (textOps) return null;
  for (const v of operands) {
    if (cls === 'number' && !parseNumber(v)) return `“${String(v)}” is not a number`;
    if (cls === 'date' && !parseDateOperand(v)) return 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM';
    if (cls === 'time' && !parseTimeOperand(v)) return 'Use HH:MM or HH:MM:SS';
  }
  return null;
}

/** Split a typed list ("a, b, c") into operands; quotes allow commas inside a value. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|([^,]*))\s*(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') break;
    const v = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] ?? '').trim();
    if (v !== '') out.push(v);
    if (re.lastIndex >= text.length) break;
  }
  return out;
}

/**
 * Conditions that actually filter: enabled, on a column of the result, and complete (no `conditionProblem`).
 * Toolbar badges count these, so an empty "Id equals …" draft does not read as an active filter.
 */
export function countActiveConditions(n: FilterNode | null | undefined, columns: readonly ColumnInfo[]): number {
  if (!n) return 0;
  if (n.kind === 'group') return n.items.reduce((a, i) => a + countActiveConditions(i, columns), 0);
  if (n.enabled === false) return 0;
  const ci = resolveColumn(columns, n.column, n.ordinal);
  if (ci < 0) return 0;
  return conditionProblem(n, columns[ci].kind) ? 0 : 1;
}

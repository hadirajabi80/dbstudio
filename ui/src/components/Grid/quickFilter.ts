// "Filter" submenu of a cell (PLAN-M1.5 1.1.1 quick filter): operators offered by kind and by NULL-ness.
import type { CellValue, ColumnInfo } from '../../api/types';
import { rawText } from '../../lib/format';
import { kindClass, newCondition, type FilterCondition } from '../../filter/model';

export interface QuickFilterOption {
  id: string;
  label: string;
  make(): FilterCondition;
}

function shorten(s: string): string {
  return s.length > 30 ? `${s.slice(0, 30)}…` : s;
}

/** Operand for a cell value (dates as their ISO text, booleans/numbers as-is). */
export function operandOf(v: CellValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  return rawText(v);
}

export function quickFilterOptions(col: ColumnInfo, ordinal: number, value: CellValue): QuickFilterOption[] {
  const name = col.name || `column${ordinal + 1}`;
  const make = (op: FilterCondition['op'], values: (string | number | boolean | null)[] = []) => () => newCondition(name, op, values, ordinal);
  if (value === null || value === undefined) {
    return [
      { id: 'isNull', label: `${name} is NULL`, make: make('isNull') },
      { id: 'isNotNull', label: `${name} is not NULL`, make: make('isNotNull') },
    ];
  }
  const cls = kindClass(col.kind);
  const raw = operandOf(value);
  const shown = shorten(String(raw));
  const quoted = cls === 'string' ? `'${shown}'` : shown;
  const out: QuickFilterOption[] = [];
  if (cls === 'bool') {
    const truthy = value === true || value === 1 || value === '1' || value === 'true';
    out.push({ id: truthy ? 'isTrue' : 'isFalse', label: `${name} is ${truthy ? 'true' : 'false'}`, make: make(truthy ? 'isTrue' : 'isFalse') });
    out.push({ id: truthy ? 'isFalse' : 'isTrue', label: `${name} is ${truthy ? 'false' : 'true'}`, make: make(truthy ? 'isFalse' : 'isTrue') });
  } else if (cls === 'date') {
    const s = String(raw);
    const day = s.slice(0, 10);
    out.push({ id: 'onDate', label: `${name} on ${day}`, make: make('onDate', [day]) });
    out.push({ id: 'after', label: `${name} after ${shown}`, make: make('after', [s]) });
    out.push({ id: 'before', label: `${name} before ${shown}`, make: make('before', [s]) });
  } else if (cls === 'time') {
    out.push({ id: 'after', label: `${name} after ${shown}`, make: make('after', [String(raw)]) });
    out.push({ id: 'before', label: `${name} before ${shown}`, make: make('before', [String(raw)]) });
  } else if (cls === 'number' || cls === 'string') {
    out.push({ id: 'eq', label: `${name} = ${quoted}`, make: make('eq', [raw]) });
    out.push({ id: 'neq', label: `${name} ≠ ${quoted}`, make: make('neq', [raw]) });
    if (cls === 'number') {
      out.push({ id: 'gt', label: `${name} > ${shown}`, make: make('gt', [raw]) });
      out.push({ id: 'lt', label: `${name} < ${shown}`, make: make('lt', [raw]) });
    } else {
      out.push({ id: 'contains', label: `${name} contains ${quoted}`, make: make('contains', [raw]) });
    }
  }
  out.push({ id: 'isNotNull', label: `${name} is not NULL`, make: make('isNotNull') });
  return out;
}

/** Alt+click: "Filter by this cell" (eq, or the NULL test). */
export function cellEqualsCondition(col: ColumnInfo, ordinal: number, value: CellValue): FilterCondition {
  const opts = quickFilterOptions(col, ordinal, value);
  return opts[0].make();
}

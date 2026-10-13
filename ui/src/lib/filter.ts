import type { CellValue, ColumnInfo } from '../api/types';
import { isNumericKind, rawText } from './format';

/**
 * Result-grid filter model, kept as plain data so it can grow into a full filter builder (and later be
 * translated into a server-side WHERE): a tree of AND/OR groups of (column, operator, value) conditions.
 */
export type FilterOperator =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty' | 'in' | 'regex';

export interface FilterCondition {
  kind: 'condition';
  id: string;
  /** Column ordinal in the result set. */
  column: number;
  op: FilterOperator;
  /** Ignored by unary operators; `in` takes a comma-separated list. */
  value: string;
  caseSensitive?: boolean;
  enabled?: boolean;
}

export interface FilterGroup {
  kind: 'group';
  id: string;
  logic: 'and' | 'or';
  items: FilterNode[];
  negate?: boolean;
}

export type FilterNode = FilterCondition | FilterGroup;

export interface SortKey {
  column: number;
  dir: 'asc' | 'desc';
}

/** The full client-side view of a result set. */
export interface GridViewModel {
  quickFilter: string;
  filter: FilterGroup | null;
  sort: SortKey[];
}

export const EMPTY_VIEW: GridViewModel = { quickFilter: '', filter: null, sort: [] };

export const OPERATORS: { op: FilterOperator; label: string; unary?: boolean }[] = [
  { op: 'eq', label: '=' },
  { op: 'neq', label: '≠' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'contains', label: 'contains' },
  { op: 'notContains', label: 'does not contain' },
  { op: 'startsWith', label: 'starts with' },
  { op: 'endsWith', label: 'ends with' },
  { op: 'in', label: 'in list' },
  { op: 'regex', label: 'matches regex' },
  { op: 'isNull', label: 'is NULL', unary: true },
  { op: 'isNotNull', label: 'is not NULL', unary: true },
  { op: 'isEmpty', label: 'is empty', unary: true },
  { op: 'isNotEmpty', label: 'is not empty', unary: true },
];

let idSeq = 0;
export const filterId = () => `f${++idSeq}`;

export function newCondition(column: number, op: FilterOperator = 'contains', value = ''): FilterCondition {
  return { kind: 'condition', id: filterId(), column, op, value, enabled: true };
}

export function newGroup(logic: 'and' | 'or' = 'and', items: FilterNode[] = []): FilterGroup {
  return { kind: 'group', id: filterId(), logic, items };
}

export function countConditions(n: FilterNode | null): number {
  if (!n) return 0;
  if (n.kind === 'condition') return n.enabled === false ? 0 : 1;
  return n.items.reduce((a, i) => a + countConditions(i), 0);
}

type Pred = (row: CellValue[]) => boolean;

function numeric(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function compileCondition(c: FilterCondition, columns: ColumnInfo[]): Pred | null {
  if (c.enabled === false) return null;
  const col = c.column;
  const kind = columns[col]?.kind ?? 'string';
  const cs = !!c.caseSensitive;
  const norm = (s: string) => (cs ? s : s.toLowerCase());
  const needle = norm(c.value);
  const num = isNumericKind(kind) || kind === 'bool' ? numeric(c.value) : null;
  const text = (row: CellValue[]) => {
    const t = rawText(row[col]);
    return t === null ? null : norm(t);
  };
  const cmp = (row: CellValue[]): number | null => {
    const v = row[col];
    if (v === null || v === undefined) return null;
    if (num !== null) {
      const n = numeric(v);
      if (n !== null) return n - num;
    }
    const t = text(row);
    return t === null ? null : t < needle ? -1 : t > needle ? 1 : 0;
  };
  switch (c.op) {
    case 'isNull': return (r) => r[col] === null || r[col] === undefined;
    case 'isNotNull': return (r) => r[col] !== null && r[col] !== undefined;
    case 'isEmpty': return (r) => { const t = text(r); return t === null || t === ''; };
    case 'isNotEmpty': return (r) => { const t = text(r); return t !== null && t !== ''; };
    case 'eq': return (r) => cmp(r) === 0;
    case 'neq': return (r) => { const x = cmp(r); return x !== null && x !== 0; };
    case 'lt': return (r) => { const x = cmp(r); return x !== null && x < 0; };
    case 'lte': return (r) => { const x = cmp(r); return x !== null && x <= 0; };
    case 'gt': return (r) => { const x = cmp(r); return x !== null && x > 0; };
    case 'gte': return (r) => { const x = cmp(r); return x !== null && x >= 0; };
    case 'contains': return (r) => text(r)?.includes(needle) ?? false;
    case 'notContains': return (r) => !(text(r)?.includes(needle) ?? false);
    case 'startsWith': return (r) => text(r)?.startsWith(needle) ?? false;
    case 'endsWith': return (r) => text(r)?.endsWith(needle) ?? false;
    case 'in': {
      const set = new Set(c.value.split(',').map((s) => norm(s.trim())));
      return (r) => { const t = text(r); return t !== null && set.has(t); };
    }
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(c.value, cs ? '' : 'i');
      } catch {
        return null;
      }
      return (r) => { const t = rawText(r[col]); return t !== null && re.test(t); };
    }
  }
}

export function compileFilter(node: FilterNode | null, columns: ColumnInfo[]): Pred | null {
  if (!node) return null;
  if (node.kind === 'condition') return compileCondition(node, columns);
  const preds = node.items.map((i) => compileFilter(i, columns)).filter((p): p is Pred => p !== null);
  if (preds.length === 0) return null;
  const base: Pred = node.logic === 'and' ? (r) => preds.every((p) => p(r)) : (r) => preds.some((p) => p(r));
  return node.negate ? (r) => !base(r) : base;
}

function compileQuick(q: string): Pred | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  return (row) => {
    for (const v of row) {
      const t = rawText(v);
      if (t !== null && t.toLowerCase().includes(needle)) return true;
    }
    return false;
  };
}

function compareValues(a: CellValue, b: CellValue, numericCol: boolean): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? 1 : -1; // NULLs last
  if (numericCol || (typeof a === 'number' && typeof b === 'number')) {
    const x = numeric(a);
    const y = numeric(b);
    if (x !== null && y !== null) return x - y;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const sa = rawText(a) ?? '';
  const sb = rawText(b) ?? '';
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Map of visible row → source row for the given view, or null when the view is the identity
 * (no filter, no sort) so the grid can index rows directly.
 */
export function computeView(
  rows: { length: number; get(i: number): CellValue[] | undefined },
  columns: ColumnInfo[],
  view: GridViewModel,
): Uint32Array | null {
  const pred = combine(compileQuick(view.quickFilter), compileFilter(view.filter, columns));
  if (!pred && view.sort.length === 0) return null;
  const n = rows.length;
  let idx = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const r = rows.get(i)!;
    if (!pred || pred(r)) idx[m++] = i;
  }
  if (m !== n) idx = idx.slice(0, m);
  if (view.sort.length) {
    const keys = view.sort.map((k) => ({ ...k, num: isNumericKind(columns[k.column]?.kind ?? 'string'), sign: k.dir === 'asc' ? 1 : -1 }));
    const arr = Array.from(idx);
    arr.sort((x, y) => {
      const rx = rows.get(x)!;
      const ry = rows.get(y)!;
      for (const k of keys) {
        const c = compareValues(rx[k.column], ry[k.column], k.num);
        if (c !== 0) {
          // keep NULLs last regardless of direction
          const nx = rx[k.column] === null;
          const ny = ry[k.column] === null;
          return nx || ny ? c : c * k.sign;
        }
      }
      return x - y;
    });
    idx = Uint32Array.from(arr);
  }
  return idx;
}

function combine(a: Pred | null, b: Pred | null): Pred | null {
  if (a && b) return (r) => a(r) && b(r);
  return a ?? b;
}

/** Remove a node by id anywhere in the tree (returns a new tree). */
export function removeNode(g: FilterGroup, id: string): FilterGroup {
  return { ...g, items: g.items.filter((i) => i.id !== id).map((i) => (i.kind === 'group' ? removeNode(i, id) : i)) };
}

/** Replace a node by id anywhere in the tree. */
export function updateNode(g: FilterGroup, id: string, fn: (n: FilterNode) => FilterNode): FilterGroup {
  if (g.id === id) return fn(g) as FilterGroup;
  return { ...g, items: g.items.map((i) => (i.id === id ? fn(i) : i.kind === 'group' ? updateNode(i, id, fn) : i)) };
}

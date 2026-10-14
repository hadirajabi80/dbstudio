// Filter model (PLAN-M1.5 1.1.1). Pure data + pure helpers; no React, Monaco or DOM.
// Extends the M1 model (lib/filter.ts): the same AND/OR tree of conditions, now addressed by column *name*
// (so a saved filter applies to any result with the same column signature) with typed multi-value operands.
import type { ColumnInfo, ColumnKind } from '../api/types';

export type FilterOp =
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'in' | 'notIn' | 'isNull' | 'isNotNull' | 'isTrue' | 'isFalse' | 'isEmpty' | 'regex'
  | 'before' | 'after' | 'onDate' | 'last' | 'next';

/** M1 name of the operator union, kept for older imports. */
export type FilterOperator = FilterOp;

export type FilterValue = string | number | boolean | null;

export type PeriodUnit = 'days' | 'weeks' | 'months';

export interface FilterCondition {
  kind: 'condition';
  id: string;
  /** Column name in the result set. */
  column: string;
  /** Ordinal hint, used to disambiguate duplicate names within one result (not persisted meaningfully). */
  ordinal?: number;
  op: FilterOp;
  /**
   * Operands: one for comparisons, two for `between`, N for `in`/`notIn`, none for unary operators,
   * `[count, unit]` for `last`/`next`.
   */
  values: FilterValue[];
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

/** Wire/saved form (PLAN-M1.5 1.1.1). `quick` = free text across all columns. */
export interface FilterModel {
  root: FilterGroup;
  quick?: string;
}

export interface SortKey {
  column: number;
  dir: 'asc' | 'desc';
}

/** Client-side view of one grid: quick search, filter tree and sort. */
export interface GridViewModel {
  quickFilter: string;
  filter: FilterGroup | null;
  sort: SortKey[];
}

export const EMPTY_VIEW: GridViewModel = { quickFilter: '', filter: null, sort: [] };

let idSeq = 0;
export const filterId = () => `f${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newCondition(column: string, op: FilterOp = 'contains', values: FilterValue[] = [], ordinal?: number): FilterCondition {
  return { kind: 'condition', id: filterId(), column, ...(ordinal !== undefined ? { ordinal } : {}), op, values, enabled: true };
}

export function newGroup(logic: 'and' | 'or' = 'and', items: FilterNode[] = []): FilterGroup {
  return { kind: 'group', id: filterId(), logic, items };
}

export function isGroup(n: FilterNode): n is FilterGroup {
  return n.kind === 'group';
}

/** Number of enabled conditions in the tree. */
export function countConditions(n: FilterNode | null | undefined): number {
  if (!n) return 0;
  if (n.kind === 'condition') return n.enabled === false ? 0 : 1;
  return n.items.reduce((a, i) => a + countConditions(i), 0);
}

export function walkConditions(n: FilterNode | null | undefined, fn: (c: FilterCondition) => void): void {
  if (!n) return;
  if (n.kind === 'condition') fn(n);
  else for (const i of n.items) walkConditions(i, fn);
}

/** Remove a node by id anywhere in the tree (returns a new tree; empty sub-groups are dropped). */
export function removeNode(g: FilterGroup, id: string): FilterGroup {
  return {
    ...g,
    items: g.items
      .filter((i) => i.id !== id)
      .map((i) => (i.kind === 'group' ? removeNode(i, id) : i))
      .filter((i) => i.kind === 'condition' || i.items.length > 0),
  };
}

/** Replace a node by id anywhere in the tree. */
export function updateNode(g: FilterGroup, id: string, fn: (n: FilterNode) => FilterNode): FilterGroup {
  if (g.id === id) return fn(g) as FilterGroup;
  return { ...g, items: g.items.map((i) => (i.id === id ? fn(i) : i.kind === 'group' ? updateNode(i, id, fn) : i)) };
}

/** Append a condition to the root with AND semantics (wrapping an OR root in a new AND root). */
export function appendAnd(root: FilterGroup | null, c: FilterNode): FilterGroup {
  if (!root || root.items.length === 0) return newGroup('and', [c]);
  if (root.logic === 'and' && !root.negate) return { ...root, items: [...root.items, c] };
  return newGroup('and', [root, c]);
}

/** Resolve a condition's column against a result's columns (ordinal hint first, then exact, then case-insensitive). */
export function resolveColumn(columns: readonly ColumnInfo[], name: string, ordinal?: number): number {
  if (ordinal !== undefined && (columns[ordinal]?.name === name || (name === '' && ordinal < columns.length))) return ordinal;
  let i = columns.findIndex((c) => c.name === name);
  if (i >= 0) return i;
  const low = name.toLowerCase();
  i = columns.findIndex((c) => c.name.toLowerCase() === low);
  return i;
}

/**
 * Column signature for saved filters: sorted `name:kind` list joined with `|`
 * (so `SELECT *` on the same table matches whatever the column order is).
 */
export function columnSignature(columns: readonly Pick<ColumnInfo, 'name' | 'kind'>[]): string {
  return columns.map((c) => `${c.name}:${c.kind}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('|');
}

const KNOWN_OPS = new Set<string>([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'isNull',
  'isNotNull', 'isTrue', 'isFalse', 'isEmpty', 'regex', 'before', 'after', 'onDate', 'last', 'next',
]);

/** Accept models written by other clients (no `kind` discriminator, `value` instead of `values`, M1 ordinals). */
export function normalizeNode(raw: unknown, columns?: readonly ColumnInfo[]): FilterNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.items)) {
    const items = (r.items as unknown[]).map((i) => normalizeNode(i, columns)).filter((x): x is FilterNode => x !== null);
    return {
      kind: 'group', id: typeof r.id === 'string' ? r.id : filterId(), logic: r.logic === 'or' ? 'or' : 'and', items,
      ...(r.negate ? { negate: true } : {}),
    };
  }
  if (typeof r.op !== 'string' || !KNOWN_OPS.has(r.op)) return null;
  let column = r.column;
  let ordinal: number | undefined = typeof r.ordinal === 'number' ? r.ordinal : undefined;
  if (typeof column === 'number') {
    ordinal = column;
    column = columns?.[column]?.name ?? `column${column + 1}`;
  }
  if (typeof column !== 'string') return null;
  let values: FilterValue[];
  if (Array.isArray(r.values)) values = r.values as FilterValue[];
  else if (typeof r.value === 'string') values = r.op === 'in' || r.op === 'notIn' ? r.value.split(',').map((s) => s.trim()).filter(Boolean) : r.value === '' ? [] : [r.value];
  else values = [];
  return {
    kind: 'condition', id: typeof r.id === 'string' ? r.id : filterId(), column, ...(ordinal !== undefined ? { ordinal } : {}),
    op: r.op as FilterOp, values, ...(r.caseSensitive ? { caseSensitive: true } : {}), enabled: r.enabled !== false,
  };
}

export function normalizeModel(raw: unknown, columns?: readonly ColumnInfo[]): FilterModel {
  const r = (raw ?? {}) as { root?: unknown; quick?: unknown };
  const root = normalizeNode(r.root ?? raw, columns);
  return {
    root: root && root.kind === 'group' ? root : newGroup('and', root ? [root] : []),
    ...(typeof r.quick === 'string' && r.quick ? { quick: r.quick } : {}),
  };
}

/** Grid view → wire model (fresh ids are not needed: ids are opaque). */
export function toFilterModel(view: Pick<GridViewModel, 'filter' | 'quickFilter'>): FilterModel {
  return { root: view.filter ?? newGroup('and'), ...(view.quickFilter ? { quick: view.quickFilter } : {}) };
}

/** Deep copy with fresh ids (applying a saved filter must not share ids with another grid). */
export function cloneWithNewIds<T extends FilterNode>(n: T): T {
  if (n.kind === 'condition') return { ...n, id: filterId(), values: [...n.values] };
  return { ...n, id: filterId(), items: n.items.map((i) => cloneWithNewIds(i)) } as T;
}

/** Strip ordinals (saved filters address columns by name only). */
export function stripOrdinals<T extends FilterNode>(n: T): T {
  if (n.kind === 'condition') {
    const { ordinal: _o, ...rest } = n;
    void _o;
    return rest as T;
  }
  return { ...n, items: n.items.map((i) => stripOrdinals(i)) } as T;
}

export type KindClass = 'number' | 'string' | 'date' | 'time' | 'bool' | 'other';

export function kindClass(kind: ColumnKind | undefined): KindClass {
  switch (kind) {
    case 'int': case 'float': case 'decimal': return 'number';
    case 'string': case 'json': case 'xml': case 'guid': return 'string';
    case 'date': case 'datetime': case 'datetimeoffset': return 'date';
    case 'time': return 'time';
    case 'bool': return 'bool';
    default: return 'other';
  }
}

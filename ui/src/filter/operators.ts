// Operator catalogue: labels, operand arity and the type-aware lists per column kind (PLAN-M1.5 1.1.1).
import type { ColumnKind } from '../api/types';
import { kindClass, type FilterOp, type KindClass } from './model';

/** none = unary; one/two operands; list = N values; period = [count, unit]. */
export type Arity = 'none' | 'one' | 'two' | 'list' | 'period';

export interface OperatorInfo {
  op: FilterOp;
  label: string;
  /** Compact form used in chips and menus ("Total > 100"). */
  symbol: string;
  arity: Arity;
  /** Can be pushed to the server as SQL. */
  server: boolean;
}

export const OPERATOR_INFO: Record<FilterOp, OperatorInfo> = {
  eq: { op: 'eq', label: 'equals', symbol: '=', arity: 'one', server: true },
  neq: { op: 'neq', label: 'not equal', symbol: '≠', arity: 'one', server: true },
  lt: { op: 'lt', label: 'less than', symbol: '<', arity: 'one', server: true },
  lte: { op: 'lte', label: 'at most', symbol: '≤', arity: 'one', server: true },
  gt: { op: 'gt', label: 'greater than', symbol: '>', arity: 'one', server: true },
  gte: { op: 'gte', label: 'at least', symbol: '≥', arity: 'one', server: true },
  between: { op: 'between', label: 'between', symbol: 'between', arity: 'two', server: true },
  contains: { op: 'contains', label: 'contains', symbol: 'contains', arity: 'one', server: true },
  notContains: { op: 'notContains', label: 'does not contain', symbol: 'not contains', arity: 'one', server: true },
  startsWith: { op: 'startsWith', label: 'starts with', symbol: 'starts with', arity: 'one', server: true },
  endsWith: { op: 'endsWith', label: 'ends with', symbol: 'ends with', arity: 'one', server: true },
  in: { op: 'in', label: 'is one of', symbol: 'in', arity: 'list', server: true },
  notIn: { op: 'notIn', label: 'is none of', symbol: 'not in', arity: 'list', server: true },
  isNull: { op: 'isNull', label: 'is NULL', symbol: 'is NULL', arity: 'none', server: true },
  isNotNull: { op: 'isNotNull', label: 'is not NULL', symbol: 'is not NULL', arity: 'none', server: true },
  isTrue: { op: 'isTrue', label: 'is true', symbol: 'is true', arity: 'none', server: true },
  isFalse: { op: 'isFalse', label: 'is false', symbol: 'is false', arity: 'none', server: true },
  isEmpty: { op: 'isEmpty', label: 'is empty', symbol: "= ''", arity: 'none', server: true },
  regex: { op: 'regex', label: 'matches regex', symbol: '~', arity: 'one', server: false },
  before: { op: 'before', label: 'before', symbol: 'before', arity: 'one', server: true },
  after: { op: 'after', label: 'after', symbol: 'after', arity: 'one', server: true },
  onDate: { op: 'onDate', label: 'on date', symbol: 'on', arity: 'one', server: true },
  last: { op: 'last', label: 'in the last', symbol: 'in last', arity: 'period', server: true },
  next: { op: 'next', label: 'in the next', symbol: 'in next', arity: 'period', server: true },
};

/** Type-aware operator lists, in menu order (first = default for a new condition). */
export const OPS_BY_CLASS: Record<KindClass, FilterOp[]> = {
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'notIn', 'isNull', 'isNotNull'],
  string: ['contains', 'notContains', 'startsWith', 'endsWith', 'eq', 'neq', 'in', 'notIn', 'isEmpty', 'isNull', 'isNotNull', 'regex'],
  date: ['onDate', 'before', 'after', 'between', 'last', 'next', 'isNull', 'isNotNull'],
  time: ['before', 'after', 'between', 'isNull', 'isNotNull'],
  bool: ['isTrue', 'isFalse', 'isNull', 'isNotNull'],
  other: ['isNull', 'isNotNull'],
};

export function operatorsFor(kind: ColumnKind | undefined): FilterOp[] {
  return OPS_BY_CLASS[kindClass(kind)];
}

export function defaultOperator(kind: ColumnKind | undefined): FilterOp {
  return operatorsFor(kind)[0];
}

export function arityOf(op: FilterOp): Arity {
  return OPERATOR_INFO[op]?.arity ?? 'one';
}

export const PERIOD_UNITS = ['days', 'weeks', 'months'] as const;

// M1 entry point of the grid filter model. The model now lives in `ui/src/filter/` (PLAN-M1.5 1.1.1) and was
// extended there (columns by name, typed multi-value operands, type-aware operators, server push-down);
// this module re-exports it and keeps the M1 helper signatures working.
import {
  newCondition as newConditionByName, type FilterCondition, type FilterOp, type FilterValue,
} from '../filter/model';
import { OPERATOR_INFO } from '../filter/operators';
import { splitList } from '../filter/values';

export {
  EMPTY_VIEW, countConditions, filterId, newGroup, removeNode, updateNode,
  type FilterCondition, type FilterGroup, type FilterModel, type FilterNode, type FilterOp, type FilterOperator,
  type FilterValue, type GridViewModel, type SortKey,
} from '../filter/model';
export { compileFilter, computeView } from '../filter/evaluate';

export const OPERATORS: { op: FilterOp; label: string; unary?: boolean }[] = Object.values(OPERATOR_INFO).map((o) => ({
  op: o.op, label: o.label, ...(o.arity === 'none' ? { unary: true } : {}),
}));

/**
 * M1 signature: `column` may be an ordinal (resolved positionally) or a column name; `value` may be the M1
 * single string (`in` takes a comma-separated list) or an operand array.
 */
export function newCondition(column: number | string, op: FilterOp = 'contains', value: string | FilterValue[] = ''): FilterCondition {
  const values: FilterValue[] = Array.isArray(value)
    ? value
    : op === 'in' || op === 'notIn' ? splitList(value) : value === '' ? [] : [value];
  return typeof column === 'number' ? newConditionByName('', op, values, column) : newConditionByName(column, op, values);
}

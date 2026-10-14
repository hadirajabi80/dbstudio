import type { FilterModel, FilterNode } from '../../filter/model';
import { OPERATOR_INFO, arityOf } from '../../filter/operators';

function val(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.length > 24 ? `${v.slice(0, 24)}…` : v}'`;
  return String(v);
}

/** One-line human description: `Name contains 'acme' AND (Total > 100 OR Paid is true)`. */
export function describeNode(n: FilterNode, top = true): string {
  if (n.kind === 'condition') {
    const info = OPERATOR_INFO[n.op];
    const a = arityOf(n.op);
    const col = n.column || `#${(n.ordinal ?? 0) + 1}`;
    if (a === 'none') return `${col} ${info.symbol}`;
    if (a === 'two') return `${col} between ${val(n.values[0])} and ${val(n.values[1])}`;
    if (a === 'list') return `${col} ${info.symbol} (${n.values.map(val).join(', ')})`;
    if (a === 'period') return `${col} ${info.symbol} ${n.values[0]} ${n.values[1] ?? 'days'}`;
    return `${col} ${info.symbol} ${val(n.values[0])}`;
  }
  const parts = n.items.filter((i) => i.kind === 'group' || i.enabled !== false).map((i) => describeNode(i, false));
  const s = parts.join(n.logic === 'and' ? ' AND ' : ' OR ');
  const wrapped = !top && parts.length > 1 ? `(${s})` : s;
  return n.negate ? `NOT (${s})` : wrapped;
}

export function describeModel(m: FilterModel): string {
  const parts = [m.root.items.length ? describeNode(m.root) : '', m.quick ? `“${m.quick}”` : ''].filter(Boolean);
  const s = parts.join(' + ');
  return s.length > 90 ? `${s.slice(0, 90)}…` : s || '(empty)';
}

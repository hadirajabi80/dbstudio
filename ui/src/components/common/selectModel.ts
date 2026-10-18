// Options model of the styled Select (Select.tsx, user-04): option shape, filtering and keyboard stepping. Kept apart
// from the component so the component module only exports components (fast refresh).
import type { ReactNode } from 'react';

export type SelectValue = string | number;

export interface SelectOption<V extends SelectValue = string> {
  value: V;
  label: string;
  /** Short secondary text shown right-aligned in the list (a category, a size). */
  hint?: string;
  /** Tooltip of the option (longer descriptions). */
  title?: string;
  disabled?: boolean;
  /** Options with the same group are listed under a group heading (consecutive options form one group). */
  group?: string;
  icon?: ReactNode;
}

/** From this many options a list gets a filter box (searchable: 'auto'). */
export const SEARCH_THRESHOLD = 12;

/** Labels first matching `q` at the start, then anywhere (case-insensitive); all when q is empty. */
export function filterOptions<V extends SelectValue>(options: readonly SelectOption<V>[], q: string): SelectOption<V>[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...options];
  const starts: SelectOption<V>[] = [];
  const contains: SelectOption<V>[] = [];
  for (const o of options) {
    const l = o.label.toLowerCase();
    if (l.startsWith(s)) starts.push(o);
    else if (l.includes(s) || (o.hint ?? '').toLowerCase().includes(s) || String(o.value).toLowerCase().includes(s)) contains.push(o);
  }
  return [...starts, ...contains];
}

/** Next enabled index from `from` in direction `dir` (clamped, no wrap); -1 when there is none. */
export function step<V extends SelectValue>(list: readonly SelectOption<V>[], from: number, dir: 1 | -1, count = 1): number {
  let i = from;
  let last = from >= 0 && from < list.length && !list[from].disabled ? from : -1;
  for (let moved = 0; moved < count; ) {
    i += dir;
    if (i < 0 || i >= list.length) break;
    if (!list[i].disabled) {
      last = i;
      moved++;
    }
  }
  return last;
}

export const firstEnabled = <V extends SelectValue>(list: readonly SelectOption<V>[]) => list.findIndex((o) => !o.disabled);
export const lastEnabled = <V extends SelectValue>(list: readonly SelectOption<V>[]) => {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].disabled) return i;
  return -1;
};

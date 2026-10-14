// Row source the grid shows: base rows with earlier submits folded in (refetched rows, appended inserts).
import type { CellValue } from '../../api/types';
import type { RowSource } from '../../filter/evaluate';
import type { Committed } from '../../store/edits';

export interface OverlayRows extends RowSource {
  readonly baseLength: number;
  get(i: number): CellValue[] | undefined;
}

export function overlayRows(base: { length: number; get(i: number): CellValue[] | undefined }, committed: Committed): OverlayRows {
  const patched = committed.patched;
  const appended = committed.appended;
  const hasPatches = Object.keys(patched).length > 0;
  if (!hasPatches && appended.length === 0) {
    return { baseLength: base.length, length: base.length, get: (i) => base.get(i) };
  }
  const n = base.length;
  return {
    baseLength: n,
    length: n + appended.length,
    get: (i) => (i < n ? (hasPatches ? patched[i] ?? base.get(i) : base.get(i)) : appended[i - n]),
  };
}

export function hiddenPredicate(committed: Committed): ((i: number) => boolean) | undefined {
  const h = committed.hidden;
  return Object.keys(h).length ? (i) => h[i] === true : undefined;
}

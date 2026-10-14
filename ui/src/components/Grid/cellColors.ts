// Canvas colours for edited / inserted / deleted cells and FK markers, resolved from the CSS tokens
// (PLAN-M1.5 section 3) so the grid follows the theme without literal colours.
import type { EffectiveTheme } from '../../theme/useTheme';

export interface CellColors {
  edited: string;
  editedBar: string;
  inserted: string;
  deleted: string;
  deletedText: string;
  link: string;
  error: string;
}

/** Resolve a token chain like `var(--cell-edited, var(--warning-soft))` to a canvas-usable colour string. */
function resolve(expr: string): string {
  if (typeof document === 'undefined') return 'transparent';
  const el = document.createElement('span');
  el.style.display = 'none';
  el.style.color = expr;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c || 'transparent';
}

const cache = new Map<string, CellColors>();

export function cellColors(theme: EffectiveTheme): CellColors {
  const hit = cache.get(theme);
  if (hit && hit.edited !== 'transparent') return hit;
  const c: CellColors = {
    edited: resolve('var(--cell-edited, var(--warning-soft))'),
    editedBar: resolve('var(--warning)'),
    inserted: resolve('var(--cell-inserted, var(--success-soft))'),
    deleted: resolve('var(--cell-deleted, var(--danger-soft))'),
    deletedText: resolve('var(--danger)'),
    link: resolve('var(--accent)'),
    error: resolve('var(--danger)'),
  };
  cache.set(theme, c);
  return c;
}

/** Theme switch: tokens changed, drop cached colours. */
export function resetCellColors(): void {
  cache.clear();
}

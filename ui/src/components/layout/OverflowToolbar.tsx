// A toolbar that never scrolls or wraps (styles-03): when its items do not fit, the lowest-priority ones collapse
// into a trailing "…" menu. Widths are measured while items are visible and cached, a ResizeObserver re-runs the
// fit, and the result only changes when the set of hidden items changes (no layout loops).
import { Ellipsis } from 'lucide-react';
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { showMenuBelow, type MenuItem } from '../common/Menu';

export interface OverflowItem {
  id: string;
  /** Lower collapses first; undefined = never collapses (Run, the connection pill). */
  priority?: number;
  /** The inline control(s). */
  node?: ReactNode;
  /** Entries of the "…" menu while collapsed (none: the item simply disappears). */
  menu?: () => MenuItem[];
  /** A visual separator (hidden automatically when it would separate nothing). */
  separator?: boolean;
  /** Flexible space (pushes the following items to the end). */
  spacer?: boolean;
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  items: OverflowItem[];
  ariaLabel: string;
  /** Label of the overflow button. */
  moreLabel?: string;
}

const MORE_W = 30;
const SEP_W = 9;

/** Ids to hide so that the items fit `avail` px (pure; exported for tests). */
export function fitItems(items: readonly OverflowItem[], widths: ReadonlyMap<string, number>, avail: number, gap: number): Set<string> {
  const content = items.filter((i) => !i.spacer && !i.separator);
  const width = (i: OverflowItem) => (widths.get(i.id) ?? 0) + gap;
  const seps = items.filter((i) => i.separator).length * (SEP_W + gap);
  let total = content.reduce((n, i) => n + width(i), 0) + seps;
  const hidden = new Set<string>();
  if (total <= avail) return hidden;
  total += MORE_W + gap;
  const collapsible = content
    .map((i, idx) => ({ i, idx }))
    .filter(({ i }) => i.priority !== undefined)
    // Lowest priority first; among equals the rightmost first.
    .sort((a, b) => a.i.priority! - b.i.priority! || b.idx - a.idx);
  for (const { i } of collapsible) {
    if (total <= avail) break;
    hidden.add(i.id);
    total -= width(i);
  }
  return hidden;
}

/** Separators that would separate nothing (at an edge, next to another separator or a spacer) are hidden. */
function visibleSeparators(items: readonly OverflowItem[], hidden: ReadonlySet<string>): Set<string> {
  const shown = items.filter((i) => !hidden.has(i.id));
  const out = new Set<string>();
  shown.forEach((it, k) => {
    if (!it.separator) return;
    const prev = shown[k - 1];
    const next = shown[k + 1];
    if (prev && next && !prev.separator && !prev.spacer && !next.separator && !next.spacer) out.add(it.id);
  });
  return out;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function OverflowToolbar({ items, ariaLabel, moreLabel = 'More actions', className, ...rest }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const fit = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    for (const el of row.querySelectorAll<HTMLElement>(':scope > [data-ovf]')) widths.current.set(el.dataset.ovf!, el.offsetWidth);
    const cs = getComputedStyle(row);
    const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
    const avail = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (avail <= 0) return; // hidden tab: keep the last fit
    const next = fitItems(items, widths.current, avail, gap);
    if (!sameSet(next, hiddenRef.current)) setHidden(next);
  }, [items]);

  // Every render: contents (a connection name, the timer) can change widths.
  useLayoutEffect(() => {
    fit();
  });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(row);
    return () => ro.disconnect();
  }, [fit]);

  const seps = visibleSeparators(items, hidden);
  const collapsed = items.filter((i) => hidden.has(i.id) && i.menu);

  const openMore = (el: HTMLElement) => {
    const out: MenuItem[] = [];
    for (const i of collapsed) {
      const entries = i.menu!();
      if (!entries.length) continue;
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      out.push(...entries);
    }
    if (out.length) showMenuBelow(el, out);
  };

  return (
    <div ref={rowRef} className={`toolbar overflow-toolbar${className ? ` ${className}` : ''}`} role="toolbar" aria-label={ariaLabel} {...rest}>
      {items.map((i) => {
        if (i.spacer) return <div key={i.id} className="flex-1" />;
        if (i.separator) return seps.has(i.id) ? <div key={i.id} className="tb-sep" /> : <Fragment key={i.id} />;
        if (hidden.has(i.id)) return <Fragment key={i.id} />;
        return (
          <span key={i.id} className="ovf-item" data-ovf={i.id}>
            {i.node}
          </span>
        );
      })}
      {collapsed.length > 0 && (
        <button type="button" className="icon-btn ovf-more" aria-haspopup="menu" aria-label={moreLabel} title={moreLabel} onClick={(e) => openMore(e.currentTarget)}>
          <Ellipsis size={16} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

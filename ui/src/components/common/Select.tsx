// Styled replacement for the native <select> (user-04): a trigger that looks like the other inputs and a popover
// listbox that looks like the app menus, so dropdowns match the design system in both themes instead of showing the
// dated OS list.
//
// Accessibility follows the WAI-ARIA "select-only combobox" pattern: the trigger is a <button role="combobox"> (so
// <label htmlFor> and wrapping labels name it, and `disabled` works natively) that keeps focus while the listbox is
// open and points at the active option with aria-activedescendant. Long lists (`searchable`) get a filter box at the
// top of the popover; focus moves into it and it takes over aria-activedescendant.
//
// Keys (closed): ArrowDown / ArrowUp / Enter / Space / Alt+ArrowDown open; Home / End open on the first / last option;
// typing a character opens and jumps to the first option starting with the typed prefix.
// Keys (open): ArrowUp / ArrowDown / PageUp / PageDown / Home / End move; Enter (Space without a filter box) picks;
// Alt+ArrowUp and Tab pick and close; Esc closes without changing anything; type-ahead jumps.
//
// The popover is portaled to <body> with position: fixed, flips above the trigger when there is no room below, stays
// inside the viewport horizontally, and accounts for the browser build's CSS zoom on <html> (app/zoom.ts).
import { Check, ChevronDown, Search } from 'lucide-react';
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode, type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { filterOptions, firstEnabled, lastEnabled, SEARCH_THRESHOLD, step, type SelectOption, type SelectValue } from './selectModel';
import './select.css';

export type { SelectOption, SelectValue } from './selectModel';

export interface SelectProps<V extends SelectValue = string> {
  value: V | null | undefined;
  options: readonly SelectOption<V>[];
  // NoInfer: V comes from `value` / `options`, so a state setter (string) can be passed directly
  onChange(value: NoInfer<V>): void;
  id?: string;
  /** Accessible name when no <label> names the trigger. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  disabled?: boolean;
  /** 28 px (default) or the dense 24 px of filter bars and designer cards. */
  size?: 'md' | 'sm' | 'xs';
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** Shown (muted) when the value matches no option. */
  placeholder?: string;
  /** Filter box at the top of the list: true, false, or 'auto' (default: on from 12 options). */
  searchable?: boolean | 'auto';
  /** Monospace labels (identifiers, types). */
  mono?: boolean;
  /** Minimum popover width in px (default: the trigger width). */
  menuMinWidth?: number;
  /** Ref to the trigger button (focus it like an input). */
  triggerRef?: Ref<HTMLButtonElement>;
  /** Decorative icon before the value inside the trigger (e.g. the hint shown when an outside label collapses). */
  leadingIcon?: ReactNode;
}

const PAGE = 10;
const GAP = 4;
const EDGE = 6;
const MAX_HEIGHT = 320;

/** CSS zoom applied to <html> by the browser build (Electron zooms natively and leaves it empty). */
function cssZoom(): number {
  if (typeof document === 'undefined') return 1;
  const z = parseFloat((document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom ?? '');
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export function Select<V extends SelectValue = string>(props: SelectProps<V>) {
  const {
    value, options, onChange, id, disabled, size = 'md', className, style, title, placeholder, searchable = 'auto', mono, menuMinWidth, triggerRef: outerRef, leadingIcon,
  } = props;
  const autoId = useId();
  const listId = `${id ?? autoId}-listbox`;
  const optId = (i: number) => `${listId}-opt-${i}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [listName, setListName] = useState<string | undefined>(undefined);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; maxHeight: number; above: boolean } | null>(null);
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  const withSearch = searchable === 'auto' ? options.length >= SEARCH_THRESHOLD : searchable;
  const shown = useMemo(() => (withSearch ? filterOptions(options, query) : [...options]), [options, query, withSearch]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openList = useCallback((at?: 'first' | 'last' | number) => {
    if (disabled) return;
    setQuery('');
    const sel = options.findIndex((o) => o.value === value && !o.disabled);
    const start = at === 'first' ? firstEnabled(options) : at === 'last' ? lastEnabled(options) : typeof at === 'number' ? at : sel >= 0 ? sel : firstEnabled(options);
    setActive(start);
    // The list is named like the field: aria-label, or the text of the <label> that names the trigger.
    const t = triggerRef.current;
    setListName(props['aria-label'] ?? t?.labels?.[0]?.textContent?.trim() ?? (t?.getAttribute('title') || undefined));
    setOpen(true);
  }, [disabled, options, value, props]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    setQuery('');
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const pick = useCallback((o: SelectOption<V> | undefined, refocus = true) => {
    if (!o || o.disabled) return;
    close(refocus);
    if (o.value !== value) onChange(o.value);
  }, [close, onChange, value]);

  // ------------------------------------------------------------ positioning
  const place = useCallback(() => {
    const t = triggerRef.current;
    const p = popRef.current;
    if (!t) return;
    const z = cssZoom();
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth / z;
    const vh = window.innerHeight / z;
    const rect = { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z };
    const minWidth = Math.max(rect.width, menuMinWidth ?? 0);
    const natural = p ? p.scrollHeight : MAX_HEIGHT;
    const below = vh - rect.bottom - GAP - EDGE;
    const aboveSpace = rect.top - GAP - EDGE;
    const wanted = Math.min(MAX_HEIGHT, natural);
    const above = below < wanted && aboveSpace > below;
    const maxHeight = Math.max(80, Math.min(MAX_HEIGHT, above ? aboveSpace : below));
    const height = Math.min(wanted, maxHeight);
    const width = Math.max(minWidth, p ? p.offsetWidth : minWidth);
    let left = rect.left;
    if (left + width > vw - EDGE) left = Math.max(EDGE, vw - EDGE - width);
    const top = above ? rect.top - GAP - height : rect.bottom + GAP;
    setPos((cur) => (cur && cur.left === left && cur.top === top && cur.minWidth === minWidth && cur.maxHeight === maxHeight && cur.above === above
      ? cur : { left, top, minWidth, maxHeight, above }));
  }, [menuMinWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // a second pass once the popover has its real size (width of long labels, filtered height)
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, place, shown.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      place();
    };
    const onBlur = () => close(false);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close, place]);

  useEffect(() => {
    if (open && withSearch) searchRef.current?.focus({ preventScroll: true });
  }, [open, withSearch]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // A disabled select never stays open.
  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled, open, close]);

  // ------------------------------------------------------------ keyboard
  const typeAhead = (ch: string, list: readonly SelectOption<V>[], from: number): number => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at < 700 ? t.text + ch.toLowerCase() : ch.toLowerCase();
    t.at = now;
    const same = t.text.split('').every((c) => c === t.text[0]);
    const prefix = same ? t.text[0] : t.text;
    const n = list.length;
    for (let k = same || from < 0 ? 1 : 0; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (!list[i]?.disabled && list[i]?.label.toLowerCase().startsWith(prefix)) return i;
    }
    return -1;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const inSearch = e.currentTarget === searchRef.current;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        openList(e.key === 'Home' ? 'first' : 'last');
      } else if (printable && e.key.trim() !== '') {
        e.preventDefault();
        if (withSearch) {
          openList();
          setQuery(e.key);
          setActive(firstEnabled(filterOptions(options, e.key)));
        } else {
          const i = typeAhead(e.key, options, selectedIndex);
          openList(i >= 0 ? i : undefined);
        }
      }
      return;
    }
    const list = shown;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a < 0 ? firstEnabled(list) : step(list, a, 1)));
        return;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) pick(list[active]);
        else setActive((a) => (a < 0 ? lastEnabled(list) : step(list, a, -1)));
        return;
      case 'PageDown':
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => step(list, a < 0 ? -1 : a, 1, PAGE));
        return;
      case 'PageUp':
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => step(list, a < 0 ? list.length : a, -1, PAGE));
        return;
      case 'Home':
      case 'End':
        // in the filter box Home / End move the text caret
        if (inSearch) return;
        e.preventDefault();
        e.stopPropagation();
        setActive(e.key === 'Home' ? firstEnabled(list) : lastEnabled(list));
        return;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (active >= 0) pick(list[active]);
        else close(true);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab':
        // APG: Tab picks the active option; from the filter box focus first returns to the trigger
        if (active >= 0) pick(list[active], inSearch);
        else close(inSearch);
        if (inSearch) e.preventDefault();
        return;
      case ' ':
        if (inSearch) return;
        e.preventDefault();
        e.stopPropagation();
        if (active >= 0) pick(list[active]);
        return;
      default:
        if (!inSearch && printable && e.key.trim() !== '') {
          e.preventDefault();
          const i = typeAhead(e.key, list, active);
          if (i >= 0) setActive(i);
        }
    }
  };

  // ------------------------------------------------------------ render
  const activeId = open && active >= 0 && active < shown.length ? optId(active) : undefined;
  const sizeCls = size === 'md' ? '' : ` ${size}`;
  const label = selected?.label ?? placeholder ?? '';

  const groups: { name: string | undefined; items: { o: SelectOption<V>; i: number }[] }[] = [];
  shown.forEach((o, i) => {
    const g = groups[groups.length - 1];
    if (g && g.name === o.group) g.items.push({ o, i });
    else groups.push({ name: o.group, items: [{ o, i }] });
  });

  const renderOption = (o: SelectOption<V>, i: number) => {
    const isSel = o.value === value;
    return (
      <div
        key={`${String(o.value)}-${i}`}
        id={optId(i)}
        role="option"
        aria-selected={isSel}
        aria-disabled={o.disabled || undefined}
        data-value={String(o.value)}
        title={o.title}
        className={`select-option${isSel ? ' selected' : ''}${i === active ? ' active' : ''}${o.disabled ? ' disabled' : ''}`}
        onMouseMove={() => !o.disabled && i !== active && setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(o)}
      >
        <span className="select-check" aria-hidden="true">{isSel ? <Check size={14} strokeWidth={2} data-stroke="" /> : o.icon}</span>
        <span className={`select-option-label${mono ? ' mono' : ''}`}>{o.label}</span>
        {o.hint && <span className="select-option-hint">{o.hint}</span>}
      </div>
    );
  };

  const popover = open
    ? createPortal(
      <div
        ref={popRef}
        className={`select-pop${pos?.above ? ' above' : ''}`}
        style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minWidth, maxHeight: pos.maxHeight } : { left: -9999, top: -9999, visibility: 'hidden' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {withSearch && (
          <div className="select-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              className="select-search-input"
              type="text"
              role="combobox"
              aria-label={`Filter ${listName ?? 'options'}`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              placeholder="Type to filter…"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(firstEnabled(filterOptions(options, e.target.value)));
              }}
              onKeyDown={onKeyDown}
            />
          </div>
        )}
        <div
          id={listId}
          className="select-list"
          role="listbox"
          aria-label={props['aria-labelledby'] ? undefined : listName}
          aria-labelledby={props['aria-labelledby']}
          tabIndex={-1}
        >
          {shown.length === 0 && <div className="select-empty">No matches</div>}
          {groups.map((g, gi) =>
            g.name ? (
              <div key={`g-${gi}`} role="group" aria-label={g.name} className="select-group">
                <div className="select-group-label" aria-hidden="true">{g.name}</div>
                {g.items.map(({ o, i }) => renderOption(o, i))}
              </div>
            ) : (
              g.items.map(({ o, i }) => renderOption(o, i))
            ),
          )}
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={(el) => {
          triggerRef.current = el;
          if (typeof outerRef === 'function') outerRef(el);
          else if (outerRef) (outerRef as { current: HTMLButtonElement | null }).current = el;
        }}
        id={id}
        type="button"
        role="combobox"
        className={`input select-trigger${sizeCls}${mono ? ' mono' : ''}${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        style={style}
        title={title}
        disabled={disabled}
        data-value={value === null || value === undefined ? '' : String(value)}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid'] || undefined}
        aria-required={props['aria-required'] || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={withSearch ? undefined : activeId}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // focus left for something other than the popover (its filter box)
          const to = e.relatedTarget as Node | null;
          if (open && !withSearch && !(to && popRef.current?.contains(to))) close(false);
        }}
      >
        {leadingIcon && <span className="select-lead" aria-hidden="true">{leadingIcon}</span>}
        <span className={`select-value${selected ? '' : ' placeholder'}`}>{label}</span>
        <ChevronDown size={14} className="select-chevron" aria-hidden="true" />
      </button>
      {popover}
    </>
  );
}


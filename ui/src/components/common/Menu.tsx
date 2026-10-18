// Context menus and dropdowns (WAI-ARIA menu pattern): the menu container takes focus and points at the active
// item with aria-activedescendant; Arrow keys / Home / End / typeahead move, Enter / Space / ArrowRight open a
// submenu and focus its first item, ArrowLeft / Esc close it, and focus returns to the invoker on close.
import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { displayShortcut } from '../../commands/keys';

export interface MenuItem {
  id?: string;
  label?: string;
  icon?: ReactNode;
  /** A shortcut spec ("Mod+C") or an already displayed label; rendered through displayShortcut(). */
  shortcut?: string;
  /** Further shortcuts of the same item, shown after the first one ("Shift+Alt+F / Ctrl+Alt+L"). */
  extraShortcuts?: string[];
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  /** Keep the menu open after clicking (multi-select checklists). */
  keepOpen?: boolean;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  /** Opened with the keyboard: the first enabled item is active right away. */
  fromKeyboard: boolean;
  /** Element focused when the menu opened; it gets focus back on close. */
  invoker: Element | null;
  seq: number;
}

interface MenuState {
  open: OpenMenu | null;
  show(x: number, y: number, items: MenuItem[], opts?: { fromKeyboard?: boolean }): void;
  /** Close; `restore` gives focus back to the invoker (Esc, item activation). */
  hide(restore?: boolean): void;
}

// Input modality: a menu opened right after a key press counts as opened from the keyboard.
let lastInput: 'keyboard' | 'pointer' = 'pointer';
let menuSeq = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true);
  window.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
}

export const useMenu = create<MenuState>((set, get) => ({
  open: null,
  show: (x, y, items, opts) => set({
    open: { x, y, items, fromKeyboard: opts?.fromKeyboard ?? lastInput === 'keyboard', invoker: typeof document !== 'undefined' ? document.activeElement : null, seq: ++menuSeq },
  }),
  hide: (restore = false) => {
    const cur = get().open;
    if (!cur) return;
    if (restore && cur.invoker instanceof HTMLElement && cur.invoker.isConnected && cur.invoker !== document.body) cur.invoker.focus({ preventScroll: true });
    set({ open: null });
  },
}));

/** Open a context menu at the mouse position (or at a row, from Shift+F10 / the context-menu key). */
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; button?: number }, items: MenuItem[]) {
  e.preventDefault?.();
  // Keyboard handlers pass a plain position object; mouse events carry a button.
  useMenu.getState().show(e.clientX, e.clientY, items, { fromKeyboard: typeof e.button !== 'number' || lastInput === 'keyboard' });
}

/** Open a dropdown menu below an element. */
export function showMenuBelow(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  useMenu.getState().show(r.left, r.bottom + 2, items);
}

const GLYPHS = /[⌘⇧⌥⌃↩⎋⌫⌦⇥↑↓←→]/;

/** Platform label of a menu shortcut: specs go through displayShortcut (⌘ on macOS), labels are kept. */
export function shortcutLabel(s: string): string {
  if (GLYPHS.test(s)) return s;
  try {
    return displayShortcut(s);
  } catch {
    return s;
  }
}

function enabledIndexes(items: MenuItem[]): number[] {
  return items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
}

interface ListProps {
  items: MenuItem[];
  x: number;
  y: number;
  depth: number;
  /** Active item when the list opens (-1: none, mouse). */
  initialActive: number;
  /** Close the whole menu; `restore` focuses the invoker. */
  onClose: (restore: boolean) => void;
  /** Submenu only: close this level and focus the parent. */
  onBack?: () => void;
  ariaLabel?: string;
}

function MenuList({ items, x, y, depth, initialActive, onClose, onBack, ariaLabel }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ idx: number; x: number; y: number; keyboard: boolean } | null>(null);
  const [active, setActive] = useState(initialActive);
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = depth > 0 ? x - r.width - 200 : window.innerWidth - r.width - 4;
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, nx), y: ny });
  }, [x, y, depth]);

  // The menu container holds focus; the active item is announced through aria-activedescendant.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (active < 0) return;
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const itemId = (i: number) => `${baseId}-item-${i}`;

  const openSub = (i: number, keyboard: boolean) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    const r = el?.getBoundingClientRect();
    setSub({ idx: i, x: (r?.right ?? pos.x + 200) + 2, y: (r?.top ?? pos.y) - 4, keyboard });
  };

  const activate = (i: number, keyboard: boolean) => {
    const it = items[i];
    if (!it || it.disabled || it.separator) return;
    if (it.submenu) {
      openSub(i, keyboard);
      return;
    }
    if (!it.keepOpen) onClose(true);
    it.onClick?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys typed while a submenu has focus are handled there.
    if (e.target !== ref.current) return;
    const enabled = enabledIndexes(items);
    const move = (to: number | undefined) => setActive(to ?? -1);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(enabled[(enabled.indexOf(active) + 1) % enabled.length]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(enabled[(enabled.indexOf(active) - 1 + enabled.length) % enabled.length] ?? enabled[enabled.length - 1]);
        break;
      case 'Home':
      case 'PageUp':
        e.preventDefault();
        move(enabled[0]);
        break;
      case 'End':
      case 'PageDown':
        e.preventDefault();
        move(enabled[enabled.length - 1]);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (active >= 0 && items[active]?.submenu && !items[active].disabled) openSub(active, true);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        onBack?.();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0) activate(active, true);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (onBack) onBack();
        else onClose(true);
        break;
      case 'Tab':
        e.preventDefault();
        onClose(true);
        break;
      default:
        if (e.key.length === 1 && e.key.trim() !== '' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Typeahead: consecutive characters within 700 ms build a prefix; a single repeated character cycles.
          e.preventDefault();
          const now = Date.now();
          const t = typed.current;
          t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
          t.at = now;
          const same = t.text.split('').every((ch) => ch === t.text[0]);
          const prefix = same ? t.text[0] : t.text;
          const start = enabled.indexOf(active);
          for (let k = same || start < 0 ? 1 : 0; k <= enabled.length; k++) {
            const i = enabled[(start + k + enabled.length) % enabled.length];
            if (items[i]?.label?.toLowerCase().startsWith(prefix)) {
              setActive(i);
              break;
            }
          }
        }
    }
  };

  const subItems = sub ? items[sub.idx]?.submenu : undefined;

  return (
    <>
      <div
        ref={ref}
        className="menu"
        role="menu"
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-activedescendant={active >= 0 ? itemId(active) : undefined}
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
      >
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="menu-sep" role="separator" />
          ) : (
            <div
              key={it.id ?? i}
              id={itemId(i)}
              data-index={i}
              role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined}
              aria-disabled={it.disabled || undefined}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              aria-expanded={it.submenu ? sub?.idx === i : undefined}
              className={`menu-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${active === i ? ' active' : ''}`}
              onMouseEnter={() => {
                setActive(i);
                if (it.submenu && !it.disabled) openSub(i, false);
                else setSub(null);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => activate(i, false)}
            >
              <span className="menu-icon" aria-hidden="true">{it.checked ? <Check size={14} /> : it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-shortcut">{[it.shortcut, ...(it.extraShortcuts ?? [])].map(shortcutLabel).join(' / ')}</span>}
              {it.submenu && <ChevronRight size={14} className="menu-chevron" aria-hidden="true" />}
            </div>
          ),
        )}
      </div>
      {sub && subItems && (
        <MenuList
          key={sub.idx}
          items={subItems}
          x={sub.x}
          y={sub.y}
          depth={depth + 1}
          ariaLabel={items[sub.idx]?.label}
          initialActive={sub.keyboard ? enabledIndexes(subItems)[0] ?? -1 : -1}
          onClose={onClose}
          onBack={() => {
            setSub(null);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export function MenuHost() {
  const open = useMenu((s) => s.open);
  const hide = useMenu((s) => s.hide);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.menu')) hide(false);
    };
    const onBlur = () => hide(false);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open, hide]);
  if (!open) return null;
  return (
    <MenuList
      key={open.seq}
      items={open.items}
      x={open.x}
      y={open.y}
      depth={0}
      initialActive={open.fromKeyboard ? enabledIndexes(open.items)[0] ?? -1 : -1}
      onClose={(restore) => hide(restore)}
    />
  );
}

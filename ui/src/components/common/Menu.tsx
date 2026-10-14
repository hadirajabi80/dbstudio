import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export interface MenuItem {
  id?: string;
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  /** Keep the menu open after clicking (multi-select checklists). */
  keepOpen?: boolean;
}

interface MenuState {
  open: { x: number; y: number; items: MenuItem[] } | null;
  show(x: number, y: number, items: MenuItem[]): void;
  hide(): void;
}

export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  hide: () => set({ open: null }),
}));

/** Open a context menu at the mouse position. */
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  useMenu.getState().show(e.clientX, e.clientY, items);
}

/** Open a dropdown menu below an element. */
export function showMenuBelow(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  useMenu.getState().show(r.left, r.bottom + 2, items);
}

function MenuList({ items, x, y, onClose, depth }: { items: MenuItem[]; x: number; y: number; onClose: () => void; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [active, setActive] = useState(-1);

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

  useEffect(() => {
    if (depth > 0) return;
    const onKey = (e: KeyboardEvent) => {
      const enabled = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => enabled[(enabled.indexOf(a) + 1) % enabled.length] ?? -1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => enabled[(enabled.indexOf(a) - 1 + enabled.length) % enabled.length] ?? -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        setActive(e.key === 'Home' ? enabled[0] ?? -1 : enabled[enabled.length - 1] ?? -1);
      } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
        e.preventDefault();
        const it = items[active];
        if (it && !it.submenu) {
          if (!it.keepOpen) onClose();
          it.onClick?.();
        }
      } else if (e.key.length === 1 && e.key.trim() !== "" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typeahead: jump to the next item whose label starts with the typed character.
        e.preventDefault();
        const ch = e.key.toLowerCase();
        const start = enabled.indexOf(active);
        for (let k = 1; k <= enabled.length; k++) {
          const i = enabled[(start + k + enabled.length) % enabled.length];
          if (items[i]?.label?.toLowerCase().startsWith(ch)) {
            setActive(i);
            break;
          }
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, active, onClose, depth]);

  return (
    <>
      <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="menu-sep" />
          ) : (
            <div
              key={it.id ?? i}
              role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined}
              aria-disabled={it.disabled || undefined}
              className={`menu-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${active === i ? ' active' : ''}`}
              onMouseEnter={(e) => {
                setActive(i);
                if (it.submenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSub({ idx: i, x: r.right + 2, y: r.top - 4 });
                } else setSub(null);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (it.disabled || it.submenu) return;
                if (!it.keepOpen) onClose();
                it.onClick?.();
              }}
            >
              <span className="menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
              {it.submenu && <ChevronRight size={14} className="menu-chevron" />}
            </div>
          ),
        )}
      </div>
      {sub && items[sub.idx]?.submenu && <MenuList items={items[sub.idx].submenu!} x={sub.x} y={sub.y} onClose={onClose} depth={depth + 1} />}
    </>
  );
}

export function MenuHost() {
  const open = useMenu((s) => s.open);
  const hide = useMenu((s) => s.hide);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.menu')) hide();
    };
    const onBlur = () => hide();
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
  return <MenuList items={open.items} x={open.x} y={open.y} onClose={hide} depth={0} />;
}

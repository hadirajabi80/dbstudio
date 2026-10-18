// Focus management shared by overlays (palette, switchers, menus, popovers, dialogs): capture the focused element
// when the overlay opens and give focus back when it closes, so keystrokes never land on <body> (PLAN-M1.5 5.3).
import { useLayoutEffect, useRef } from 'react';

type Fallback = () => void;

let fallback: Fallback | null = null;
let lastRestore = 0;

/** True right after an overlay gave focus back (a tab opened by that overlay may still take it). */
export function restoredRecently(ms = 600): boolean {
  return Date.now() - lastRestore < ms;
}

/** The shell registers what to focus when the remembered element is gone (the active tab's primary element). */
export function setFocusFallback(fn: Fallback | null): void {
  fallback = fn;
}

/** Inside a hidden tab (consoles and view tabs are hidden with an inline display:none) or a hidden ancestor. */
export function isHidden(el: Element): boolean {
  return !!el.closest('[style*="display: none"], [hidden]');
}

function focusable(el: Element | null): el is HTMLElement {
  return !!el && el instanceof HTMLElement && el.isConnected && el !== document.body && typeof el.focus === 'function' && !isHidden(el);
}

/** True when nothing meaningful has focus (body, or an element that was removed with a closing overlay). */
export function focusIsLost(): boolean {
  if (typeof document === 'undefined') return false;
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || !a.isConnected || isHidden(a);
}

/**
 * Remember the focused element; the returned function restores it. It only acts when focus is lost or still inside
 * `within` (the closing overlay), so it never steals focus from something the overlay's action focused on purpose.
 */
export function captureFocus(): (within?: Element | null) => void {
  const prev = typeof document === 'undefined' ? null : document.activeElement;
  return (within) => {
    if (typeof document === 'undefined') return;
    const a = document.activeElement;
    const lost = focusIsLost() || (!!within && !!a && within.contains(a));
    if (!lost) return;
    lastRestore = Date.now();
    if (focusable(prev)) prev.focus({ preventScroll: true });
    else fallback?.();
  };
}

/**
 * Capture focus while `active` and restore it when the component unmounts or `active` turns false.
 * Pass the overlay's container ref so focus still inside it on close counts as lost.
 */
export function useRestoreFocus(active = true, container?: { current: Element | null }): void {
  const state = useRef<{ restore: (within?: Element | null) => void; mounted: boolean } | null>(null);
  // Captured while rendering: before the overlay's own children (autoFocus, effects) can move the focus into it.
  if (active && !state.current) state.current = { restore: captureFocus(), mounted: false };
  useLayoutEffect(() => {
    if (!active) return;
    // StrictMode runs setup → cleanup → setup: keep the element captured first.
    if (state.current) state.current.mounted = true;
    else state.current = { restore: captureFocus(), mounted: true };
    const st = state.current;
    const el = container?.current ?? null;
    return () => {
      st.mounted = false;
      // After React detached the overlay (the browser has moved focus to <body> by then).
      queueMicrotask(() => {
        if (st.mounted || state.current !== st || el?.isConnected) return;
        state.current = null;
        st.restore(el);
      });
    };
  }, [active, container]);
}

/** Focus the first element matching one of `selectors` inside `root` (in selector priority order). */
export function focusFirst(root: ParentNode | null | undefined, selectors: readonly string[]): boolean {
  if (!root) return false;
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el && !(el as HTMLButtonElement).disabled) {
      el.focus();
      return true;
    }
  }
  return false;
}

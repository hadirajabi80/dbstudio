// Hosts of the workspace tabs and the "focus the opened tab" logic (design-03 / design-15).
import { Suspense, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { getEditor } from '../../app/editors';
import { useTabs, type Tab, type ViewTab } from '../../store/tabs';
import type { EffectiveTheme } from '../../theme/useTheme';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { focusFirst, focusIsLost, restoredRecently, setFocusFallback } from '../common/focus';
import { getTabView, PRIMARY_FOCUS_SELECTORS, subscribeTabViews } from './tabViews';

/**
 * Placeholder of a view tab whose code is still loading (views are lazy() chunks, docs/PLAN-M2.md D10): a toolbar and
 * a few content rows, so the tab does not flash blank. Hidden tabs render nothing.
 */
export function TabViewSkeleton({ view, visible }: { view: string; visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="tab-skeleton" role="status" aria-busy="true" aria-label={`Loading ${view}`} data-testid="tab-view-skeleton">
      <div className="tab-skeleton-bar tab-skeleton-toolbar" />
      {[72, 56, 64, 40, 60].map((w, i) => (
        <div key={i} className="tab-skeleton-bar" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/**
 * Error boundary of one workspace tab (console, object or view), keyed by the tab id: a crash shows the error panel in
 * that tab only, the other tabs and the shell keep working. A hidden crashed tab renders nothing until it is shown.
 */
export function TabErrorBoundary({ tab, visible, children }: { tab: Pick<Tab, 'id' | 'title'>; visible: boolean; children: ReactNode }) {
  return (
    <ErrorBoundary key={tab.id} area={`“${tab.title}”`} variant="tab" hidden={!visible}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * A registered view tab. Every view is wrapped in a container that is `display: none` while the tab is hidden, so a
 * view that ignores its `visible` prop can never paint over the active tab. Visible, the wrapper is
 * `display: contents` and does not change the view's layout. The view renders inside a Suspense boundary, so a
 * lazy view (or a lazy part of one) shows the skeleton while its chunk loads instead of suspending the shell.
 */
export function ViewTabHost({ tab, theme, visible }: { tab: ViewTab; theme: EffectiveTheme; visible: boolean }) {
  useSyncExternalStore(subscribeTabViews, () => getTabView(tab.view), () => getTabView(tab.view));
  const def = getTabView(tab.view);
  return (
    <div className="view-tab-host" data-tab-host={tab.id} data-view={tab.view} style={{ display: visible ? 'contents' : 'none' }} aria-hidden={visible ? undefined : true}>
      {def ? (
        <TabErrorBoundary tab={tab} visible={visible}>
          <Suspense fallback={<TabViewSkeleton view={tab.view} visible={visible} />}>
            <def.component tab={tab} theme={theme} visible={visible} />
          </Suspense>
        </TabErrorBoundary>
      ) : visible ? (
        <div className="workspace-missing">
          <p>This tab ({tab.view}) is not available in this build.</p>
        </div>
      ) : null}
    </div>
  );
}

/** DOM container of a tab (consoles: `.console[data-tab]`; others: the host wrapper). */
export function tabContainer(tabId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(tabId) : tabId;
  return document.querySelector<HTMLElement>(`[data-tab-host="${esc}"]`) ?? document.querySelector<HTMLElement>(`.console[data-tab="${esc}"]`);
}

/** Focus the primary element of a tab: the console editor, the view's `focusPrimary`, else the shell fallback. */
export function focusTabPrimary(tab: Tab): boolean {
  if (tab.kind === 'console') {
    const ed = getEditor(tab.id);
    if (!ed) return false;
    ed.focus();
    return true;
  }
  const el = tabContainer(tab.id);
  if (!el) return false;
  if (tab.kind === 'view') {
    const def = getTabView(tab.view);
    if (def?.focusPrimary) {
      try {
        if (def.focusPrimary(tab, el)) return true;
      } catch (e) {
        console.warn('[tabs] focusPrimary failed', e);
      }
    }
  }
  return focusFirst(el, PRIMARY_FOCUS_SELECTORS);
}

const RETRY_MS = [0, 50, 150, 400, 900];

/**
 * Consumes `useTabs.focusRequest`: once the opened tab is shown, focus its primary element — unless focus is already
 * inside it (New table focuses its name field itself) or the user has moved focus somewhere else meanwhile.
 * Views that render asynchronously (the data grid) are retried for about a second.
 */
export function useTabFocusRequests(): void {
  const req = useTabs((s) => s.focusRequest);
  useEffect(() => {
    if (!req) return;
    const origin = document.activeElement;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const attempt = (i: number) => {
      if (cancelled) return;
      const s = useTabs.getState();
      const tab = s.tabs.find((t) => t.id === req.tabId);
      if (!tab || s.activeId !== tab.id) return;
      const el = tabContainer(tab.id);
      const a = document.activeElement;
      if (el && a && el.contains(a) && a !== el) return; // the view focused something itself
      // The user went elsewhere (an overlay giving focus back to where it was opened from does not count).
      if (a !== origin && !focusIsLost() && !restoredRecently()) return;
      if (focusTabPrimary(tab)) return;
      if (i + 1 < RETRY_MS.length) timers.push(setTimeout(() => attempt(i + 1), RETRY_MS[i + 1] - RETRY_MS[i]));
    };
    timers.push(setTimeout(() => attempt(0), 0));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [req]);
}

/** Focus target when the remembered element of a closing overlay is gone: the active tab, else the welcome screen. */
export function focusWorkspace(): void {
  const s = useTabs.getState();
  const tab = s.tabs.find((t) => t.id === s.activeId);
  if (tab && focusTabPrimary(tab)) return;
  focusFirst(document, ['.welcome button:not([disabled])', '.workspace [tabindex="0"]']);
}

/** Installs `focusWorkspace` as the focus fallback of overlays (palette, switcher, menus). */
export function useFocusFallback(): void {
  useEffect(() => {
    setFocusFallback(focusWorkspace);
    return () => setFocusFallback(null);
  }, []);
}

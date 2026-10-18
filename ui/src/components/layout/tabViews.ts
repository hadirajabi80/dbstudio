// Registry of tab views contributed by other packages (WP-G data tab, WP-H plan view, WP-I designers/codegen,
// WP-J multi-run). A package registers its component once (e.g. from its commands.ts) and opens tabs with
// `useTabs.getState().openView({ view: 'data', title: 'Data: dbo.Customers', connectionId, database, state, key })`.
//
//   registerTabView('data', { component: DataTabView, icon: 'Table2', title: (t) => t.title });
//
// The component receives the tab (its `state` is the view's own data), the effective theme and whether it is
// visible (tabs stay mounted while hidden). Use `useTabs.getState().updateView(id, { state, dirty, title })`.
import type { ComponentType } from 'react';
import type { ViewTab } from '../../store/tabs';
import type { EffectiveTheme } from '../../theme/useTheme';

export interface TabViewProps {
  tab: ViewTab;
  theme: EffectiveTheme;
  visible: boolean;
}

export interface TabViewDef {
  component: ComponentType<TabViewProps>;
  /** lucide icon name shown in the tab strip (default "File"). */
  icon?: string;
  /**
   * Called before the tab closes; return false to keep it open. The default asks for confirmation when the tab is
   * marked dirty.
   */
  beforeClose?: (tab: ViewTab) => boolean | Promise<boolean>;
  /** Called after the tab closed (release sessions, caches). */
  onClosed?: (tab: ViewTab) => void;
  /**
   * Focus the view's primary element (data tab: grid canvas; designer: first column cell; codegen: Language select)
   * when the tab was opened from a command or the keyboard. Return false when nothing could be focused yet (the
   * shell retries briefly, then falls back to `PRIMARY_FOCUS_SELECTORS` inside the tab container).
   */
  focusPrimary?: (tab: ViewTab, container: HTMLElement) => boolean;
}

/** Shell fallback for views without `focusPrimary`, in priority order. */
export const PRIMARY_FOCUS_SELECTORS: readonly string[] = [
  '[data-primary-focus]',
  '[data-testid="data-grid-canvas"]',
  '[role="grid"] [tabindex="0"]',
  '.cg-options select',
  'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])',
  '[role="tree"], [tabindex="0"]',
  'button:not([disabled])',
];

const views = new Map<string, TabViewDef>();
const listeners = new Set<() => void>();

export function registerTabView(view: string, def: TabViewDef): () => void {
  views.set(view, def);
  listeners.forEach((l) => l());
  return () => {
    if (views.get(view) === def) {
      views.delete(view);
      listeners.forEach((l) => l());
    }
  };
}

export function getTabView(view: string): TabViewDef | undefined {
  return views.get(view);
}

export function subscribeTabViews(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

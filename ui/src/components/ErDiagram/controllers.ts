// Registry of the mounted ER diagram controllers by tab id, so the er.* commands (palette, shortcuts, context menus)
// can drive the diagram of the active tab without importing the lazily loaded view.
import { dialectOf, getConnection } from '../../store/connections';
import { getActiveTab } from '../../store/tabs';
import type { ErController } from './store';

export const ER_VIEW_ID = 'er.diagram';

const controllers = new Map<string, ErController>();

export function registerController(tabId: string, c: ErController): () => void {
  controllers.set(tabId, c);
  return () => {
    if (controllers.get(tabId) === c) controllers.delete(tabId);
  };
}

export function controllerOf(tabId: string | null | undefined): ErController | null {
  return tabId ? controllers.get(tabId) ?? null : null;
}

/** Controller of the active tab when it is an ER diagram. */
export function activeController(): ErController | null {
  const t = getActiveTab();
  if (!t || t.kind !== 'view' || t.view !== ER_VIEW_ID) return null;
  return controllers.get(t.id) ?? null;
}

/** Args of card-level commands (card context menu, details pane buttons). */
export interface ErCardArgs {
  kind: 'er-card';
  tabId: string;
  key: string;
}

export function isErCardArgs(a: unknown): a is ErCardArgs {
  return !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'er-card';
}

/** Controller + card key a card command applies to (its args, else the active diagram's focused card). */
export function cardTarget(args: unknown): { c: ErController; key: string } | null {
  if (isErCardArgs(args)) {
    const c = controllerOf(args.tabId);
    return c && c.state.model?.byKey.has(args.key) ? { c, key: args.key } : null;
  }
  const c = activeController();
  const key = c?.targetKey();
  return c && key && c.state.model?.byKey.has(key) ? { c, key } : null;
}

/** Why foreign keys cannot be created from this diagram, or null when they can. */
export function fkUnavailableReason(connectionId: string, synthetic: boolean): string | null {
  if (synthetic) return 'This is a generated diagram';
  const conn = getConnection(connectionId);
  if (!conn) return 'The connection no longer exists';
  if (dialectOf(connectionId) === 'sqlite') return 'SQLite cannot add a foreign key to an existing table';
  if (conn.readOnly) return `${conn.name} is read-only`;
  return null;
}

/** `CSS.escape` where available (jsdom lacks it), for `[data-key="…"]` selectors. */
export function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

// Objects tab commands (auto-loaded by commands/index.ts): "Show objects" for a database / schema / type folder (the
// explorer's container menu, Enter on such a row, the palette), and "Show dependencies" of an object. "Show objects"
// shows the permanent Objects tab (home.ts) on that node when it is on, else a per-scope Objects tab.
import { lazy } from 'react';
import { targetOf } from '../../commands/core';
import { registerCommands, type Command } from '../../commands/registry';
import { isObjectTarget, type CommandTarget } from '../../commands/types';
import { getConnection, providerKind } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { registerTabView } from '../layout/tabViews';
import { requestObjectSection } from '../ObjectTab/sectionRequests';
import { OBJECTS_HOME_VIEW, showInObjectsHome } from './home';
import { OBJECTS_VIEW } from './model';
import { openObjects, scopeOf } from './open';

const ObjectListView = lazy(() => import('./ObjectListView').then((m) => ({ default: m.ObjectListView })));
const ObjectsHomeView = lazy(() => import('./ObjectsHomeView').then((m) => ({ default: m.ObjectsHomeView })));

/**
 * The node to show: the explorer node (menu args or selection), else (palette, nothing usable selected) the active
 * tab's connection and database.
 */
function nodeFor(args: unknown): CommandTarget | null {
  const t = targetOf(args);
  if (scopeOf(t)) return t;
  if (args && typeof args === 'object') return null;
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((x) => x.id === tabs.activeId);
  if (!tab?.connectionId) return null;
  const c = scopeOf({ kind: 'connection', connectionId: tab.connectionId });
  return c ? { kind: 'container', connectionId: tab.connectionId, database: tab.database ?? null, schema: c.schema } : null;
}

function dependencyTarget(args: unknown) {
  const t = targetOf(args);
  if (!isObjectTarget(t)) return null;
  const c = getConnection(t.connectionId);
  return c && providerKind(c.providerId) === 'relational' ? t : null;
}

export const OBJECT_LIST_COMMANDS: Command<never>[] = [
  {
    id: 'objects.open', title: 'Show objects', category: 'Database', icon: 'LayoutList',
    keywords: 'object browser list overview tables views procedures functions triggers navicat',
    when: (a?: unknown) => !!nodeFor(a),
    run: (a?: unknown) => {
      const node = nodeFor(a);
      const s = node ? scopeOf(node) : null;
      if (!node || !s) return;
      if (!showInObjectsHome(node)) openObjects(s);
    },
  },
  {
    id: 'objects.dependencies', title: 'Show dependencies', category: 'Database', icon: 'Waypoints',
    keywords: 'relations usages uses used by references referenced foreign keys depends',
    when: (a?: unknown) => !!dependencyTarget(a),
    run: (a?: unknown) => {
      const t = dependencyTarget(a);
      if (!t) return;
      const id = useTabs.getState().openObject(t.connectionId, t.database, t.ref);
      requestObjectSection(id, 'deps');
    },
  },
];

/** The list's filter box (or the cards' filter, or the welcome content's first button). */
function focusPrimary(_tab: unknown, el: HTMLElement): boolean {
  const target = el.querySelector<HTMLElement>('[data-primary-focus]') ?? el.querySelector<HTMLElement>('.welcome button:not([disabled])');
  target?.focus();
  return !!target;
}

export function registerObjectListCommands(): void {
  registerCommands(OBJECT_LIST_COMMANDS);
  registerTabView(OBJECTS_VIEW, { component: ObjectListView, icon: 'LayoutList', focusPrimary });
  registerTabView(OBJECTS_HOME_VIEW, { component: ObjectsHomeView, icon: 'LayoutList', focusPrimary });
}

// Objects tab commands (auto-loaded by commands/index.ts): "Show objects" for a database / schema / type folder (the
// explorer's container menu, Enter on such a row, the palette), and "Show dependencies" of an object.
import { lazy } from 'react';
import { targetOf } from '../../commands/core';
import { registerCommands, type Command } from '../../commands/registry';
import { isObjectTarget } from '../../commands/types';
import { getConnection, providerKind } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { registerTabView } from '../layout/tabViews';
import { requestObjectSection } from '../ObjectTab/sectionRequests';
import { OBJECTS_VIEW } from './model';
import { openObjects, scopeOf } from './open';

const ObjectListView = lazy(() => import('./ObjectListView').then((m) => ({ default: m.ObjectListView })));

/** The explorer node (menu args or selection), else the active tab's connection and database (palette). */
function scopeFor(args: unknown) {
  const s = scopeOf(targetOf(args));
  if (s || (args && typeof args === 'object')) return s;
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  if (!tab?.connectionId) return null;
  const c = scopeOf({ kind: 'connection', connectionId: tab.connectionId });
  return c && { ...c, database: tab.database ?? null };
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
    when: (a?: unknown) => !!scopeFor(a),
    run: (a?: unknown) => {
      const s = scopeFor(a);
      if (s) openObjects(s);
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

export function registerObjectListCommands(): void {
  registerCommands(OBJECT_LIST_COMMANDS);
  registerTabView(OBJECTS_VIEW, {
    component: ObjectListView,
    icon: 'LayoutList',
    focusPrimary: (_tab, el) => {
      const search = el.querySelector<HTMLElement>('[data-primary-focus]');
      search?.focus();
      return !!search;
    },
  });
}

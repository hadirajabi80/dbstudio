// Find in database (auto-loaded by commands/index.ts): Ctrl+Shift+F opens the Search tab scoped to the explorer's
// selected node (connection, database, schema, type folder, table) when the explorer has focus, to a context menu's
// node when run from one, and to every connected connection otherwise. The view itself is lazy-loaded.
import { lazy } from 'react';
import { registerCommands, type Command } from '../../commands/registry';
import type { CommandTarget } from '../../commands/types';
import { toast } from '../../store/ui';
import { registerTabView } from '../layout/tabViews';
import { scopeFromTarget, SEARCH_VIEW } from './model';
import { isRelationalConnection, openSearch } from './open';
import { useSearchRuns } from './searchStore';

const SearchView = lazy(() => import('./SearchView').then((m) => ({ default: m.SearchView })));

/** A context-menu target (menus pass one); the palette and the shortcut pass nothing. */
function menuTarget(args: unknown): CommandTarget | null {
  return args && typeof args === 'object' && 'kind' in args ? (args as CommandTarget) : null;
}

export const SEARCH_COMMANDS: Command<never>[] = [
  {
    id: 'search.findInDatabase', title: 'Find in database…', category: 'Database', shortcut: 'Mod+Shift+F', icon: 'Search',
    keywords: 'search find full text grep objects columns code procedures data contents all connections schema navicat datagrip',
    // From a context menu: only nodes that can be searched (not Redis/MongoDB/Kafka).
    when: (a?: unknown) => !menuTarget(a) || !!scopeFromTarget(menuTarget(a), isRelationalConnection),
    run: (a?: unknown) => {
      const { unsupported } = openSearch(menuTarget(a));
      if (unsupported) toast('info', 'This kind of connection cannot be searched: searching every connected database instead.');
    },
  },
];

export function registerSearchCommands(): void {
  registerCommands(SEARCH_COMMANDS);
  registerTabView(SEARCH_VIEW, {
    component: SearchView,
    icon: 'Search',
    onClosed: (tab) => useSearchRuns.getState().dispose(tab.id),
    focusPrimary: (_tab, el) => {
      const input = el.querySelector<HTMLInputElement>('input[data-primary-focus]');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    },
  });
}

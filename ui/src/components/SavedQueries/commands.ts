// Saved queries (Navicat's "Queries" node under each schema; auto-loaded by commands/index.ts):
//   queries.saveToSchema (Mod+Alt+S)  the active console (or a tab menu's console) → the save dialog; the console is then
//                                     bound to the query ("Query: name") and Ctrl+S (file.save) writes back to it
//   queries.save                      Ctrl+S of a bound console (file.save routes here)
//   queries.new                       a Queries folder / schema / the Objects tab's New menu → name dialog → console
//   queries.open / rename (F2) / duplicate / copySql / delete   a saved query (explorer, Objects tab, Ctrl+P)
// Targets: a SavedQueryTarget or ContainerTarget from a menu, else the explorer's selection (commands/core targetOf).
import { targetOf } from '../../commands/core';
import { registerCommands, type Command } from '../../commands/registry';
import { isSavedQueryTarget, isTabTarget, type SavedQueryTarget } from '../../commands/types';
import { useSavedQueries } from '../../store/savedQueries';
import { getActiveConsole, useTabs } from '../../store/tabs';
import {
  consoleScope, copyQuerySql, deleteSavedQuery, duplicateSavedQuery, newQueryIn, openSavedQuery, renameSavedQuery, saveableConsole, saveBoundQuery,
  saveConsoleToSchema, scopeOfTarget,
} from './actions';

function queryTarget(args: unknown): SavedQueryTarget | null {
  const t = targetOf(args);
  return isSavedQueryTarget(t) ? t : null;
}

/** The console a command acts on: a tab menu's tab, else the active console. */
function tabIdOf(args: unknown): string | null {
  return isTabTarget(args) ? args.tabId : useTabs.getState().activeId;
}

/** Where "New query…" creates: the node (menu args or the explorer selection), else the active console's schema. */
function newQueryScope(args: unknown) {
  const node = scopeOfTarget(targetOf(args));
  if (node?.schema || (args && typeof args === 'object')) return node;
  const tab = getActiveConsole();
  return tab ? consoleScope(tab) : node;
}

export const SAVED_QUERY_COMMANDS: Command<never>[] = [
  {
    id: 'queries.saveToSchema', title: 'Save query to schema…', category: 'File', shortcut: 'Mod+Alt+S', icon: 'FileCode2',
    keywords: 'saved queries navicat store favorite bookmark keep schema database',
    when: (a?: unknown) => !!saveableConsole(tabIdOf(a)),
    run: (a?: unknown) => saveConsoleToSchema(tabIdOf(a)),
  },
  {
    id: 'queries.save', title: 'Save query', category: 'File', icon: 'Save', palette: false,
    when: (a?: unknown) => {
      const t = useTabs.getState().tabs.find((x) => x.id === tabIdOf(a));
      return t?.kind === 'console' && !!t.savedQuery;
    },
    run: (a?: unknown) => {
      const id = tabIdOf(a);
      if (id) void saveBoundQuery(id);
    },
  },
  {
    id: 'queries.new', title: 'New query…', category: 'Database', icon: 'Plus', keywords: 'saved query create schema navicat',
    when: (a?: unknown) => !!newQueryScope(a)?.schema,
    run: (a?: unknown) => {
      const scope = newQueryScope(a);
      if (scope) newQueryIn({ kind: 'container', connectionId: scope.connectionId, database: scope.database, schema: scope.schema, queries: true });
    },
  },
  {
    id: 'queries.open', title: 'Open query', category: 'Database', icon: 'SquareTerminal', palette: false,
    when: (a?: unknown) => !!queryTarget(a),
    run: (a?: unknown) => openSavedQuery(queryTarget(a)!),
  },
  {
    id: 'queries.rename', title: 'Rename query…', category: 'Database', icon: 'TextCursorInput', shortcut: 'F2', scope: 'explorer',
    when: (a?: unknown) => !!queryTarget(a),
    run: (a?: unknown) => renameSavedQuery(queryTarget(a)!),
  },
  {
    id: 'queries.duplicate', title: 'Duplicate query', category: 'Database', icon: 'Copy',
    when: (a?: unknown) => !!queryTarget(a),
    run: (a?: unknown) => duplicateSavedQuery(queryTarget(a)!),
  },
  {
    id: 'queries.copySql', title: 'Copy SQL', category: 'Database', icon: 'ClipboardCopy',
    when: (a?: unknown) => !!queryTarget(a),
    run: (a?: unknown) => copyQuerySql(queryTarget(a)!),
  },
  {
    id: 'queries.delete', title: 'Delete query…', category: 'Database', icon: 'Trash2', danger: true,
    when: (a?: unknown) => !!queryTarget(a),
    run: (a?: unknown) => deleteSavedQuery(queryTarget(a)!),
  },
  {
    id: 'queries.refresh', title: 'Refresh saved queries', category: 'Database', icon: 'RefreshCw', palette: false,
    when: (a?: unknown) => !!scopeOfTarget(targetOf(a)),
    run: (a?: unknown) => {
      const s = scopeOfTarget(targetOf(a));
      if (s) void useSavedQueries.getState().load(s.connectionId);
    },
  },
];

export function registerSavedQueryCommands(): void {
  registerCommands(SAVED_QUERY_COMMANDS);
}

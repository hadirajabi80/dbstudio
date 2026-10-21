// Executed-query commands of a result grid (console result set, Data tab): auto-loaded by commands/index.ts. They act
// on the grid named by `args.gridKey` (the query line under the grid passes it), else on the grid that last had focus.
// No shortcuts: Copy / Open in console are one click on the line under the grid.
import { registerCommands, type Command } from '../../commands/registry';
import type { ContextEntry } from '../../commands/menuModel';
import { copyExecutedQuery, executedQueryOf, hasBinds, openExecutedQueryInConsole } from './executedQuery';

export const RESULTS_QUERY_COMMANDS: Command<never>[] = [
  {
    id: 'results.copyQuery', title: 'Copy executed query', category: 'Query', icon: 'Copy',
    keywords: 'copy sql statement clipboard result grid inline parameters values',
    when: (a?: unknown) => !!executedQueryOf(a),
    run: (a?: unknown) => {
      const q = executedQueryOf(a);
      return q ? copyExecutedQuery(q) : undefined;
    },
  },
  {
    id: 'results.copyQueryWithParams', title: 'Copy executed query with parameters', category: 'Query', icon: 'Variable',
    keywords: 'copy sql statement clipboard bind placeholders',
    when: (a?: unknown) => {
      const q = executedQueryOf(a);
      return !!q && hasBinds(q);
    },
    run: (a?: unknown) => {
      const q = executedQueryOf(a);
      return q ? copyExecutedQuery(q, true) : undefined;
    },
  },
  {
    id: 'results.openQueryInConsole', title: 'Open executed query in console', category: 'Query', icon: 'SquareTerminal',
    keywords: 'new console tab edit sql statement result grid',
    when: (a?: unknown) => !!executedQueryOf(a),
    run: (a?: unknown) => {
      const q = executedQueryOf(a);
      return q ? openExecutedQueryInConsole(q) : undefined;
    },
  },
];

/** "…" / right-click menu of the query line under a result grid. */
export const RESULTS_QUERY_MENU: ContextEntry[] = [
  { command: 'results.copyQuery', label: 'Copy query' },
  { command: 'results.copyQueryWithParams', label: 'Copy with parameters', hideDisabled: true },
  'separator',
  { command: 'results.openQueryInConsole', label: 'Open in console' },
];

export function registerResultsQueryCommands(): void {
  registerCommands(RESULTS_QUERY_COMMANDS);
}

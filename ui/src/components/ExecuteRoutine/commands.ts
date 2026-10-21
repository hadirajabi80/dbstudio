// Execute routine commands (auto-loaded by commands/index.ts). No shortcuts of their own: in an "Edit:" console of a
// routine, Run (Ctrl+Enter / F5) opens Execute routine, and the explorer's context menu offers "Execute…".
import { runActive } from '../../app/actions';
import { objectTargetOf } from '../../commands/core';
import { registerCommands, type Command } from '../../commands/registry';
import { isObjectTarget, type ObjectTarget } from '../../commands/types';
import { dialectOf } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { getActiveConsole } from '../../store/tabs';
import { openExecuteForEdit, routineEditOf } from './intercept';
import { EXECUTABLE_TYPES } from './routineSql';
import { useExecuteRoutine } from './store';

function executableTarget(t: ObjectTarget | null): ObjectTarget | null {
  if (!t) return null;
  const dialect = dialectOf(t.connectionId);
  if (dialect !== 'tsql' && dialect !== 'plsql' && dialect !== 'pgsql') return null; // SQLite has no routines
  if (EXECUTABLE_TYPES.has(t.ref.type)) return t;
  return t.ref.type === 'package' && dialect === 'plsql' ? t : null;
}

/** What `routine.execute` acts on: the menu's object, else the active "Edit:" console's routine, else the explorer selection. */
function routineTarget(args: unknown): ObjectTarget | 'edit' | null {
  if (args && typeof args === 'object' && 'kind' in args) return isObjectTarget(args) ? executableTarget(args) : null;
  if (routineEditOf(getActiveConsole()?.id)) return 'edit';
  return executableTarget(objectTargetOf(undefined));
}

const activeRunning = () => {
  const t = getActiveConsole();
  const r = useResults.getState();
  return !!t && isRunning(r.executions[r.byTab[t.id]]);
};

export const ROUTINE_COMMANDS: Command<never>[] = [
  {
    id: 'routine.execute', title: 'Execute procedure or function…', category: 'Database', icon: 'Play',
    keywords: 'run call exec stored procedure function parameters arguments',
    when: (a?: unknown) => !!routineTarget(a),
    run: (a?: unknown) => {
      const t = routineTarget(a);
      if (t === 'edit') openExecuteForEdit(getActiveConsole()!.id);
      else if (t) useExecuteRoutine.getState().open({ connectionId: t.connectionId, database: t.database, ref: t.ref });
    },
  },
  {
    // The Run button's menu in an "Edit:" console of a routine: run the editor text as a plain script (the
    // CREATE OR ALTER / OR REPLACE), which Run itself no longer does there.
    id: 'routine.runEditScript', title: 'Run the edit script as SQL', category: 'Query', icon: 'ListEnd', keywords: 'create or alter replace apply',
    when: () => !!routineEditOf(getActiveConsole()?.id) && !activeRunning(),
    run: () => runActive('script', { asScript: true }),
  },
];

export function registerRoutineCommands(): void {
  registerCommands(ROUTINE_COMMANDS);
}

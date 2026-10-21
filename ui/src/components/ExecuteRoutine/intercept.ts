// Run in an "Edit:" console of a procedure or function: the console holds the routine's CREATE OR ALTER / CREATE OR
// REPLACE script, and applying it is Save (Ctrl+S). Run (the toolbar button, Ctrl+Enter, F5) therefore executes the
// routine instead: it opens Execute routine with the parameter form. A selection still runs as typed, and the Run
// button's menu keeps "Run script" for running the whole text. Kept free of app/actions imports (actions calls it).
import type { RunLabel } from '../../api/types';
import { peekEditSession } from '../../designer/editSession';
import type { EditSession } from '../../designer/store';
import { useTabs } from '../../store/tabs';
import { EXECUTABLE_TYPES } from './routineSql';
import { useExecuteRoutine } from './store';

/** The edit session of a console when it edits an executable routine on the console's own connection. */
export function routineEditOf(tabId: string | null | undefined): EditSession | undefined {
  if (!tabId) return undefined;
  const edit = peekEditSession(tabId);
  if (!edit || !EXECUTABLE_TYPES.has(edit.ref.type) || edit.dialect === 'sqlite') return undefined;
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  return tab?.kind === 'console' && tab.connectionId === edit.connectionId ? edit : undefined;
}

/** Opens Execute routine for the edited routine. False when the console is not such an edit (run normally). */
export function openExecuteForEdit(tabId: string): boolean {
  const edit = routineEditOf(tabId);
  if (!edit) return false;
  useExecuteRoutine.getState().open({ connectionId: edit.connectionId, database: edit.database, ref: edit.ref, fromTabId: tabId });
  return true;
}

/**
 * Called for every run of a console (`runActive`, the editor's Ctrl+Enter / F5). True when the run was turned into
 * Execute routine; a selection always runs as typed.
 */
export function interceptRoutineRun(tabId: string, label: RunLabel): boolean {
  if (label === 'selection') return false;
  return openExecuteForEdit(tabId);
}

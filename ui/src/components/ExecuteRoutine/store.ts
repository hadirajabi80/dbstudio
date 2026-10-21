// Execute routine: the pending dialog request, and the last values per routine and connection (persisted next to
// the Parameters dialog's MRU in the free-form Settings.ui, key `routineParams`).
import { create } from 'zustand';
import type { ObjectRef } from '../../api/types';
import { useSettings } from '../../store/settings';
import type { ParamInput } from './routineSql';

export interface ExecuteRoutineRequest {
  connectionId: string;
  database: string | null;
  /** A procedure or function, or an Oracle package (the dialog then asks which member). */
  ref: ObjectRef;
  /** Package member to preselect. */
  member?: string | null;
  /** The console the request came from (an "Edit:" console): results go there. */
  fromTabId?: string | null;
}

interface ExecuteRoutineState {
  request: ExecuteRoutineRequest | null;
  open(r: ExecuteRoutineRequest): void;
  close(): void;
}

export const useExecuteRoutine = create<ExecuteRoutineState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

const KEY = 'routineParams';
const MRU_MAX = 8;

export interface RememberedParam {
  mode: ParamInput['mode'];
  /** Most recent first. */
  values: string[];
}
type RoutineMemory = Record<string, Record<string, RememberedParam>>;
type RoutineHistory = Record<string, RoutineMemory>;

function history(): RoutineHistory {
  return (useSettings.getState().settings.ui?.[KEY] as RoutineHistory | undefined) ?? {};
}

/** Key of one routine (overloads and package members differ by their argument list). */
export function routineKey(database: string | null, label: string, signature: string): string {
  return `${database ?? ''}|${label}(${signature})`.toLowerCase();
}

/** Remembered inputs of a routine, by parameter name (lower case). */
export function recallRoutine(connectionId: string, key: string): Record<string, RememberedParam> | undefined {
  return history()[connectionId]?.[key];
}

export function rememberRoutine(connectionId: string, key: string, rows: { name: string; input: ParamInput }[]): void {
  const all = history();
  const mine: RoutineMemory = { ...(all[connectionId] ?? {}) };
  const prev = mine[key] ?? {};
  const next: Record<string, RememberedParam> = {};
  for (const { name, input } of rows) {
    const k = name.toLowerCase();
    const values = prev[k]?.values ?? [];
    next[k] = { mode: input.mode, values: input.mode === 'value' ? [input.value, ...values.filter((v) => v !== input.value)].slice(0, MRU_MAX) : values };
  }
  mine[key] = next;
  useSettings.getState().update({ ui: { [KEY]: { ...all, [connectionId]: mine } } });
}

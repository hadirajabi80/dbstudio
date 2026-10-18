// UI state of the designer package that lives outside a tab: the procedure wizard and compare dialogs, and the
// "edit object" sessions (console tabs opened by F4, remembered for "Compare with server" and the atomic apply).
// The sessions mirror the `edit` field persisted in each console tab (store/tabs.ts); designer/editSession.ts
// re-registers them after a restart.
import { create } from 'zustand';
import type { Dialect } from '../api/types';
import type { ConsoleEdit } from '../store/tabs';
import type { RoutineKind } from './proc/templates';

/** Why Stop cannot cancel an "Edit:" console while its atomic apply runs (tooltip of the Stop button). */
export const EDIT_RUN_STOP_REASON = 'Applying in one transaction; waits up to 30 s for locks';

export interface WizardRequest {
  connectionId: string;
  database: string | null;
  schema: string | null;
  dialect: Dialect;
  kind?: RoutineKind;
  /** Pre-selected table for triggers. */
  table?: string | null;
  /** Oracle: pre-selected package to add a member to. */
  packageName?: string | null;
}

/** An "edit object" session; `serverDdl` is the DDL as stored on the server when the tab was opened (or last applied). */
export type EditSession = ConsoleEdit;

interface DesignerUiState {
  wizard: WizardRequest | null;
  compareTabId: string | null;
  edits: Record<string, EditSession>;
  /**
   * "Edit:" consoles whose atomic apply (POST /designer/apply) is in flight. The request cannot be cancelled: the
   * console's Stop button is disabled with EDIT_RUN_STOP_REASON while the flag is set.
   */
  editRunInFlight: Record<string, true>;
  setEditRunInFlight(tabId: string, on: boolean): void;
  openWizard(r: WizardRequest): void;
  closeWizard(): void;
  openCompare(tabId: string): void;
  closeCompare(): void;
  registerEdit(tabId: string, s: EditSession): void;
  forgetEdit(tabId: string): void;
}

export const useDesignerUi = create<DesignerUiState>((set, get) => ({
  wizard: null,
  compareTabId: null,
  edits: {},
  editRunInFlight: {},
  setEditRunInFlight: (tabId, on) => {
    const cur = get().editRunInFlight;
    if (on === !!cur[tabId]) return;
    const next = { ...cur };
    if (on) next[tabId] = true;
    else delete next[tabId];
    set({ editRunInFlight: next });
  },
  openWizard: (r) => set({ wizard: r }),
  closeWizard: () => set({ wizard: null }),
  openCompare: (tabId) => set({ compareTabId: tabId }),
  closeCompare: () => set({ compareTabId: null }),
  registerEdit: (tabId, s) => set({ edits: { ...get().edits, [tabId]: s } }),
  forgetEdit: (tabId) => {
    const edits = { ...get().edits };
    delete edits[tabId];
    set({ edits });
  },
}));

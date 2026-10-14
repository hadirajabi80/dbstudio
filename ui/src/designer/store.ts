// UI state of the designer package that lives outside a tab: the procedure wizard and compare dialogs, and the
// "edit object" sessions (console tabs opened by F4, remembered for "Compare with server").
import { create } from 'zustand';
import type { Dialect, ObjectRef } from '../api/types';
import type { RoutineKind } from './proc/templates';

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

export interface EditSession {
  connectionId: string;
  database: string | null;
  ref: ObjectRef;
  /** DDL as stored on the server when the tab was opened. */
  serverDdl: string;
  dialect: Dialect;
}

interface DesignerUiState {
  wizard: WizardRequest | null;
  compareTabId: string | null;
  edits: Record<string, EditSession>;
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

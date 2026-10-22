// The Find in database dialog (Ctrl+Shift+F): open flag, query state and size, kept while the dialog is closed so
// reopening restores the last query, scope and results (the results live in useSearchRuns under SEARCH_DIALOG_RUN).
// Tiny on purpose: the shell imports it to know when to load the dialog (SearchDialogHost).
import { create } from 'zustand';
import type { SearchTabState } from './model';

/** Owner of the dialog's run in useSearchRuns. */
export const SEARCH_DIALOG_RUN = 'search:dialog';

interface SearchDialogStore {
  open: boolean;
  state: SearchTabState | null;
  /** The explorer selection when the dialog last opened: a different selection re-scopes the next open. */
  explorerKey: string | null;
  /** Size the user resized the dialog to (null: the default). */
  size: { width: number; height: number } | null;
  /** The match preview under the results. */
  preview: boolean;
  show(state: SearchTabState, explorerKey: string | null): void;
  update(p: Partial<SearchTabState>): void;
  close(): void;
  setSize(size: { width: number; height: number } | null): void;
  setPreview(on: boolean): void;
}

export const useSearchDialog = create<SearchDialogStore>((set, get) => ({
  open: false,
  state: null,
  explorerKey: null,
  size: null,
  preview: true,
  show(state, explorerKey) {
    set({ open: true, state, explorerKey });
  },
  update(p) {
    const cur = get().state;
    if (cur) set({ state: { ...cur, ...p } });
  },
  close() {
    if (get().open) set({ open: false });
  },
  setSize(size) {
    set({ size });
  },
  setPreview(preview) {
    set({ preview });
  },
}));

// The saved-query dialog (Save query to schema…, New query…, Rename…): what it is open for. Tiny on purpose: the shell
// imports it to know when to load the dialog (SavedQueryDialogHost); the dialog itself is a lazy chunk.
import { create } from 'zustand';
import type { SavedQuery, SavedQueryScope } from '../../api/savedQueries';

export type SavedQueryDialogRequest =
  /** Save a console's text as a new saved query (the console is then bound to it). */
  | { mode: 'save'; tabId: string; connectionId: string; scope: SavedQueryScope; name?: string }
  /** A new, empty query in a schema ("New query…" on a Queries folder); opened in a console once created. */
  | { mode: 'new'; scope: SavedQueryScope }
  /** Rename an existing query (and edit its description). */
  | { mode: 'rename'; query: SavedQuery };

interface SavedQueryDialogStore {
  request: SavedQueryDialogRequest | null;
  open(request: SavedQueryDialogRequest): void;
  close(): void;
}

export const useSavedQueryDialog = create<SavedQueryDialogStore>((set) => ({
  request: null,
  open(request) {
    set({ request });
  },
  close() {
    set({ request: null });
  },
}));

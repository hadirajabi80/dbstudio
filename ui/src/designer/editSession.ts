// "Edit object" sessions of F4 "Edit:" consoles. The registration lives in two places: the console tab's persisted
// `edit` field (store/tabs.ts, saved with the workspace) and the in-memory designer store (read by the Compare button
// and the atomic SQLite apply). After a restart only the tab field survives; these helpers re-register it, so a
// restored "Edit:" tab still applies atomically and still offers "Compare with server".
import { getActiveTab, useTabs, type ConsoleEdit, type Tab } from '../store/tabs';
import { useDesignerUi, type EditSession } from './store';

/** Register an edit session for a console: in memory and in the tab (persisted). */
export function rememberEdit(tabId: string, s: EditSession): void {
  useDesignerUi.getState().registerEdit(tabId, s);
  useTabs.getState().setEdit(tabId, { ...s });
}

function persistedEdit(t: Tab | undefined): ConsoleEdit | null {
  return t?.kind === 'console' && t.edit && t.edit.connectionId && t.edit.ref ? t.edit : null;
}

/**
 * The edit session of a console: the in-memory one, else the one persisted in the tab (re-registered on the way).
 * undefined for ordinary consoles.
 */
export function editSessionOf(tabId: string): EditSession | undefined {
  const mem = useDesignerUi.getState().edits[tabId];
  if (mem) return mem;
  const saved = persistedEdit(useTabs.getState().tabs.find((t) => t.id === tabId));
  if (!saved) return undefined;
  const s: EditSession = { ...saved };
  useDesignerUi.getState().registerEdit(tabId, s);
  return s;
}

/** Re-register every persisted edit session that is not in memory (workspace restore, reopened tabs). */
export function restorePersistedEdits(tabs: Tab[] = useTabs.getState().tabs): void {
  const edits = useDesignerUi.getState().edits;
  for (const t of tabs) {
    const saved = persistedEdit(t);
    if (saved && !edits[t.id]) useDesignerUi.getState().registerEdit(t.id, { ...saved });
  }
}

/** The edit session of a console without registering anything (safe in render paths and command `when`s). */
export function peekEditSession(tabId: string): EditSession | undefined {
  return useDesignerUi.getState().edits[tabId] ?? persistedEdit(useTabs.getState().tabs.find((t) => t.id === tabId)) ?? undefined;
}

/** The active console's edit session (no side effects). */
export function activeEditSession(): EditSession | undefined {
  const t = getActiveTab();
  return t?.kind === 'console' ? peekEditSession(t.id) : undefined;
}

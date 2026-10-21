import { create } from 'zustand';
import type { Dialect, ObjectRef, TxMode } from '../api/types';

/**
 * The object an F4 "Edit:" console edits. Kept in the tab (and so in the workspace) so the atomic apply of SQLite
 * view/trigger edits and "Compare with server" still work after a restart.
 */
export interface ConsoleEdit {
  connectionId: string;
  database: string | null;
  ref: ObjectRef;
  dialect: Dialect;
  /** Definition on the server when the tab was opened; fetched again when missing. */
  serverDdl?: string;
  /** Editor text as opened or last saved to the database (the toolbar Save button's "unsaved changes" baseline). */
  savedText?: string;
}

/** Each console tab is bound to its own connection and database (several connections can be open at once). */
export interface ConsoleTab {
  kind: 'console';
  id: string;
  title: string;
  connectionId: string | null;
  database: string | null;
  text: string;
  /** Text as last saved to / loaded from a file; dirty = text !== savedText. */
  savedText: string;
  filePath: string | null;
  txMode: TxMode;
  /** null = settings.results.maxRows; 0 = unlimited. */
  maxRows: number | null;
  /** Set for F4 "Edit:" consoles (designer/open.ts openEditScript). */
  edit?: ConsoleEdit | null;
}

export interface ObjectTab {
  kind: 'object';
  id: string;
  title: string;
  connectionId: string;
  database: string | null;
  ref: ObjectRef;
  /** Column to highlight (F12 on a column). */
  column?: string | null;
}

/**
 * Generic tab for M1.5 views registered by other packages (data tab, designers, plan view, codegen, multi-run):
 * `view` selects the component registered with `registerTabView` (components/layout/tabViews.ts); `state` is the
 * view's own serialisable state (persisted in the workspace).
 */
export interface ViewTab {
  kind: 'view';
  id: string;
  title: string;
  view: string;
  connectionId: string | null;
  database: string | null;
  state: unknown;
  /** Re-opening with the same key activates the existing tab instead of opening a duplicate. */
  key?: string | null;
  /** Unsaved work (designers); closing asks first. */
  dirty?: boolean;
}

export type Tab = ConsoleTab | ObjectTab | ViewTab;

export interface WorkspaceData {
  version: 1;
  tabs: Tab[];
  activeId: string | null;
  seq: number;
}

export interface OpenViewOptions {
  view: string;
  title: string;
  connectionId?: string | null;
  database?: string | null;
  state?: unknown;
  key?: string | null;
  /** Default true. */
  activate?: boolean;
}

const MAX_CLOSED = 20;

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  seq: number;
  /** Most recently used first (for Ctrl+Tab). */
  mru: string[];
  /** Recently closed tabs (newest last) for Ctrl+Shift+T. */
  closed: Tab[];
  /**
   * A tab opened (or re-activated) by an open call wants its primary element focused once it is shown (the grid of a
   * data tab, the designer's first cell, the editor of a console). The shell consumes it; `seq` makes repeats distinct.
   */
  focusRequest: { tabId: string; seq: number } | null;
  /** Ask the shell to focus a tab's primary element (keyboard-opened tabs). */
  requestFocus(tabId: string): void;
  newConsole(opts?: { connectionId?: string | null; database?: string | null; text?: string; title?: string; filePath?: string | null }): string;
  openObject(connectionId: string, database: string | null, ref: ObjectRef, column?: string | null): string;
  openView(opts: OpenViewOptions): string;
  updateView(id: string, patch: Partial<Pick<ViewTab, 'title' | 'state' | 'dirty' | 'connectionId' | 'database' | 'key'>>): void;
  close(id: string): void;
  closeOthers(id: string): void;
  reopenClosed(): string | null;
  activate(id: string): void;
  activateRelative(delta: number): void;
  activateIndex(index: number): void;
  /** MRU step: 1 = previously used tab. */
  activateMru(step: number): void;
  move(fromId: string, toId: string): void;
  updateText(id: string, text: string): void;
  markSaved(id: string, filePath: string | null, title?: string): void;
  setConnection(id: string, connectionId: string | null, database?: string | null): void;
  setDatabase(id: string, database: string | null): void;
  setTxMode(id: string, mode: TxMode): void;
  setMaxRows(id: string, maxRows: number | null): void;
  rename(id: string, title: string): void;
  /** Mark a console as the "Edit:" script of an object (null: an ordinary console again). */
  setEdit(id: string, edit: ConsoleEdit | null): void;
  restore(data: WorkspaceData): void;
  serialize(): WorkspaceData;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function touchMru(mru: string[], id: string | null): string[] {
  if (!id) return mru;
  return [id, ...mru.filter((x) => x !== id)].slice(0, 50);
}

export const useTabs = create<TabsState>((set, get) => {
  const patch = (id: string, p: Partial<ConsoleTab> | Partial<ObjectTab> | Partial<ViewTab>) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? ({ ...t, ...p } as Tab) : t)) });

  let focusSeq = 0;
  const insert = (tab: Tab, activate = true) => {
    const tabs = [...get().tabs];
    const activeIdx = tabs.findIndex((t) => t.id === get().activeId);
    tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab);
    if (activate) set({ tabs, activeId: tab.id, mru: touchMru(get().mru, tab.id), focusRequest: { tabId: tab.id, seq: ++focusSeq } });
    else set({ tabs });
  };

  return {
    tabs: [],
    activeId: null,
    seq: 0,
    mru: [],
    closed: [],
    focusRequest: null,

    requestFocus(tabId) {
      set({ focusRequest: { tabId, seq: ++focusSeq } });
    },

    newConsole(opts = {}) {
      const seq = get().seq + 1;
      const id = newId('t');
      const text = opts.text ?? '';
      const tab: ConsoleTab = {
        kind: 'console', id, title: opts.title ?? `Console ${seq}`, connectionId: opts.connectionId ?? null,
        database: opts.database ?? null, text, savedText: opts.filePath ? text : '', filePath: opts.filePath ?? null,
        txMode: 'auto', maxRows: null,
      };
      set({ seq });
      insert(tab);
      return id;
    },

    openObject(connectionId, database, ref, column) {
      const existing = get().tabs.find(
        (t) => t.kind === 'object' && t.connectionId === connectionId && t.database === database
          && t.ref.schema === ref.schema && t.ref.name === ref.name && t.ref.type === ref.type,
      );
      if (existing) {
        patch(existing.id, { column: column ?? null });
        get().activate(existing.id);
        get().requestFocus(existing.id);
        return existing.id;
      }
      const id = newId('o');
      insert({ kind: 'object', id, title: ref.name, connectionId, database, ref, column: column ?? null });
      return id;
    },

    openView(o) {
      if (o.key) {
        const existing = get().tabs.find((t) => t.kind === 'view' && t.view === o.view && t.key === o.key);
        if (existing) {
          if (o.state !== undefined) patch(existing.id, { state: o.state });
          if (o.activate !== false) {
            get().activate(existing.id);
            get().requestFocus(existing.id);
          }
          return existing.id;
        }
      }
      const id = newId('v');
      insert(
        {
          kind: 'view', id, title: o.title, view: o.view, connectionId: o.connectionId ?? null, database: o.database ?? null,
          state: o.state ?? null, key: o.key ?? null, dirty: false,
        },
        o.activate !== false,
      );
      return id;
    },

    updateView(id, p) {
      const t = get().tabs.find((x) => x.id === id);
      if (t?.kind === 'view') patch(id, p);
    },

    close(id) {
      const tabs = get().tabs;
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const closedTab = tabs[idx];
      const next = tabs.filter((t) => t.id !== id);
      const mru = get().mru.filter((x) => x !== id);
      let activeId = get().activeId;
      if (activeId === id) activeId = mru.find((x) => next.some((t) => t.id === x)) ?? next[Math.min(idx, next.length - 1)]?.id ?? null;
      set({ tabs: next, activeId, mru: touchMru(mru, activeId), closed: [...get().closed, closedTab].slice(-MAX_CLOSED) });
    },

    closeOthers(id) {
      const others = get().tabs.filter((t) => t.id !== id);
      set({ tabs: get().tabs.filter((t) => t.id === id), activeId: id, mru: [id], closed: [...get().closed, ...others].slice(-MAX_CLOSED) });
    },

    reopenClosed() {
      const closed = [...get().closed];
      const tab = closed.pop();
      if (!tab) return null;
      set({ closed });
      // A fresh id: the old one may still be referenced by stale results/sessions.
      const reopened = { ...tab, id: newId(tab.kind === 'console' ? 't' : tab.kind === 'object' ? 'o' : 'v') } as Tab;
      insert(reopened);
      return reopened.id;
    },

    activate(id) {
      if (get().tabs.some((t) => t.id === id)) set({ activeId: id, mru: touchMru(get().mru, id) });
    },

    activateRelative(delta) {
      const { tabs, activeId } = get();
      if (!tabs.length) return;
      const idx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
      get().activate(tabs[(idx + delta + tabs.length) % tabs.length].id);
    },

    activateIndex(index) {
      const { tabs } = get();
      if (!tabs.length) return;
      // Ctrl+9 = last tab (browser/VS Code convention).
      const t = index >= 8 ? tabs[tabs.length - 1] : tabs[index];
      if (t) get().activate(t.id);
    },

    activateMru(step) {
      const { tabs, mru, activeId } = get();
      const order = [...mru.filter((id) => tabs.some((t) => t.id === id)), ...tabs.map((t) => t.id).filter((id) => !mru.includes(id))];
      if (order.length < 2) return;
      const cur = Math.max(0, order.indexOf(activeId ?? ''));
      const target = order[(cur + step + order.length) % order.length];
      // Activate without reordering the MRU list so repeated presses walk further back.
      if (target) set({ activeId: target });
    },

    move(fromId, toId) {
      const tabs = [...get().tabs];
      const from = tabs.findIndex((t) => t.id === fromId);
      const to = tabs.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return;
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      set({ tabs });
    },

    updateText(id, text) {
      const t = get().tabs.find((x) => x.id === id);
      if (t?.kind === 'console' && t.text !== text) patch(id, { text });
    },

    markSaved(id, filePath, title) {
      const t = get().tabs.find((x) => x.id === id);
      if (t?.kind === 'console') patch(id, { savedText: t.text, filePath, ...(title ? { title } : {}) });
    },

    setConnection(id, connectionId, database = null) {
      patch(id, { connectionId, database });
    },

    setDatabase(id, database) {
      patch(id, { database });
    },

    setTxMode(id, mode) {
      patch(id, { txMode: mode });
    },

    setMaxRows(id, maxRows) {
      patch(id, { maxRows });
    },

    rename(id, title) {
      patch(id, { title });
    },

    setEdit(id, edit) {
      const t = get().tabs.find((x) => x.id === id);
      if (t?.kind === 'console') patch(id, { edit });
    },

    restore(data) {
      if (!data || data.version !== 1 || !Array.isArray(data.tabs)) return;
      const tabs = data.tabs.filter((t) => t && (t.kind === 'console' || t.kind === 'object' || (t.kind === 'view' && typeof t.view === 'string')));
      const activeId = tabs.some((t) => t.id === data.activeId) ? data.activeId : tabs[0]?.id ?? null;
      set({ tabs, activeId, mru: activeId ? [activeId] : [], seq: Math.max(data.seq ?? 0, tabs.length) });
    },

    serialize() {
      const { tabs, activeId, seq } = get();
      return { version: 1, tabs, activeId, seq };
    },
  };
});

export function isDirty(t: Tab): boolean {
  // Consoles are persisted in the workspace automatically; only file-backed tabs can be "unsaved".
  if (t.kind === 'view') return !!t.dirty;
  return t.kind === 'console' && t.filePath !== null && t.text !== t.savedText;
}

export function useActiveTab(): Tab | undefined {
  return useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
}

export function getActiveTab(): Tab | undefined {
  const s = useTabs.getState();
  return s.tabs.find((t) => t.id === s.activeId);
}

export function getActiveConsole(): ConsoleTab | undefined {
  const t = getActiveTab();
  return t?.kind === 'console' ? t : undefined;
}

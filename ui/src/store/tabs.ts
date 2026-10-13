import { create } from 'zustand';
import type { ObjectRef, TxMode } from '../api/types';

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

export type Tab = ConsoleTab | ObjectTab;

export interface WorkspaceData {
  version: 1;
  tabs: Tab[];
  activeId: string | null;
  seq: number;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  seq: number;
  newConsole(opts?: { connectionId?: string | null; database?: string | null; text?: string; title?: string; filePath?: string | null }): string;
  openObject(connectionId: string, database: string | null, ref: ObjectRef, column?: string | null): string;
  close(id: string): void;
  closeOthers(id: string): void;
  activate(id: string): void;
  activateRelative(delta: number): void;
  move(fromId: string, toId: string): void;
  updateText(id: string, text: string): void;
  markSaved(id: string, filePath: string | null, title?: string): void;
  setConnection(id: string, connectionId: string | null, database?: string | null): void;
  setDatabase(id: string, database: string | null): void;
  setTxMode(id: string, mode: TxMode): void;
  setMaxRows(id: string, maxRows: number | null): void;
  rename(id: string, title: string): void;
  restore(data: WorkspaceData): void;
  serialize(): WorkspaceData;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export const useTabs = create<TabsState>((set, get) => {
  const patch = (id: string, p: Partial<ConsoleTab> | Partial<ObjectTab>) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? ({ ...t, ...p } as Tab) : t)) });

  return {
    tabs: [],
    activeId: null,
    seq: 0,

    newConsole(opts = {}) {
      const seq = get().seq + 1;
      const id = newId('t');
      const text = opts.text ?? '';
      const tab: ConsoleTab = {
        kind: 'console', id, title: opts.title ?? `Console ${seq}`, connectionId: opts.connectionId ?? null,
        database: opts.database ?? null, text, savedText: opts.filePath ? text : '', filePath: opts.filePath ?? null,
        txMode: 'auto', maxRows: null,
      };
      const tabs = [...get().tabs];
      const activeIdx = tabs.findIndex((t) => t.id === get().activeId);
      tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab);
      set({ tabs, activeId: id, seq });
      return id;
    },

    openObject(connectionId, database, ref, column) {
      const existing = get().tabs.find(
        (t) => t.kind === 'object' && t.connectionId === connectionId && t.database === database
          && t.ref.schema === ref.schema && t.ref.name === ref.name && t.ref.type === ref.type,
      );
      if (existing) {
        patch(existing.id, { column: column ?? null });
        set({ activeId: existing.id });
        return existing.id;
      }
      const id = newId('o');
      const tab: ObjectTab = { kind: 'object', id, title: ref.name, connectionId, database, ref, column: column ?? null };
      const tabs = [...get().tabs];
      const activeIdx = tabs.findIndex((t) => t.id === get().activeId);
      tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab);
      set({ tabs, activeId: id });
      return id;
    },

    close(id) {
      const tabs = get().tabs;
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const next = tabs.filter((t) => t.id !== id);
      let activeId = get().activeId;
      if (activeId === id) activeId = next[Math.min(idx, next.length - 1)]?.id ?? null;
      set({ tabs: next, activeId });
    },

    closeOthers(id) {
      set({ tabs: get().tabs.filter((t) => t.id === id), activeId: id });
    },

    activate(id) {
      if (get().tabs.some((t) => t.id === id)) set({ activeId: id });
    },

    activateRelative(delta) {
      const { tabs, activeId } = get();
      if (!tabs.length) return;
      const idx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
      set({ activeId: tabs[(idx + delta + tabs.length) % tabs.length].id });
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

    restore(data) {
      if (!data || data.version !== 1 || !Array.isArray(data.tabs)) return;
      const tabs = data.tabs.filter((t) => t && (t.kind === 'console' || t.kind === 'object'));
      set({
        tabs,
        activeId: tabs.some((t) => t.id === data.activeId) ? data.activeId : tabs[0]?.id ?? null,
        seq: Math.max(data.seq ?? 0, tabs.length),
      });
    },

    serialize() {
      const { tabs, activeId, seq } = get();
      return { version: 1, tabs, activeId, seq };
    },
  };
});

export function isDirty(t: Tab): boolean {
  // Consoles are persisted in the workspace automatically; only file-backed tabs can be "unsaved".
  return t.kind === 'console' && t.filePath !== null && t.text !== t.savedText;
}

export function useActiveTab(): Tab | undefined {
  return useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
}

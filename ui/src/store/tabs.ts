import { create } from 'zustand';
import type { Dialect, ObjectRef, TxMode } from '../api/types';
import {
  groupInDirection, groupOf, insertInLayout, MAX_GROUPS, newGroupId, normalizeGroups, parseSerializedGroups, removeFromLayout, sameGroups,
  type EditorGroup, type GroupLayoutNode, type GroupsState, type SerializedGroups, type SplitSide,
} from './editorGroups';

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
  /**
   * A New procedure / function / package / trigger console: the object does not exist yet. Save creates it (the name
   * is read back from the script, see designer/newObject.ts) and turns the console into an ordinary "Edit:" console.
   */
  isNew?: boolean;
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
  /**
   * A permanent tab (the Objects tab): first in the first editor group, never closed, moved, split off or detached.
   * Only the main window has one; it is added and removed by its owner (components/ObjectList/home.ts).
   */
  pinned?: boolean;
}

export type Tab = ConsoleTab | ObjectTab | ViewTab;

export interface WorkspaceData {
  version: 1;
  tabs: Tab[];
  activeId: string | null;
  seq: number;
  /** Editor groups (split editor); absent in older workspaces = one group with every tab. */
  groups?: SerializedGroups;
  /**
   * Tabs open in detached windows when the workspace was saved. Detached windows are not restored: after a restart
   * these tabs come back into the main window.
   */
  detached?: Tab[];
}

export interface RestoreOptions {
  /** Tabs that are open in another window right now (a reloaded main window): not restored here. */
  liveDetached?: Tab[];
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

interface TabsState extends GroupsState {
  tabs: Tab[];
  /** The active tab of the focused editor group (commands and shortcuts act on it). */
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
  restore(data: WorkspaceData, opts?: RestoreOptions): void;
  serialize(): WorkspaceData;

  // ---- editor groups (store/editorGroups.ts) ----
  /** Tabs living in detached windows (as reported by the main process; main window only). */
  detached: Tab[];
  /** Focus a group: its active tab becomes the globally active tab. */
  focusGroup(groupId: string): void;
  /** Move a tab into a group, before `beforeId` (null: at the end), and show it there. */
  moveTab(tabId: string, groupId: string, beforeId?: string | null): void;
  /**
   * Open a new group on `side` of `targetGroup` (default: the tab's group) and move the tab into it. With MAX_GROUPS
   * groups the tab moves to the neighbouring group on that side instead. Returns the tab's group, or null (no-op).
   */
  splitTab(tabId: string, side: SplitSide, targetGroup?: string): string | null;
  /** The group after (1) / before (-1) `groupId` in visual order (wrapping), or null with a single group. */
  neighbourGroup(groupId: string, step: 1 | -1): string | null;
  setGroupLayout(layout: GroupLayoutNode): void;
  /** Tabs arriving from another window: inserted into the focused group (fresh ids on a clash). Returns their ids. */
  adopt(tabs: Tab[], opts?: { activate?: boolean }): string[];
  /** Remove a tab without keeping it in the "recently closed" list (it moved to another window). */
  take(id: string): Tab | null;
  /** Remember tabs as recently closed (Ctrl+Shift+T), e.g. the tabs of a detached window the user closed. */
  addClosed(tabs: Tab[]): void;
  setDetached(tabs: Tab[]): void;

  // ---- pinned tabs ----
  /** Adds a pinned view tab (first in the first group); it becomes active only when no tab is. No-op when present. */
  pin(tab: Omit<ViewTab, 'pinned' | 'kind'>): void;
  /** Removes a pinned tab (not remembered as recently closed). */
  unpin(id: string): void;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function touchMru(mru: string[], id: string | null): string[] {
  if (!id) return mru;
  return [id, ...mru.filter((x) => x !== id)].slice(0, 50);
}

const TAB_PREFIX: Record<Tab['kind'], string> = { console: 't', object: 'o', view: 'v' };

/** The permanent Objects tab (and any other pinned view): never closed, moved, split off or detached. */
export function isPinnedTab(t: Tab | undefined | null): boolean {
  return !!t && t.kind === 'view' && t.pinned === true;
}

/** Tabs the user opened (everything but the pinned ones). */
export function userTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((t) => !isPinnedTab(t));
}

/** The tabs with the pinned ones first (the same array when they already are). */
function pinnedFirst(tabs: Tab[]): Tab[] {
  const pins = tabs.filter(isPinnedTab);
  if (!pins.length || pins.every((t, i) => tabs[i] === t)) return tabs;
  return [...pins, ...tabs.filter((t) => !isPinnedTab(t))];
}

type GroupInputs = Pick<TabsState, 'tabs' | 'activeId' | 'groups' | 'layout' | 'focusedGroup' | 'mru'>;

/** The groups for the store state, with `extra` overriding parts of it. */
function groupsFor(s: GroupInputs, extra: Partial<GroupInputs> = {}): GroupsState {
  const v = { ...s, ...extra };
  return normalizeGroups({
    tabIds: v.tabs.map((t) => t.id), activeId: v.activeId, groups: v.groups, layout: v.layout, focusedGroup: v.focusedGroup, mru: v.mru,
    pinned: v.tabs.filter(isPinnedTab).map((t) => t.id),
  });
}

/** Tabs of a group in strip order. */
export function groupTabs(tabs: Tab[], group: EditorGroup | undefined): Tab[] {
  if (!group) return [];
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return group.tabIds.map((id) => byId.get(id)).filter((t): t is Tab => !!t);
}

const INITIAL_GROUP = newGroupId();

export const useTabs = create<TabsState>((set, get) => {
  const patch = (id: string, p: Partial<ConsoleTab> | Partial<ObjectTab> | Partial<ViewTab>) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? ({ ...t, ...p } as Tab) : t)) });

  /** Tabs of the focused group (Ctrl+Tab, Ctrl+PageDown and Ctrl+1..9 stay inside the group). */
  const focusedTabs = (): Tab[] => {
    const s = get();
    return groupTabs(s.tabs, s.groups.find((g) => g.id === s.focusedGroup) ?? s.groups[0]);
  };

  /**
   * Removes a tab. When it was its group's shown tab, the group shows its most recently used other tab; a group left
   * empty closes and the neighbouring group takes the focus.
   */
  const removeTab = (id: string): Tab | null => {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const removed = s.tabs[idx];
    const next = s.tabs.filter((t) => t.id !== id);
    const mru = s.mru.filter((x) => x !== id);
    const fallback = () => mru.find((x) => next.some((t) => t.id === x)) ?? next[Math.min(idx, next.length - 1)]?.id ?? null;
    const group = groupOf(s.groups, id);
    let activeId = s.activeId;
    let groups = s.groups;
    if (group && group.activeId === id) {
      const siblings = group.tabIds.filter((x) => x !== id);
      const shown = mru.find((x) => siblings.includes(x)) ?? siblings[Math.min(group.tabIds.indexOf(id), siblings.length - 1)] ?? null;
      groups = s.groups.map((g) => (g.id === group.id ? { ...g, activeId: shown } : g));
      if (activeId === id) {
        if (shown) activeId = shown;
        else {
          // The group closes: the group before it in visual order (else the one after) takes the focus.
          const gi = s.groups.findIndex((g) => g.id === group.id);
          activeId = (s.groups[gi - 1] ?? s.groups[gi + 1])?.activeId ?? fallback();
        }
      }
    } else if (activeId === id) activeId = fallback();
    const nextMru = touchMru(mru, activeId);
    set({ tabs: next, activeId, mru: nextMru, ...groupsFor(s, { tabs: next, activeId, groups, mru: nextMru }) });
    return removed;
  };

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
    groups: [{ id: INITIAL_GROUP, tabIds: [], activeId: null }],
    layout: { kind: 'group', id: INITIAL_GROUP },
    focusedGroup: INITIAL_GROUP,
    detached: [],

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
      if (isPinnedTab(get().tabs.find((t) => t.id === id))) return;
      const closedTab = removeTab(id);
      if (closedTab) set({ closed: [...get().closed, closedTab].slice(-MAX_CLOSED) });
    },

    closeOthers(id) {
      // "Others" = the other tabs of the tab's group.
      const s = get();
      const group = groupOf(s.groups, id);
      if (!group) return;
      const others = s.tabs.filter((t) => t.id !== id && group.tabIds.includes(t.id) && !isPinnedTab(t));
      const tabs = s.tabs.filter((t) => !others.includes(t));
      const mru = touchMru(s.mru.filter((x) => tabs.some((t) => t.id === x)), id);
      set({ tabs, activeId: id, mru, closed: [...s.closed, ...others].slice(-MAX_CLOSED), ...groupsFor(s, { tabs, activeId: id, mru }) });
    },

    reopenClosed() {
      const closed = [...get().closed];
      const tab = closed.pop();
      if (!tab) return null;
      set({ closed });
      // A fresh id: the old one may still be referenced by stale results/sessions.
      const reopened = { ...tab, id: newId(TAB_PREFIX[tab.kind]) } as Tab;
      insert(reopened);
      return reopened.id;
    },

    activate(id) {
      if (get().tabs.some((t) => t.id === id)) set({ activeId: id, mru: touchMru(get().mru, id) });
    },

    activateRelative(delta) {
      const { activeId } = get();
      const tabs = focusedTabs();
      if (!tabs.length) return;
      const idx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
      get().activate(tabs[(idx + delta + tabs.length) % tabs.length].id);
    },

    activateIndex(index) {
      const tabs = focusedTabs();
      if (!tabs.length) return;
      // Ctrl+9 = last tab (browser/VS Code convention).
      const t = index >= 8 ? tabs[tabs.length - 1] : tabs[index];
      if (t) get().activate(t.id);
    },

    activateMru(step) {
      const { mru, activeId } = get();
      const tabs = focusedTabs();
      const order = [...mru.filter((id) => tabs.some((t) => t.id === id)), ...tabs.map((t) => t.id).filter((id) => !mru.includes(id))];
      if (order.length < 2) return;
      const cur = Math.max(0, order.indexOf(activeId ?? ''));
      const target = order[(cur + step + order.length) % order.length];
      // Activate without reordering the MRU list so repeated presses walk further back.
      if (target) set({ activeId: target });
    },

    move(fromId, toId) {
      const s = get();
      const src = groupOf(s.groups, fromId);
      const dst = groupOf(s.groups, toId);
      if (src && dst && src.id !== dst.id) {
        get().moveTab(fromId, dst.id, toId);
        return;
      }
      const tabs = [...s.tabs];
      const from = tabs.findIndex((t) => t.id === fromId);
      const to = tabs.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to || isPinnedTab(tabs[from]) || isPinnedTab(tabs[to])) return;
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

    restore(data, opts = {}) {
      if (!data || data.version !== 1 || !Array.isArray(data.tabs)) return;
      const tabs = data.tabs.filter(isRestorableTab);
      // Tabs of detached windows that are gone (the app was restarted) come back into this window.
      const live = new Set((opts.liveDetached ?? []).map((t) => t.id));
      const known = new Set(tabs.map((t) => t.id));
      for (const t of Array.isArray(data.detached) ? data.detached.filter(isRestorableTab) : []) {
        if (live.has(t.id) || known.has(t.id)) continue;
        known.add(t.id);
        tabs.push(t);
      }
      tabs.splice(0, tabs.length, ...pinnedFirst(tabs));
      const activeId = tabs.some((t) => t.id === data.activeId) ? data.activeId : tabs[0]?.id ?? null;
      const saved = parseSerializedGroups(data.groups);
      const g = normalizeGroups({
        tabIds: tabs.map((t) => t.id), activeId, groups: saved?.groups ?? null, layout: saved?.layout ?? null,
        focusedGroup: saved?.focusedGroup ?? get().focusedGroup, mru: activeId ? [activeId] : [],
        pinned: tabs.filter(isPinnedTab).map((t) => t.id),
      });
      // Every group shows the tab it showed when saved; those tabs start the MRU list.
      const mru = activeId ? [activeId, ...g.groups.map((x) => x.activeId).filter((x): x is string => !!x && x !== activeId)] : [];
      set({ tabs, activeId, mru, seq: Math.max(data.seq ?? 0, tabs.length), ...g, detached: opts.liveDetached ?? [] });
    },

    serialize() {
      const { tabs, activeId, seq, groups, layout, focusedGroup, detached } = get();
      const data: WorkspaceData = { version: 1, tabs, activeId, seq };
      if (groups.length > 1) data.groups = { groups, layout, focusedGroup };
      if (detached.length) data.detached = detached;
      return data;
    },

    focusGroup(groupId) {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g) return;
      if (g.activeId) get().activate(g.activeId);
      else set({ focusedGroup: groupId });
    },

    moveTab(tabId, groupId, beforeId = null) {
      const s = get();
      const target = s.groups.find((g) => g.id === groupId);
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!target || !tab || isPinnedTab(tab)) return;
      const rest = s.tabs.filter((t) => t.id !== tabId);
      let at: number;
      if (beforeId && beforeId !== tabId && target.tabIds.includes(beforeId)) at = rest.findIndex((t) => t.id === beforeId);
      else {
        // After the group's last tab (a group with no other tab: where the tab already is).
        const others = target.tabIds.filter((id) => id !== tabId);
        at = others.length ? rest.findIndex((t) => t.id === others[others.length - 1]) + 1 : s.tabs.findIndex((t) => t.id === tabId);
      }
      const tabs = [...rest];
      tabs.splice(Math.max(0, Math.min(rest.length, at)), 0, tab);
      const groups = s.groups.map((g) => ({
        ...g,
        tabIds: g.id === groupId ? [...g.tabIds.filter((id) => id !== tabId), tabId] : g.tabIds.filter((id) => id !== tabId),
        activeId: g.id === groupId ? tabId : g.activeId === tabId ? null : g.activeId,
      }));
      const mru = touchMru(s.mru, tabId);
      set({ tabs, activeId: tabId, mru, ...groupsFor(s, { tabs, activeId: tabId, groups, focusedGroup: groupId, mru }) });
    },

    splitTab(tabId, side, targetGroup) {
      const s = get();
      const own = groupOf(s.groups, tabId);
      if (!own || isPinnedTab(s.tabs.find((t) => t.id === tabId))) return null;
      const anchor = targetGroup ?? own.id;
      if (!s.groups.some((g) => g.id === anchor)) return null;
      const alone = own.tabIds.length < 2;
      if (alone && anchor === own.id) {
        // The only tab of its group: nothing to split off. With other groups, the group itself moves to that side.
        const other = groupInDirection(s.layout, own.id, side);
        const without = other ? removeFromLayout(s.layout, own.id) : null;
        if (!other || !without) return null;
        set({ ...groupsFor(s, { layout: insertInLayout(without, other, own.id, side) }) });
        return own.id;
      }
      if (s.groups.length >= MAX_GROUPS) {
        // No room for another group: the tab moves to the neighbour on that side (or into the target group).
        const dest = anchor !== own.id ? groupInDirection(s.layout, anchor, side) ?? anchor : groupInDirection(s.layout, anchor, side);
        if (!dest || dest === own.id) return null;
        get().moveTab(tabId, dest);
        return dest;
      }
      const gid = newGroupId();
      const layout = insertInLayout(s.layout, anchor, gid, side);
      const groups = [...s.groups.map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => id !== tabId) })), { id: gid, tabIds: [tabId], activeId: tabId }];
      const mru = touchMru(s.mru, tabId);
      set({ activeId: tabId, mru, ...groupsFor(s, { activeId: tabId, groups, layout, focusedGroup: gid, mru }) });
      return gid;
    },

    neighbourGroup(groupId, step) {
      const ids = get().groups.map((g) => g.id);
      const i = ids.indexOf(groupId);
      if (i < 0 || ids.length < 2) return null;
      return ids[(i + step + ids.length) % ids.length];
    },

    setGroupLayout(layout) {
      set({ ...groupsFor(get(), { layout }) });
    },

    adopt(incoming, opts = {}) {
      const s = get();
      const ids = new Set(s.tabs.map((t) => t.id));
      const tabs = [...s.tabs];
      const added: string[] = [];
      const activeIdx = tabs.findIndex((t) => t.id === s.activeId);
      let at = activeIdx >= 0 ? activeIdx + 1 : tabs.length;
      for (const raw of incoming) {
        // Pinned tabs belong to their window: another window never hands over its Objects tab.
        if (!isRestorableTab(raw) || isPinnedTab(raw)) continue;
        const tab = (ids.has(raw.id) ? { ...raw, id: newId(TAB_PREFIX[raw.kind]) } : raw) as Tab;
        ids.add(tab.id);
        tabs.splice(at++, 0, tab);
        added.push(tab.id);
      }
      if (!added.length) return added;
      const activate = opts.activate !== false;
      const activeId = activate ? added[added.length - 1] : s.activeId;
      const groups = s.groups.map((g) => (g.id === s.focusedGroup ? { ...g, tabIds: [...g.tabIds, ...added] } : g));
      const mru = activate ? touchMru(s.mru, activeId) : s.mru;
      set({
        tabs, activeId, mru, ...groupsFor(s, { tabs, activeId, groups, mru }),
        detached: s.detached.filter((t) => !added.includes(t.id)),
        ...(activate && activeId ? { focusRequest: { tabId: activeId, seq: ++focusSeq } } : {}),
      });
      return added;
    },

    take(id) {
      if (isPinnedTab(get().tabs.find((t) => t.id === id))) return null;
      return removeTab(id);
    },

    addClosed(tabs) {
      const valid = tabs.filter((t) => isRestorableTab(t) && !isPinnedTab(t));
      if (valid.length) set({ closed: [...get().closed, ...valid].slice(-MAX_CLOSED) });
    },

    setDetached(tabs) {
      set({ detached: tabs.filter(isRestorableTab) });
    },

    pin(t) {
      const s = get();
      if (s.tabs.some((x) => x.id === t.id)) return;
      const tab: ViewTab = { ...t, kind: 'view', pinned: true };
      const tabs = [tab, ...s.tabs];
      const activeId = s.activeId && s.tabs.some((x) => x.id === s.activeId) ? s.activeId : tab.id;
      const mru = s.mru.includes(activeId) ? s.mru : touchMru(s.mru, activeId);
      set({ tabs, activeId, mru, ...groupsFor(s, { tabs, activeId, mru }) });
    },

    unpin(id) {
      if (isPinnedTab(get().tabs.find((t) => t.id === id))) removeTab(id);
    },
  };
});

/** A tab from a workspace file or another window that this build can show. */
export function isRestorableTab(t: unknown): t is Tab {
  if (!t || typeof t !== 'object') return false;
  const o = t as Partial<Tab>;
  return typeof o.id === 'string' && !!o.id && (o.kind === 'console' || o.kind === 'object' || (o.kind === 'view' && typeof (o as ViewTab).view === 'string'));
}

/**
 * Keeps the groups consistent with the tabs after any change, including `useTabs.setState({ tabs })` from outside the
 * store (tests, older callers): new tabs join the focused group, removed ones leave theirs, empty groups close.
 */
useTabs.subscribe((s) => {
  // Pinned tabs stay first (a drop or an insert before them, a `setState` from outside).
  const tabs = pinnedFirst(s.tabs);
  const g = groupsFor(s, { tabs });
  if (tabs !== s.tabs) useTabs.setState({ tabs, ...g });
  else if (!sameGroups(g, s)) useTabs.setState(g);
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

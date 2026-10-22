// Explorer UI state (expansion, filter, chips, selection). Separate from the component so commands can read
// the current selection without importing React code.
import { create } from 'zustand';
import type { CommandTarget, ObjectTarget } from '../../commands/types';

const EXPANDED_KEY = 'dbstudio.explorer.expanded.v1';
const CHIPS_KEY = 'dbstudio.explorer.chips.v2';

/** Explorer type chips (1.1.2). "other" = sequences, synonyms, packages, types, triggers, table functions. */
export type TypeChip = 'tables' | 'views' | 'procs' | 'funcs' | 'other';
export const TYPE_CHIPS: { id: TypeChip; label: string }[] = [
  { id: 'tables', label: 'Tables' },
  { id: 'views', label: 'Views' },
  { id: 'procs', label: 'Procs' },
  { id: 'funcs', label: 'Funcs' },
  { id: 'other', label: 'Other' },
];

/** The global scope of the type chips. */
export const ALL_CONNECTIONS = '*';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** "*" = every connection; at most one other key: the connection of the explicit override. */
type ChipMap = Record<string, TypeChip[]>;

interface StoredChips {
  chips: ChipMap;
  scope: string;
}

function loadChips(): StoredChips {
  const s = loadJson<StoredChips | null>(CHIPS_KEY, null);
  if (!s || typeof s !== 'object' || !s.chips) return { chips: { [ALL_CONNECTIONS]: [] }, scope: ALL_CONNECTIONS };
  const scope = typeof s.scope === 'string' && s.chips[s.scope] ? s.scope : ALL_CONNECTIONS;
  const chips: ChipMap = { [ALL_CONNECTIONS]: s.chips[ALL_CONNECTIONS] ?? [] };
  if (scope !== ALL_CONNECTIONS) chips[scope] = s.chips[scope];
  return { chips, scope };
}

const initialChips = loadChips();

interface ExplorerState {
  expanded: Set<string>;
  collapsedFolders: Set<string>;
  filter: string;
  /** Selected chips (empty = all types): "*" for every connection, plus the explicit per-connection override. */
  chips: ChipMap;
  /**
   * "*" (default): the chips apply to every connection. A connection id: an explicit, visible override
   * ("in <conn> ×") — the chips apply to that connection only. Selection never changes it.
   */
  chipScope: string;
  searchColumns: boolean;
  selected: string | null;
  /** Target of the selected node (for commands run from the palette / shortcuts). */
  selectedTarget: CommandTarget | null;
  /** Incremented to ask the component to focus the filter box (Ctrl+F). */
  focusFilterSeq: number;
  /** Incremented to ask the component to focus the tree. */
  focusTreeSeq: number;
  toggle(id: string, open?: boolean): void;
  expandAll(ids: string[]): void;
  toggleFolder(f: string): void;
  collapseAll(): void;
  setFilter(f: string): void;
  toggleChip(chip: TypeChip): void;
  clearChips(): void;
  /** Explicit override: chips apply only to `connectionId` ("*" = back to every connection). */
  scopeChipsTo(connectionId: string): void;
  /** A connection was deleted: drop its override (the chips go back to every connection). */
  forgetConnection(connectionId: string): void;
  setSearchColumns(v: boolean): void;
  select(id: string | null, target?: CommandTarget | null): void;
  focusFilter(): void;
  focusTree(): void;
  /** Expand the ancestors of an object, select it and scroll it into view (palette Alt+Enter). */
  reveal(t: ObjectTarget): void;
  /** Expand `ancestors`, select the node and scroll it into view, leaving the focus where it is (Objects tab drill-down). */
  selectNode(id: string, target: CommandTarget, ancestors: string[]): void;
  revealSeq: number;
}

export const useExplorer = create<ExplorerState>((set, get) => {
  const persistChips = () => save(CHIPS_KEY, { chips: get().chips, scope: get().chipScope } satisfies StoredChips);
  return {
    expanded: new Set(loadJson<string[]>(EXPANDED_KEY, [])),
    collapsedFolders: new Set(),
    filter: '',
    chips: initialChips.chips,
    chipScope: initialChips.scope,
    searchColumns: false,
    selected: null,
    selectedTarget: null,
    focusFilterSeq: 0,
    focusTreeSeq: 0,
    revealSeq: 0,
    toggle(id, open) {
      const next = new Set(get().expanded);
      const willOpen = open ?? !next.has(id);
      if (willOpen) next.add(id);
      else next.delete(id);
      set({ expanded: next });
      save(EXPANDED_KEY, [...next].slice(-500));
    },
    expandAll(ids) {
      const next = new Set(get().expanded);
      for (const id of ids) next.add(id);
      set({ expanded: next });
      save(EXPANDED_KEY, [...next].slice(-500));
    },
    toggleFolder(f) {
      const next = new Set(get().collapsedFolders);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      set({ collapsedFolders: next });
    },
    collapseAll() {
      set({ expanded: new Set() });
      try {
        localStorage.removeItem(EXPANDED_KEY);
      } catch {
        /* ignore */
      }
    },
    setFilter(f) {
      set({ filter: f });
    },
    toggleChip(chip) {
      const scope = get().chipScope;
      const cur = get().chips[scope] ?? [];
      const next = cur.includes(chip) ? cur.filter((c) => c !== chip) : [...cur, chip];
      set({ chips: { ...get().chips, [scope]: next } });
      persistChips();
    },
    clearChips() {
      set({ chips: { ...get().chips, [get().chipScope]: [] } });
      persistChips();
    },
    scopeChipsTo(connectionId) {
      const cur = get();
      if (connectionId === cur.chipScope) return;
      const global = cur.chips[ALL_CONNECTIONS] ?? [];
      if (connectionId === ALL_CONNECTIONS) {
        set({ chips: { [ALL_CONNECTIONS]: global }, chipScope: ALL_CONNECTIONS });
      } else {
        // The override starts from what is shown now; only one connection can be scoped at a time.
        const start = cur.chips[cur.chipScope] ?? global;
        set({ chips: { [ALL_CONNECTIONS]: global, [connectionId]: [...start] }, chipScope: connectionId });
      }
      persistChips();
    },
    forgetConnection(connectionId) {
      const cur = get();
      const sel = cur.selectedTarget && 'connectionId' in cur.selectedTarget && cur.selectedTarget.connectionId === connectionId;
      if (cur.chipScope === connectionId) get().scopeChipsTo(ALL_CONNECTIONS);
      if (sel) set({ selected: null, selectedTarget: null });
    },
    setSearchColumns(v) {
      set({ searchColumns: v });
    },
    select(id, target) {
      // Never moves the chip scope: chips only change through the visible chip row.
      set({ selected: id, selectedTarget: target === undefined ? get().selectedTarget : target });
    },
    focusFilter() {
      set({ focusFilterSeq: get().focusFilterSeq + 1 });
    },
    focusTree() {
      set({ focusTreeSeq: get().focusTreeSeq + 1 });
    },
    reveal(t) {
      const { connectionId: c, database: db, ref } = t;
      const d = db ?? '';
      const s = ref.schema ?? '';
      const ids = [`c:${c}`, `d:${c}:${d}`, `s:${c}:${d}:${s}`, `f:${c}:${d}:${s}:${ref.type}`];
      get().expandAll(ids);
      const id = `o:${c}:${d}:${s}:${ref.type}:${ref.name}`;
      set({ filter: '', selected: id, selectedTarget: t, revealSeq: get().revealSeq + 1, focusTreeSeq: get().focusTreeSeq + 1 });
    },
    selectNode(id, target, ancestors) {
      if (ancestors.length) get().expandAll(ancestors);
      set({ selected: id, selectedTarget: target, revealSeq: get().revealSeq + 1 });
    },
  };
});

/** Chips shown in the chip row (those of the current scope). */
export function activeChips(s: Pick<ExplorerState, 'chips' | 'chipScope'>): TypeChip[] {
  return s.chips[s.chipScope] ?? [];
}

/** Chips that filter a connection's tree: the override when the connection is scoped, else the global chips. */
export function chipsFor(s: Pick<ExplorerState, 'chips' | 'chipScope'>, connectionId: string): TypeChip[] {
  return s.chipScope === connectionId ? s.chips[connectionId] ?? [] : s.chips[ALL_CONNECTIONS] ?? [];
}

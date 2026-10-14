// Explorer UI state (expansion, filter, chips, selection). Separate from the component so commands can read
// the current selection without importing React code.
import { create } from 'zustand';
import type { CommandTarget, ObjectTarget } from '../../commands/types';

const EXPANDED_KEY = 'dbstudio.explorer.expanded.v1';
const CHIPS_KEY = 'dbstudio.explorer.chips.v1';

/** Explorer type chips (1.1.2). "other" = sequences, synonyms, packages, types, triggers, table functions. */
export type TypeChip = 'tables' | 'views' | 'procs' | 'funcs' | 'other';
export const TYPE_CHIPS: { id: TypeChip; label: string }[] = [
  { id: 'tables', label: 'Tables' },
  { id: 'views', label: 'Views' },
  { id: 'procs', label: 'Procs' },
  { id: 'funcs', label: 'Funcs' },
  { id: 'other', label: 'Other' },
];

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

/** Per connection id; "*" is used when no connection is focused. */
type ChipMap = Record<string, TypeChip[]>;

interface ExplorerState {
  expanded: Set<string>;
  collapsedFolders: Set<string>;
  filter: string;
  /** Selected chips (empty = all types), persisted per connection. */
  chips: ChipMap;
  /** Connection whose chips are shown (the selected node's connection). */
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
  setSearchColumns(v: boolean): void;
  select(id: string | null, target?: CommandTarget | null): void;
  focusFilter(): void;
  focusTree(): void;
  /** Expand the ancestors of an object, select it and scroll it into view (palette Alt+Enter). */
  reveal(t: ObjectTarget): void;
  revealSeq: number;
}

export const useExplorer = create<ExplorerState>((set, get) => ({
  expanded: new Set(loadJson<string[]>(EXPANDED_KEY, [])),
  collapsedFolders: new Set(),
  filter: '',
  chips: loadJson<ChipMap>(CHIPS_KEY, {}),
  chipScope: '*',
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
    const chips = { ...get().chips, [scope]: next };
    set({ chips });
    save(CHIPS_KEY, chips);
  },
  clearChips() {
    const chips = { ...get().chips, [get().chipScope]: [] };
    set({ chips });
    save(CHIPS_KEY, chips);
  },
  setSearchColumns(v) {
    set({ searchColumns: v });
  },
  select(id, target) {
    const t = target === undefined ? get().selectedTarget : target;
    const cid = t && 'connectionId' in t ? t.connectionId : null;
    set({ selected: id, selectedTarget: t, ...(cid ? { chipScope: cid } : {}) });
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
    set({ filter: '', selected: id, selectedTarget: t, chipScope: c, revealSeq: get().revealSeq + 1, focusTreeSeq: get().focusTreeSeq + 1 });
  },
}));

export function activeChips(s: Pick<ExplorerState, 'chips' | 'chipScope'>): TypeChip[] {
  return s.chips[s.chipScope] ?? [];
}

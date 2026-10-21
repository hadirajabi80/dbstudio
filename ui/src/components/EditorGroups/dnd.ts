// Tab drag and drop (HTML5 DnD): reorder within a strip, move between groups, split by dropping on a group's edge,
// detach by dropping outside the window. The drag state is shared by every tab strip and group body of the window.
import { create } from 'zustand';
import type { DropZone } from '../../store/editorGroups';

/** DataTransfer type of a tab drag inside one window (the payload is the tab id). */
export const TAB_MIME = 'application/x-dbstudio-tab';

export type DropTarget =
  | { kind: 'tab'; groupId: string; tabId: string; side: 'before' | 'after' }
  | { kind: 'strip'; groupId: string }
  | { kind: 'zone'; groupId: string; zone: DropZone };

interface TabDragState {
  /** The tab being dragged (null: no drag in progress). */
  tabId: string | null;
  /** Its group when the drag started. */
  fromGroup: string | null;
  /** Last drop zone shown per group: the highlight fades out where it was. */
  lastZones: Record<string, DropZone>;
  /** Where it would land; null while the pointer is over nothing that accepts it. */
  over: DropTarget | null;
  start(tabId: string, groupId: string): void;
  setOver(over: DropTarget | null): void;
  end(): void;
}

export const useTabDrag = create<TabDragState>((set, get) => ({
  tabId: null,
  fromGroup: null,
  over: null,
  lastZones: {},
  start(tabId, groupId) {
    set({ tabId, fromGroup: groupId, over: null, lastZones: {} });
  },
  setOver(over) {
    const cur = get().over;
    if (sameTarget(cur, over)) return;
    set(over?.kind === 'zone' ? { over, lastZones: { ...get().lastZones, [over.groupId]: over.zone } } : { over });
  },
  end() {
    set({ tabId: null, fromGroup: null, over: null, lastZones: {} });
  },
}));

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.groupId !== b.groupId) return false;
  if (a.kind === 'tab' && b.kind === 'tab') return a.tabId === b.tabId && a.side === b.side;
  if (a.kind === 'zone' && b.kind === 'zone') return a.zone === b.zone;
  return true;
}

/** True while a tab of this window is being dragged (files or text dragged in from outside are not tabs). */
export function isTabDrag(): boolean {
  return !!useTabDrag.getState().tabId;
}

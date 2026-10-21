// Editor group and window commands (split editor, move between groups, detach to a window). Auto-registered by
// commands/index.ts; the tab context menu lists them (commands/menuModel.ts `tab`).
import { closeTab } from '../../app/actions';
import { canDetachTabs, canReattachTabs, detachTab, reattachTab } from '../../app/detach';
import { registerCommands, type Command } from '../../commands/registry';
import { isTabTarget } from '../../commands/types';
import { groupInDirection, groupOf, MAX_GROUPS, type SplitSide } from '../../store/editorGroups';
import { useTabs } from '../../store/tabs';

function tabIdOf(args: unknown): string | null {
  return isTabTarget(args) ? args.tabId : useTabs.getState().activeId;
}

/** True when splitting the tab towards `side` would change anything (see useTabs.splitTab). */
export function canSplit(tabId: string | null, side: SplitSide): boolean {
  if (!tabId) return false;
  const s = useTabs.getState();
  const own = groupOf(s.groups, tabId);
  if (!own) return false;
  if (own.tabIds.length < 2) return !!groupInDirection(s.layout, own.id, side);
  if (s.groups.length >= MAX_GROUPS) {
    const dest = groupInDirection(s.layout, own.id, side);
    return !!dest && dest !== own.id;
  }
  return true;
}

function split(args: unknown, side: SplitSide): void {
  const id = tabIdOf(args);
  if (!id) return;
  if (useTabs.getState().splitTab(id, side)) useTabs.getState().requestFocus(id);
}

function groupIdOf(args: unknown): string | null {
  const s = useTabs.getState();
  const id = isTabTarget(args) ? args.tabId : null;
  return (id ? groupOf(s.groups, id)?.id : null) ?? s.focusedGroup;
}

const multi = () => useTabs.getState().groups.length > 1;

export const EDITOR_GROUP_COMMANDS: Command<never>[] = [
  {
    id: 'view.splitRight', title: 'Split right', category: 'View', icon: 'Columns2', shortcut: 'Mod+\\', keywords: 'side by side editor group',
    when: (a?: unknown) => canSplit(tabIdOf(a), 'right'), run: (a?: unknown) => split(a, 'right'),
  },
  {
    id: 'view.splitDown', title: 'Split down', category: 'View', icon: 'Rows2', keywords: 'stacked editor group below',
    when: (a?: unknown) => canSplit(tabIdOf(a), 'down'), run: (a?: unknown) => split(a, 'down'),
  },
  {
    id: 'view.moveTabToNextGroup', title: 'Move tab to the next group', category: 'View', icon: 'ArrowRightLeft', keywords: 'editor group',
    when: (a?: unknown) => multi() && !!tabIdOf(a),
    run: (a?: unknown) => {
      const id = tabIdOf(a);
      const s = useTabs.getState();
      const from = id ? groupOf(s.groups, id) : undefined;
      const to = from ? s.neighbourGroup(from.id, 1) : null;
      if (!id || !to) return;
      s.moveTab(id, to);
      s.requestFocus(id);
    },
  },
  {
    id: 'view.focusNextGroup', title: 'Focus next editor group', category: 'View', icon: 'ArrowRightLeft', keywords: 'split',
    when: multi,
    run: () => {
      const s = useTabs.getState();
      const to = s.neighbourGroup(s.focusedGroup, 1);
      if (!to) return;
      s.focusGroup(to);
      const id = useTabs.getState().activeId;
      if (id) useTabs.getState().requestFocus(id);
    },
  },
  {
    id: 'view.focusPrevGroup', title: 'Focus previous editor group', category: 'View', icon: 'ArrowRightLeft', keywords: 'split',
    when: multi,
    run: () => {
      const s = useTabs.getState();
      const to = s.neighbourGroup(s.focusedGroup, -1);
      if (!to) return;
      s.focusGroup(to);
      const id = useTabs.getState().activeId;
      if (id) useTabs.getState().requestFocus(id);
    },
  },
  {
    id: 'view.closeGroup', title: 'Close group', category: 'View', icon: 'X', keywords: 'editor group tabs',
    when: multi,
    run: async (a?: unknown) => {
      const gid = groupIdOf(a);
      const g = useTabs.getState().groups.find((x) => x.id === gid);
      // One at a time: each tab may ask first (unsaved file, open transaction).
      for (const id of [...(g?.tabIds ?? [])]) await closeTab(id);
    },
  },
  {
    id: 'view.joinGroups', title: 'Join all editor groups', category: 'View', icon: 'Layers', keywords: 'merge split single group',
    when: multi,
    run: () => {
      const s = useTabs.getState();
      const target = s.focusedGroup;
      for (const g of s.groups) {
        if (g.id === target) continue;
        for (const id of g.tabIds) useTabs.getState().moveTab(id, target);
      }
      if (s.activeId) useTabs.getState().activate(s.activeId);
    },
  },
  {
    id: 'view.openInNewWindow', title: 'Open in new window', category: 'View', icon: 'SquareArrowOutUpRight', keywords: 'detach undock separate window',
    when: (a?: unknown) => canDetachTabs() && !!tabIdOf(a),
    run: (a?: unknown) => {
      const id = tabIdOf(a);
      if (id) void detachTab(id);
    },
  },
  {
    id: 'view.reattachTab', title: 'Move back to main window', category: 'View', icon: 'SquareArrowOutDownLeft', keywords: 'attach dock window',
    when: (a?: unknown) => canReattachTabs() && !!tabIdOf(a),
    run: (a?: unknown) => {
      const id = tabIdOf(a);
      if (id) void reattachTab(id);
    },
  },
];

export function registerEditorGroupCommands(): () => void {
  return registerCommands(EDITOR_GROUP_COMMANDS);
}

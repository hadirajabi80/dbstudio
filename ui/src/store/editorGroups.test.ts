// Editor groups (split editor): the pure layout/group reducers and the group-aware tabs store (split, move, close,
// auto-collapse, focus, Ctrl+Tab scope, workspace round trip, old workspaces).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeLayout, dropZoneAt, groupInDirection, insertInLayout, isDragOutsideWindow, layoutGroupIds, MAX_GROUPS, normalizeGroups, normalizeLayout,
  removeFromLayout, resizeSizes, setSplitSizes, type GroupLayoutNode,
} from './editorGroups';
import { useTabs, type ConsoleTab, type Tab, type WorkspaceData } from './tabs';

const leaf = (id: string): GroupLayoutNode => ({ kind: 'group', id });

describe('layout tree', () => {
  it('splits a leaf, inserts siblings in the same direction and nests the other direction', () => {
    let l = insertInLayout(leaf('a'), 'a', 'b', 'right');
    expect(l).toEqual({ kind: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] });
    l = insertInLayout(l, 'a', 'c', 'left');
    expect(layoutGroupIds(l)).toEqual(['c', 'a', 'b']);
    expect(l.kind === 'split' && l.sizes).toEqual([0.25, 0.25, 0.5]);
    const nested = insertInLayout(insertInLayout(leaf('a'), 'a', 'b', 'right'), 'b', 'c', 'down');
    expect(nested).toEqual({
      kind: 'split', dir: 'row', sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', dir: 'column', children: [leaf('b'), leaf('c')], sizes: [0.5, 0.5] }],
    });
  });

  it('removing a group gives its space to the neighbours and collapses single-child splits', () => {
    const nested = insertInLayout(insertInLayout(leaf('a'), 'a', 'b', 'right'), 'b', 'c', 'down');
    expect(removeFromLayout(nested, 'c')).toEqual({ kind: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] });
    expect(removeFromLayout(removeFromLayout(nested, 'c')!, 'b')).toEqual(leaf('a'));
    expect(removeFromLayout(leaf('a'), 'a')).toBeNull();
  });

  it('normalizeLayout drops unknown or duplicate leaves, appends missing groups and repairs sizes', () => {
    const raw = { kind: 'split', dir: 'row', sizes: [3, 'x'], children: [leaf('a'), leaf('zzz'), leaf('a')] };
    expect(normalizeLayout(raw, ['a', 'b'])).toEqual({ kind: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] });
    expect(normalizeLayout('garbage', ['a'])).toEqual(leaf('a'));
    expect(normalizeLayout(null, ['a', 'b', 'c'])).toEqual({ kind: 'split', dir: 'row', children: [leaf('a'), leaf('b'), leaf('c')], sizes: [1 / 3, 1 / 3, 1 / 3] });
  });

  it('computes rects and splitters; resizing keeps a minimum share', () => {
    const l = setSplitSizes(insertInLayout(insertInLayout(leaf('a'), 'a', 'b', 'right'), 'b', 'c', 'down'), [], [0.6, 0.4]);
    const { rects, splitters } = computeLayout(l);
    expect(rects.a).toEqual({ x: 0, y: 0, w: 0.6, h: 1 });
    expect(rects.b.x).toBeCloseTo(0.6);
    expect(rects.c).toMatchObject({ y: 0.5, h: 0.5 });
    expect(splitters.map((s) => [s.dir, s.path, s.index])).toEqual([['row', [], 0], ['column', [1], 0]]);
    const big = resizeSizes([0.5, 0.5], 0, 0.9);
    expect(big[0]).toBeCloseTo(0.88);
    expect(big[1]).toBeCloseTo(0.12);
    const small = resizeSizes([0.5, 0.5], 0, -0.1);
    expect(small[0]).toBeCloseTo(0.4);
    expect(small[1]).toBeCloseTo(0.6);
    expect(groupInDirection(l, 'a', 'right')).toBe('b');
    expect(groupInDirection(l, 'c', 'up')).toBe('b');
    expect(groupInDirection(l, 'c', 'left')).toBe('a');
    expect(groupInDirection(l, 'a', 'left')).toBeNull();
  });
});

describe('normalizeGroups', () => {
  it('without saved groups: one group with every tab (old workspaces)', () => {
    const g = normalizeGroups({ tabIds: ['a', 'b', 'c'], activeId: 'b' });
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]).toMatchObject({ tabIds: ['a', 'b', 'c'], activeId: 'b' });
    expect(g.layout).toEqual(leaf(g.groups[0].id));
  });

  it('drops missing tabs, closes empty groups, assigns new tabs to the active tab\'s group, follows the tab order', () => {
    const g = normalizeGroups({
      tabIds: ['c', 'a', 'n', 'b'], activeId: 'b',
      groups: [{ id: 'g1', tabIds: ['a', 'gone'], activeId: 'gone' }, { id: 'g2', tabIds: ['c', 'b'], activeId: 'c' }, { id: 'g3', tabIds: ['x'], activeId: 'x' }],
      layout: { kind: 'split', dir: 'row', children: [leaf('g1'), leaf('g2'), leaf('g3')], sizes: [1, 1, 1] },
      focusedGroup: 'g1', mru: ['b', 'a'],
    });
    expect(g.groups.map((x) => [x.id, x.tabIds, x.activeId])).toEqual([['g1', ['a'], 'a'], ['g2', ['c', 'n', 'b'], 'b']]);
    expect(g.focusedGroup).toBe('g2');
    expect(layoutGroupIds(g.layout)).toEqual(['g1', 'g2']);
  });

  it('caps the number of groups', () => {
    const groups = Array.from({ length: MAX_GROUPS + 2 }, (_, i) => ({ id: `g${i}`, tabIds: [`t${i}`], activeId: `t${i}` }));
    const g = normalizeGroups({ tabIds: groups.map((x) => x.tabIds[0]), activeId: 't0', groups });
    expect(g.groups).toHaveLength(MAX_GROUPS);
    expect(g.groups.flatMap((x) => x.tabIds).sort()).toEqual(groups.map((x) => x.tabIds[0]).sort());
  });
});

describe('drag and drop helpers', () => {
  it('drop zones: edges split, the middle moves, splitting can be disallowed', () => {
    expect(dropZoneAt(0.5, 0.5, true)).toBe('center');
    expect(dropZoneAt(0.05, 0.5, true)).toBe('left');
    expect(dropZoneAt(0.95, 0.4, true)).toBe('right');
    expect(dropZoneAt(0.5, 0.1, true)).toBe('up');
    expect(dropZoneAt(0.6, 0.97, true)).toBe('down');
    expect(dropZoneAt(0.95, 0.5, false)).toBe('center');
  });

  it('a drag that ends outside the window with no drop target detaches; unknown (0, 0) positions never do', () => {
    expect(isDragOutsideWindow({ clientX: -40, clientY: 200, dropEffect: 'none' }, 1200, 800)).toBe(true);
    expect(isDragOutsideWindow({ clientX: 600, clientY: 900, dropEffect: 'none' }, 1200, 800)).toBe(true);
    expect(isDragOutsideWindow({ clientX: 600, clientY: 400, dropEffect: 'none' }, 1200, 800)).toBe(false);
    expect(isDragOutsideWindow({ clientX: -40, clientY: 200, dropEffect: 'move' }, 1200, 800)).toBe(false);
    expect(isDragOutsideWindow({ clientX: 0, clientY: 0, dropEffect: 'none' }, 1200, 800)).toBe(false);
    expect(isDragOutsideWindow({ clientX: 1202, clientY: 10, dropEffect: 'none' }, 1200, 800)).toBe(false);
  });
});

const con = (id: string): ConsoleTab => ({
  kind: 'console', id, title: id, connectionId: null, database: null, text: '', savedText: '', filePath: null, txMode: 'auto', maxRows: null,
});

function reset(ids: string[], active = ids[0] ?? null) {
  useTabs.setState({ tabs: ids.map(con), activeId: active, mru: active ? [active] : [], closed: [], detached: [], groups: [], focusedGroup: '' });
}

const ids = (tabs: Tab[]) => tabs.map((t) => t.id);
const groupIds = () => useTabs.getState().groups.map((g) => g.tabIds);

describe('useTabs with editor groups', () => {
  beforeEach(() => reset(['a', 'b', 'c']));

  it('setState from outside keeps one consistent group', () => {
    expect(groupIds()).toEqual([['a', 'b', 'c']]);
    expect(useTabs.getState().groups[0].activeId).toBe('a');
  });

  it('split right moves the tab into a new focused group; new tabs open in the focused group', () => {
    const gid = useTabs.getState().splitTab('b', 'right');
    const s = useTabs.getState();
    expect(gid).toBe(s.focusedGroup);
    expect(groupIds()).toEqual([['a', 'c'], ['b']]);
    expect(s.activeId).toBe('b');
    expect(s.groups[0].activeId).toBe('a');
    expect(s.layout.kind === 'split' && s.layout.dir).toBe('row');
    const n = useTabs.getState().newConsole();
    expect(groupIds()[1]).toEqual(['b', n]);
    expect(useTabs.getState().activeId).toBe(n);
  });

  it('activating a tab of another group focuses that group; Ctrl+Tab and Ctrl+PageDown stay inside the group', () => {
    useTabs.getState().splitTab('b', 'right');
    useTabs.getState().splitTab('c', 'down', useTabs.getState().groups[0].id);
    // Visual order: [a above c] | b
    expect(groupIds()).toEqual([['a'], ['c'], ['b']]);
    useTabs.getState().activate('a');
    const g0 = useTabs.getState().groups.find((g) => g.tabIds.includes('a'))!;
    expect(useTabs.getState().focusedGroup).toBe(g0.id);
    useTabs.getState().activateRelative(1);
    expect(useTabs.getState().activeId).toBe('a'); // the only tab of its group
  });

  it('closing the last tab of a group closes the group and focuses its neighbour', () => {
    useTabs.getState().splitTab('c', 'right');
    useTabs.getState().close('c');
    const s = useTabs.getState();
    expect(s.groups).toHaveLength(1);
    expect(s.layout.kind).toBe('group');
    expect(s.activeId).toBe('a');
    expect(groupIds()).toEqual([['a', 'b']]);
  });

  it('closing the shown tab shows the group\'s most recently used other tab, not one of another group', () => {
    reset(['a', 'b', 'c', 'd'], 'a');
    useTabs.getState().splitTab('d', 'right');
    useTabs.getState().activate('c');
    useTabs.getState().activate('d');
    useTabs.getState().activate('b');
    useTabs.getState().close('b');
    const s = useTabs.getState();
    expect(s.activeId).toBe('c');
    expect(s.groups.find((g) => g.tabIds.includes('d'))!.activeId).toBe('d');
  });

  it('moveTab moves between groups at a position; the emptied group closes', () => {
    useTabs.getState().splitTab('c', 'right');
    const [g1] = useTabs.getState().groups;
    useTabs.getState().moveTab('c', g1.id, 'b');
    expect(groupIds()).toEqual([['a', 'c', 'b']]);
    expect(ids(useTabs.getState().tabs)).toEqual(['a', 'c', 'b']);
    expect(useTabs.getState().activeId).toBe('c');
  });

  it('move() reorders inside a group and moves across groups', () => {
    useTabs.getState().move('c', 'a');
    expect(groupIds()).toEqual([['c', 'a', 'b']]);
    useTabs.getState().splitTab('b', 'right');
    useTabs.getState().move('b', 'a');
    expect(groupIds()).toEqual([['c', 'b', 'a']]);
  });

  it('a single tab cannot split off its own group; at the maximum, splitting moves to the neighbour', () => {
    reset(['a']);
    expect(useTabs.getState().splitTab('a', 'right')).toBeNull();
    reset(['a', 'b', 'c', 'd']);
    useTabs.getState().splitTab('b', 'right');
    useTabs.getState().splitTab('c', 'right');
    expect(useTabs.getState().groups).toHaveLength(MAX_GROUPS);
    const before = useTabs.getState().groups.map((g) => g.id);
    const dest = useTabs.getState().splitTab('a', 'right');
    expect(useTabs.getState().groups.map((g) => g.id)).toEqual(before);
    expect(useTabs.getState().groups.find((g) => g.id === dest)!.tabIds).toContain('a');
  });

  it('closeOthers closes the other tabs of the group only', () => {
    reset(['a', 'b', 'c', 'd']);
    useTabs.getState().splitTab('d', 'right');
    useTabs.getState().closeOthers('a');
    expect(groupIds()).toEqual([['a'], ['d']]);
    expect(useTabs.getState().closed.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('serialize/restore round trip keeps the groups, layout, sizes and what each group shows', () => {
    reset(['a', 'b', 'c']);
    useTabs.getState().splitTab('c', 'down');
    const s0 = useTabs.getState();
    useTabs.getState().setGroupLayout(setSplitSizes(s0.layout, [], [0.7, 0.3]));
    useTabs.getState().activate('a');
    const saved = JSON.parse(JSON.stringify(useTabs.getState().serialize())) as WorkspaceData;
    expect(saved.groups?.groups).toHaveLength(2);
    reset([]);
    useTabs.getState().restore(saved);
    const s = useTabs.getState();
    expect(groupIds()).toEqual([['a', 'b'], ['c']]);
    expect(s.activeId).toBe('a');
    expect(s.layout).toMatchObject({ kind: 'split', dir: 'column', sizes: [0.7, 0.3] });
    expect(s.groups[1].activeId).toBe('c');
  });

  it('a single group is not written to the workspace; old workspaces (no groups) load as one group', () => {
    expect(useTabs.getState().serialize().groups).toBeUndefined();
    useTabs.getState().restore({ version: 1, tabs: [con('x'), con('y')], activeId: 'y', seq: 2 });
    expect(groupIds()).toEqual([['x', 'y']]);
    expect(useTabs.getState().activeId).toBe('y');
  });

  it('a damaged groups value falls back to one group', () => {
    useTabs.getState().restore({ version: 1, tabs: [con('x'), con('y')], activeId: 'x', seq: 2, groups: { groups: 'nope', layout: 42 } as never });
    expect(groupIds()).toEqual([['x', 'y']]);
  });

  it('detached tabs: kept in the workspace, restored into this window after a restart, not while still open elsewhere', () => {
    reset(['a']);
    useTabs.getState().setDetached([con('far')]);
    const saved = useTabs.getState().serialize();
    expect(saved.detached?.map((t) => t.id)).toEqual(['far']);
    reset([]);
    useTabs.getState().restore(saved, { liveDetached: [con('far')] });
    expect(ids(useTabs.getState().tabs)).toEqual(['a']);
    expect(useTabs.getState().detached.map((t) => t.id)).toEqual(['far']);
    reset([]);
    useTabs.getState().restore(saved);
    expect(ids(useTabs.getState().tabs)).toEqual(['a', 'far']);
  });

  it('adopt inserts tabs from another window into the focused group (fresh id on a clash); take removes without "closed"', () => {
    useTabs.getState().splitTab('c', 'right');
    const added = useTabs.getState().adopt([con('z'), con('a')]);
    expect(added[0]).toBe('z');
    expect(added[1]).not.toBe('a');
    expect(useTabs.getState().groups.find((g) => g.id === useTabs.getState().focusedGroup)!.tabIds).toEqual(['c', 'z', added[1]]);
    expect(useTabs.getState().activeId).toBe(added[1]);
    useTabs.getState().take('z');
    expect(useTabs.getState().closed).toEqual([]);
  });
});

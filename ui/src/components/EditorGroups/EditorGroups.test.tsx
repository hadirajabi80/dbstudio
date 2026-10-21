// Editor groups in the shell: two groups render side by side with their own strips, moving a tab between groups keeps
// its view mounted, drag and drop onto a group splits / moves, the tab context menu offers the group and window
// commands, and tabs move to / from detached windows through the window bridge.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canReattachTabs, detachTab, reattachTab, wireMainWindowTabs } from '../../app/detach';
import { runCommand } from '../../commands/registry';
import { setWindowsApiForTests, type WindowsBridge } from '../../platform/windows';
import { useTabs, type ViewTab } from '../../store/tabs';
import { contextMenu } from '../layout/commandMenu';
import { registerTabView, type TabViewProps } from '../layout/tabViews';
import { registerEditorGroupCommands } from './commands';
import { useTabDrag } from './dnd';
import { EditorGroups } from './EditorGroups';

const mounts: Record<string, number> = {};
function Probe({ tab, visible }: TabViewProps) {
  useEffect(() => {
    mounts[tab.id] = (mounts[tab.id] ?? 0) + 1;
  }, [tab.id]);
  return <div data-testid={`probe-${tab.id}`}>{visible ? 'shown' : 'hidden'} {tab.title}</div>;
}

const view = (id: string): ViewTab => ({ kind: 'view', id, title: `Tab ${id}`, view: 'probe', connectionId: null, database: null, state: null, key: null });

beforeAll(() => {
  // jsdom has no DragEvent: without it fireEvent.drag* drops the pointer coordinates.
  if (typeof window.DragEvent === 'undefined') {
    (window as unknown as { DragEvent: unknown }).DragEvent = class DragEvent extends MouseEvent {};
  }
  registerTabView('probe', { component: Probe, icon: 'File' });
  registerEditorGroupCommands();
});

beforeEach(() => {
  for (const k of Object.keys(mounts)) delete mounts[k];
  useTabs.setState({ tabs: ['a', 'b', 'c'].map(view), activeId: 'a', mru: ['a'], closed: [], detached: [], groups: [], focusedGroup: '' });
  useTabDrag.getState().end();
});

afterEach(() => setWindowsApiForTests());

const groupEls = () => Array.from(document.querySelectorAll<HTMLElement>('.eg-header'));

describe('EditorGroups', () => {
  it('one group: one strip, the active tab shown', () => {
    render(<EditorGroups theme="light" />);
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.getByTestId('probe-a')).toBeVisible();
    expect(screen.getByTestId('probe-b')).not.toBeVisible();
  });

  it('split right: two strips, each group shows its own tab, the new group has the focus; moving back keeps the view mounted', () => {
    render(<EditorGroups theme="light" />);
    act(() => void runCommand('view.splitRight', { kind: 'tab', tabId: 'b' }));
    const strips = screen.getAllByRole('tablist');
    expect(strips).toHaveLength(2);
    expect(within(strips[0]).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Tab a', 'Tab c']);
    expect(within(strips[1]).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Tab b']);
    expect(screen.getByTestId('probe-a')).toBeVisible();
    expect(screen.getByTestId('probe-b')).toBeVisible();
    expect(groupEls()[1]).toHaveClass('focused');
    expect(document.querySelector('.eg-splitter.vertical')).not.toBeNull();

    // Clicking into the other group focuses it (keyboard shortcuts act on its tab).
    fireEvent.mouseDown(screen.getByTestId('probe-a'));
    expect(useTabs.getState().activeId).toBe('a');
    expect(groupEls()[0]).toHaveClass('focused');

    act(() => void runCommand('view.moveTabToNextGroup', { kind: 'tab', tabId: 'b' }));
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(mounts).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('dragging a tab onto another group\'s body moves it there (center) and highlights the zone', () => {
    useTabs.getState().splitTab('c', 'right');
    render(<EditorGroups theme="light" />);
    const tabA = screen.getAllByRole('tab').find((t) => t.textContent === 'Tab a')!;
    fireEvent.dragStart(tabA);
    const overlays = document.querySelectorAll<HTMLElement>('.eg-drop');
    expect(overlays).toHaveLength(2);
    const target = overlays[1];
    // jsdom has no layout: put the pointer in the middle of a 400 x 300 body.
    target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.dragOver(target, { clientX: 200, clientY: 150 });
    expect(target.querySelector('.eg-drop-zone.on')).toHaveTextContent('Move to this group');
    fireEvent.drop(target, { clientX: 200, clientY: 150 });
    expect(useTabs.getState().groups.map((g) => g.tabIds)).toEqual([['b'], ['c', 'a']]);
    expect(document.querySelectorAll('.eg-drop')).toHaveLength(0);
  });

  it('dropping on the right edge of a group splits it', () => {
    render(<EditorGroups theme="light" />);
    const tabB = screen.getAllByRole('tab').find((t) => t.textContent === 'Tab b')!;
    fireEvent.dragStart(tabB);
    const target = document.querySelector<HTMLElement>('.eg-drop')!;
    target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.dragOver(target, { clientX: 390, clientY: 150 });
    expect(target.querySelector('.eg-drop-zone.on')).toHaveTextContent('Split right');
    fireEvent.drop(target, { clientX: 390, clientY: 150 });
    expect(useTabs.getState().groups.map((g) => g.tabIds)).toEqual([['a', 'c'], ['b']]);
    expect(useTabs.getState().layout).toMatchObject({ kind: 'split', dir: 'row' });
  });

  it('reorders within a strip: dropping on the right half of a tab puts the dragged tab after it', () => {
    render(<EditorGroups theme="light" />);
    const tabs = () => screen.getAllByRole('tab');
    const [a, , c] = tabs();
    c.getBoundingClientRect = () => ({ left: 200, top: 0, width: 100, height: 30, right: 300, bottom: 30, x: 200, y: 0, toJSON: () => ({}) });
    fireEvent.dragStart(a);
    fireEvent.dragOver(c, { clientX: 290 });
    expect(c.querySelector('.tab-drop-mark.after')).not.toBeNull();
    fireEvent.drop(c, { clientX: 290 });
    expect(tabs().map((t) => t.textContent)).toEqual(['Tab b', 'Tab c', 'Tab a']);
  });

  it('the tab context menu offers the group and window commands that apply', () => {
    const labels = () => contextMenu('tab', { kind: 'tab', tabId: 'a' }).filter((i) => !i.separator).map((i) => `${i.label}${i.disabled ? ' (disabled)' : ''}`);
    expect(labels()).toEqual(expect.arrayContaining(['Split right', 'Split down']));
    expect(labels()).not.toContain('Close group');
    expect(labels()).not.toContain('Open in new window'); // no window bridge in the browser
    useTabs.getState().splitTab('b', 'right');
    setWindowsApiForTests(fakeBridge());
    expect(labels()).toEqual(expect.arrayContaining(['Move tab to the next group', 'Open in new window', 'Close group']));
    expect(labels()).not.toContain('Move back to main window');
  });

  it('Close group closes the tabs of that group only', async () => {
    useTabs.getState().splitTab('c', 'right');
    await act(async () => void (await runCommand('view.closeGroup', { kind: 'tab', tabId: 'c' })));
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(useTabs.getState().groups).toHaveLength(1);
  });
});

function fakeBridge(over: Partial<WindowsBridge> = {}): WindowsBridge & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const rec = <T,>(name: string, ret: T) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return ret;
  };
  return {
    calls,
    openTabWindow: rec('openTabWindow', Promise.resolve(true)),
    getDetachedTabs: rec('getDetachedTabs', Promise.resolve(null)),
    reportDetachedTabs: rec('reportDetachedTabs', undefined),
    reattachTabs: rec('reattachTabs', Promise.resolve(true)),
    closeDetachedWindow: rec('closeDetachedWindow', undefined),
    listDetachedTabs: rec('listDetachedTabs', Promise.resolve([])),
    onDetachedTabs: rec('onDetachedTabs', () => {}),
    onTabsReattached: rec('onTabsReattached', () => {}),
    ...over,
  };
}

describe('detached windows', () => {
  it('Open in new window sends the serialized tab to main and removes it here (not as "recently closed")', async () => {
    const api = fakeBridge();
    setWindowsApiForTests(api, 'main');
    expect(await detachTab('b', { x: 10.4, y: 20.6 })).toBe(true);
    expect(api.calls.openTabWindow[0][0]).toEqual({ tabs: [view('b')], position: { x: 10, y: 21 } });
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['a', 'c']);
    expect(useTabs.getState().closed).toEqual([]);
    expect(api.calls.closeDetachedWindow).toBeUndefined();
  });

  it('a failed open keeps the tab', async () => {
    setWindowsApiForTests(fakeBridge({ openTabWindow: () => Promise.resolve(false) }), 'main');
    expect(await detachTab('b')).toBe(false);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('a detached window moves its tab back and closes once empty', async () => {
    const api = fakeBridge();
    setWindowsApiForTests(api, 'detached');
    useTabs.setState({ tabs: [view('x')], activeId: 'x', groups: [], focusedGroup: '' });
    expect(canReattachTabs()).toBe(true);
    expect(await reattachTab('x')).toBe(true);
    expect(api.calls.reattachTabs[0][0]).toEqual([view('x')]);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(api.calls.closeDetachedWindow).toHaveLength(1);
  });

  it('the main window adopts tabs moved back, keeps tabs of a closed window as recently closed, tracks detached tabs', () => {
    let reattached: (e: { tabs: unknown[]; closed: boolean }) => void = () => {};
    let detached: (tabs: unknown[]) => void = () => {};
    const api = fakeBridge({
      onTabsReattached: (cb) => { reattached = cb; return () => {}; },
      onDetachedTabs: (cb) => { detached = cb; return () => {}; },
    });
    setWindowsApiForTests(api, 'main');
    wireMainWindowTabs();
    act(() => detached([view('far'), { junk: true }]));
    expect(useTabs.getState().detached.map((t) => t.id)).toEqual(['far']);
    act(() => reattached({ tabs: [view('far')], closed: false }));
    expect(useTabs.getState().activeId).toBe('far');
    expect(useTabs.getState().detached).toEqual([]);
    act(() => reattached({ tabs: [view('gone')], closed: true }));
    expect(useTabs.getState().closed.map((t) => t.id)).toEqual(['gone']);
    expect(useTabs.getState().tabs.some((t) => t.id === 'gone')).toBe(false);
  });

  it('a tab dragged out of the window opens in a new window where it was dropped', async () => {
    const api = fakeBridge();
    setWindowsApiForTests(api, 'main');
    const spy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    render(<EditorGroups theme="light" />);
    const tabB = screen.getAllByRole('tab').find((t) => t.textContent === 'Tab b')!;
    fireEvent.dragStart(tabB);
    await act(async () => {
      fireEvent.dragEnd(tabB, { clientX: 900, clientY: 100, screenX: 1500, screenY: 300, dataTransfer: { dropEffect: 'none' } });
    });
    spy.mockRestore();
    expect(api.calls.openTabWindow?.[0][0]).toMatchObject({ tabs: [view('b')], position: { x: 1500, y: 300 } });
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['a', 'c']);
  });
});

// The permanent Objects tab (home.ts, ObjectsHomeView): pinned first in the first editor group and never closed,
// moved, split off or detached; follows the explorer selection in the background (type folders switch the filter,
// objects are highlighted); "Show objects" activates it; the setting removes / restores it; workspaces from before it
// existed get it on restore. The view: breadcrumb + list, connection cards that drill down, the welcome content.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../../commands';
import { isEnabled, runCommand } from '../../commands/registry';
import type { CommandTarget } from '../../commands/types';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { OBJECTS_TAB_SETTING, useSettings } from '../../store/settings';
import { isPinnedTab, useTabs, type ViewTab, type WorkspaceData } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import { useExplorer } from '../Explorer/explorerStore';
import { nodeId } from '../Explorer/tree';
import { GeneralSection } from '../layout/settings/sections/General';
import { TabBar } from '../layout/TabBar';
import {
  EMPTY_HOME, FOLLOW_DELAY_MS, followTarget, groupForScope, homeScopeKey, homeStateOf, installObjectsHome, OBJECTS_HOME_ID, OBJECTS_HOME_VIEW,
  type ObjectsHomeState,
} from './home';
import { OBJECTS_VIEW } from './model';
import { ObjectsHomeView } from './ObjectsHomeView';

installMockEngine({ frameDelay: 0 });
const SLOW = { timeout: 8000 };
const relational = (cid: string) => cid !== 'c_redis';

const schema = (s: string, objectType?: 'proc' | 'table'): CommandTarget => ({ kind: 'container', connectionId: 'c_prod', database: 'Shop', schema: s, objectType });
const object = (name: string, type: 'table' | 'proc'): CommandTarget => ({ kind: 'object', connectionId: 'c_prod', database: 'Shop', ref: { database: 'Shop', schema: 'dbo', name, type } });
const dboKey = homeScopeKey({ connectionId: 'c_prod', database: 'Shop', schema: 'dbo' });

describe('followTarget (pure)', () => {
  it('maps explorer nodes to what the tab shows and keeps the filter per scope', () => {
    let s: ObjectsHomeState = EMPTY_HOME;
    s = followTarget(s, { kind: 'connection', connectionId: 'c_prod' }, relational);
    expect(s.target).toEqual({ kind: 'connection', connectionId: 'c_prod' });
    s = followTarget(s, schema('dbo'), relational);
    expect(s.target).toEqual({ kind: 'scope', connectionId: 'c_prod', database: 'Shop', schema: 'dbo' });
    expect(groupForScope(s, dboKey)).toBe('table'); // a new scope lists its tables
    s = followTarget(s, schema('dbo', 'proc'), relational);
    expect(groupForScope(s, dboKey)).toBe('proc'); // a type folder switches the filter
    s = followTarget(s, schema('dbo'), relational);
    expect(groupForScope(s, dboKey)).toBe('proc'); // ... and it is remembered for the scope
    s = followTarget(s, object('orders', 'table'), relational);
    expect(s.highlight).toEqual({ schema: 'dbo', name: 'orders', type: 'table' });
    expect(groupForScope(s, dboKey)).toBe('table'); // the filter would have hidden the selected table
    expect(followTarget(s, object('orders', 'table'), relational)).toBe(s); // nothing changed: same state
    expect(followTarget(s, { kind: 'connection', connectionId: 'c_redis' }, relational).target).toEqual({ kind: 'unsupported', connectionId: 'c_redis' });
    expect(followTarget(s, null, relational).target).toBeNull();
    expect(homeStateOf({ state: { target: { kind: 'bogus' }, layout: 'grid' } })).toMatchObject({ target: null, layout: 'grid', groups: {} });
  });
});

describe('the Objects tab', () => {
  let uninstall: (() => void) | null = null;

  beforeAll(async () => {
    await initCommands();
  });

  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [], detached: [] });
    useExplorer.setState({ selected: null, selectedTarget: null });
    useCatalog.setState({ conns: {}, dbs: {} });
    await useSettings.getState().load();
    await useConnections.getState().load();
    useSettings.setState({ settings: { ...useSettings.getState().settings, ui: { ...useSettings.getState().settings.ui, [OBJECTS_TAB_SETTING]: true } } });
    uninstall = installObjectsHome();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  const home = () => useTabs.getState().tabs.find((t): t is ViewTab => t.id === OBJECTS_HOME_ID);
  const state = () => homeStateOf(home());
  const follow = (t: CommandTarget | null) => {
    useExplorer.setState({ selectedTarget: t });
    return new Promise((r) => setTimeout(r, FOLLOW_DELAY_MS + 40));
  };

  it('is pinned first, active only while nothing else is open, and cannot be closed, moved, split off or detached', () => {
    const s = useTabs.getState();
    expect(s.tabs[0]).toMatchObject({ id: OBJECTS_HOME_ID, view: OBJECTS_HOME_VIEW, title: 'Objects', pinned: true });
    expect(s.activeId).toBe(OBJECTS_HOME_ID);

    const c1 = useTabs.getState().newConsole({ connectionId: 'c_prod' });
    const c2 = useTabs.getState().newConsole({ connectionId: 'c_prod' });
    expect(useTabs.getState().activeId).toBe(c2);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([OBJECTS_HOME_ID, c1, c2]);

    useTabs.getState().close(OBJECTS_HOME_ID);
    useTabs.getState().closeOthers(c1);
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([OBJECTS_HOME_ID, c1]);
    expect(isEnabled('tab.close', { kind: 'tab', tabId: OBJECTS_HOME_ID })).toBe(false);
    expect(isEnabled('tab.close', { kind: 'tab', tabId: c1 })).toBe(true);
    expect(isEnabled('tab.closeOthers', { kind: 'tab', tabId: c1 })).toBe(false); // the Objects tab is not an "other" tab
    expect(isEnabled('view.splitRight', { kind: 'tab', tabId: OBJECTS_HOME_ID })).toBe(false);
    expect(isEnabled('view.openInNewWindow', { kind: 'tab', tabId: OBJECTS_HOME_ID })).toBe(false);
    expect(useTabs.getState().splitTab(OBJECTS_HOME_ID, 'right')).toBeNull();
    expect(useTabs.getState().take(OBJECTS_HOME_ID)).toBeNull();

    // A drop before it, or a reorder onto it, leaves it first.
    useTabs.getState().move(c1, OBJECTS_HOME_ID);
    useTabs.getState().moveTab(c1, useTabs.getState().groups[0].id, OBJECTS_HOME_ID);
    expect(useTabs.getState().tabs[0].id).toBe(OBJECTS_HOME_ID);
    expect(useTabs.getState().groups[0].tabIds[0]).toBe(OBJECTS_HOME_ID);
    // Another window never hands one over; it is never "recently closed".
    expect(useTabs.getState().adopt([{ ...home()!, id: 'x' }])).toEqual([]);
    expect(useTabs.getState().closed.some(isPinnedTab)).toBe(false);
  });

  it('stays at the start of the first editor group when groups split and move', () => {
    const a = useTabs.getState().newConsole();
    const b = useTabs.getState().newConsole();
    useTabs.getState().splitTab(b, 'right');
    let s = useTabs.getState();
    expect(s.groups).toHaveLength(2);
    expect(s.groups[0].tabIds).toEqual([OBJECTS_HOME_ID, a]);
    expect(s.groups[1].tabIds).toEqual([b]);
    useTabs.getState().moveTab(OBJECTS_HOME_ID, s.groups[1].id);
    expect(useTabs.getState().groups[0].tabIds[0]).toBe(OBJECTS_HOME_ID);
    // A new group opens on the left of the first one: the Objects tab moves into it (it is now the first group).
    useTabs.getState().splitTab(a, 'left');
    s = useTabs.getState();
    expect(s.groups[0].tabIds).toEqual([OBJECTS_HOME_ID, a]);
    // Join groups: everything ends up in its group.
    act(() => void runCommand('view.joinGroups'));
    expect(useTabs.getState().groups).toHaveLength(1);
    expect(useTabs.getState().groups[0].tabIds[0]).toBe(OBJECTS_HOME_ID);
  });

  it('follows the explorer selection in the background and "Show objects" brings it to the front', async () => {
    const c = useTabs.getState().newConsole({ connectionId: 'c_prod' });
    await follow(schema('dbo'));
    expect(state().target).toEqual({ kind: 'scope', connectionId: 'c_prod', database: 'Shop', schema: 'dbo' });
    expect(useTabs.getState().activeId).toBe(c); // not stolen
    await follow(schema('dbo', 'proc'));
    expect(groupForScope(state(), dboKey)).toBe('proc');
    await follow(object('orders', 'table'));
    expect(state().highlight).toMatchObject({ name: 'orders' });

    act(() => void runCommand('objects.open', schema('Sales')));
    expect(useTabs.getState().activeId).toBe(OBJECTS_HOME_ID);
    expect(state().target).toMatchObject({ schema: 'Sales' });
    expect(useTabs.getState().tabs.some((t) => t.kind === 'view' && t.view === OBJECTS_VIEW)).toBe(false); // no per-scope tab
  });

  it('the setting removes it and brings it back as it was', async () => {
    await follow(schema('dbo'));
    const c = useTabs.getState().newConsole();
    act(() => useSettings.getState().update({ ui: { [OBJECTS_TAB_SETTING]: false } }));
    expect(home()).toBeUndefined();
    expect(useTabs.getState().activeId).toBe(c);
    // Off: "Show objects" opens a per-scope Objects tab again.
    act(() => void runCommand('objects.open', schema('dbo')));
    expect(useTabs.getState().tabs.some((t) => t.kind === 'view' && t.view === OBJECTS_VIEW)).toBe(true);
    act(() => useSettings.getState().update({ ui: { [OBJECTS_TAB_SETTING]: true } }));
    expect(useTabs.getState().tabs[0].id).toBe(OBJECTS_HOME_ID);
    expect(state().target).toMatchObject({ schema: 'dbo' });
  });

  it('workspace restore: an older workspace gets it first (not active); a saved one keeps its state and moves to the first group', () => {
    const older: WorkspaceData = {
      version: 1, activeId: 't_1', seq: 1,
      tabs: [{ kind: 'console', id: 't_1', title: 'Console 1', connectionId: null, database: null, text: 'select 1', savedText: '', filePath: null, txMode: 'auto', maxRows: null }],
    };
    act(() => useTabs.getState().restore(older));
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([OBJECTS_HOME_ID, 't_1']);
    expect(useTabs.getState().activeId).toBe('t_1');

    // Saved with the Objects tab (in the second group of a hand-edited file): restored with its state, in the first group.
    const saved = useTabs.getState().serialize();
    const homeTab = saved.tabs.find((t) => t.id === OBJECTS_HOME_ID) as ViewTab;
    expect(homeTab.pinned).toBe(true);
    const withState: WorkspaceData = {
      ...saved,
      tabs: [saved.tabs[1], { ...homeTab, state: { ...EMPTY_HOME, target: { kind: 'connection', connectionId: 'c_prod' } } }],
      groups: {
        groups: [{ id: 'g1', tabIds: ['t_1'], activeId: 't_1' }, { id: 'g2', tabIds: [OBJECTS_HOME_ID], activeId: OBJECTS_HOME_ID }],
        layout: { kind: 'split', dir: 'row', children: [{ kind: 'group', id: 'g1' }, { kind: 'group', id: 'g2' }], sizes: [0.5, 0.5] },
        focusedGroup: 'g1',
      },
    };
    act(() => useTabs.getState().restore(withState));
    const s = useTabs.getState();
    expect(s.tabs[0].id).toBe(OBJECTS_HOME_ID);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].tabIds).toEqual([OBJECTS_HOME_ID, 't_1']);
    expect(state().target).toEqual({ kind: 'connection', connectionId: 'c_prod' });
  });

  it('the tab strip shows it without a close button and not draggable; Settings › General toggles it', () => {
    useTabs.getState().newConsole();
    render(<TabBar />);
    const tab = screen.getByRole('tab', { name: /Objects/ });
    expect(tab).toHaveAttribute('draggable', 'false');
    expect(within(tab).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Close / })).toHaveLength(1); // the console's

    render(<GeneralSection />);
    const toggle = screen.getByRole('checkbox', { name: 'Show the Objects tab' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(home()).toBeUndefined();
  });
});

describe('ObjectsHomeView', () => {
  beforeAll(async () => {
    await initCommands();
  });

  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [], detached: [] });
    useExplorer.setState({ selected: null, selectedTarget: null, expanded: new Set() });
    useCatalog.setState({ conns: {}, dbs: {} });
    await useSettings.getState().load();
    await useConnections.getState().load();
  });

  function Host() {
    const tab = useTabs((s) => s.tabs.find((t) => t.id === OBJECTS_HOME_ID)) as ViewTab | undefined;
    return tab ? <ObjectsHomeView tab={tab} theme="light" visible /> : null;
  }
  const pin = (st: ObjectsHomeState) => useTabs.getState().pin({ id: OBJECTS_HOME_ID, title: 'Objects', view: OBJECTS_HOME_VIEW, connectionId: null, database: null, state: st, key: OBJECTS_HOME_ID });

  it('nothing selected: the welcome content', () => {
    pin(EMPTY_HOME);
    render(<Host />);
    expect(screen.getByRole('region', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByRole('note').textContent).toMatch(/Select a connection, database or schema/);
  });

  it('a schema: breadcrumb and its tables, the selected object highlighted', async () => {
    pin({ ...EMPTY_HOME, target: { kind: 'scope', connectionId: 'c_prod', database: 'Shop', schema: 'dbo' }, highlight: { schema: 'dbo', name: 'orders', type: 'table' } });
    render(<Host />);
    const crumbs = screen.getByRole('navigation', { name: 'Location' });
    expect(crumbs.textContent).toMatch(/Prod SQL.*Shop.*dbo/);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(3), SLOW);
    expect(within(screen.getByRole('tablist', { name: 'Object types' })).getByRole('tab', { name: /^Tables/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent).toMatch(/^orders/), SLOW);

    // The filter chosen here is remembered for the scope.
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Object types' })).getByRole('tab', { name: /^Procedures/ }));
    expect(groupForScope(homeStateOf(useTabs.getState().tabs.find((t) => t.id === OBJECTS_HOME_ID) as ViewTab), dboKey)).toBe('proc');
  });

  it('a connection: connect, then its databases as cards; double-click drills down and selects in the explorer', async () => {
    pin({ ...EMPTY_HOME, target: { kind: 'connection', connectionId: 'c_prod' } });
    render(<Host />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    const cards = await screen.findByRole('listbox', { name: 'Databases' }, SLOW);
    const shop = within(cards).getAllByRole('option').find((o) => o.textContent?.includes('Shop'))!;
    expect(shop.textContent).toContain('current');
    fireEvent.doubleClick(shop);
    expect(useExplorer.getState().selected).toBe(nodeId.db('c_prod', 'Shop'));
    expect(useExplorer.getState().expanded.has(nodeId.conn('c_prod'))).toBe(true);
    await waitFor(() => expect(homeStateOf(useTabs.getState().tabs.find((t) => t.id === OBJECTS_HOME_ID) as ViewTab).target)
      .toEqual({ kind: 'scope', connectionId: 'c_prod', database: 'Shop', schema: null }));
  });
});

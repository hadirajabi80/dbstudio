// Objects tab (WP3) against the mock engine: list with statistics, type groups with counts, live filter, sort,
// keyboard activation, the explorer's context menu, and the entry points (command, explorer Enter).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../../commands';
import { isEnabled, runCommand } from '../../commands/registry';
import { useConnections } from '../../store/connections';
import { useSettings } from '../../store/settings';
import { useTabs, type ViewTab } from '../../store/tabs';
import { useMenu } from '../common/Menu';
import { installMockEngine } from '../../test/mockServer';
import { OBJECTS_VIEW } from './model';
import { ObjectListView } from './ObjectListView';
import { objectsKey, openObjects, type ObjectsState } from './open';

const mock = installMockEngine({ frameDelay: 0 });
/** The list loads over the mock REST engine; allow for a busy test machine. */
const SLOW = { timeout: 8000 };

beforeAll(async () => {
  await initCommands();
});

beforeEach(async () => {
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
  await useSettings.getState().load();
  await useConnections.getState().load();
});

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <ObjectListView tab={tab} theme="light" visible /> : null;
}

const names = () => screen.getAllByRole('option').map((o) => o.querySelector('.ol-name-text')?.textContent);

describe('Objects tab', () => {
  it('opens one tab per scope, lists objects with statistics and type groups with counts', async () => {
    const id = openObjects({ connectionId: 'c_prod', database: null, schema: 'dbo' });
    expect(openObjects({ connectionId: 'c_prod', database: null, schema: 'dbo', group: 'proc' })).toBe(id);
    const tab = useTabs.getState().tabs.find((t) => t.id === id) as ViewTab;
    expect(tab.view).toBe(OBJECTS_VIEW);
    expect(tab.key).toBe(objectsKey({ connectionId: 'c_prod', database: null, schema: 'dbo' }));
    expect((tab.state as ObjectsState).group).toBe('proc'); // re-open switched the group
    act(() => useTabs.getState().updateView(id, { state: { ...(tab.state as ObjectsState), group: 'all' } }));

    render(<Host id={id} />);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(5), SLOW);
    expect(mock.hits('/catalog/objects')).toHaveLength(1);
    const groups = screen.getByRole('tablist', { name: 'Object types' });
    expect(within(groups).getByRole('tab', { name: /^All\s*12$/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(groups).getByRole('tab', { name: /^Tables\s*6$/ })).toBeInTheDocument();
    expect(within(groups).getByRole('tab', { name: /^Procedures\s*2$/ })).toBeInTheDocument();
    // statistics columns
    const orders = screen.getAllByRole('option').find((o) => o.textContent?.includes('orders') && !o.textContent.includes('customer'))!;
    expect(orders.textContent).toContain('5,000');
    expect(screen.getByRole('columnheader', { name: /Rows/ })).toBeInTheDocument();

    // group pill → only procedures, rows/size columns disappear
    fireEvent.click(within(groups).getByRole('tab', { name: /^Procedures/ }));
    await waitFor(() => expect(names()).toEqual(['GetCustomer', 'MonthlyReport']), SLOW);
    expect(screen.queryByRole('columnheader', { name: /Rows/ })).toBeNull();
    expect(((useTabs.getState().tabs[0] as ViewTab).state as ObjectsState).group).toBe('proc');
  });

  it('filters live, sorts by header click, opens with Enter and shows the explorer menu', async () => {
    const id = openObjects({ connectionId: 'c_prod', database: null, schema: 'dbo', group: 'table' });
    render(<Host id={id} />);
    await waitFor(() => expect(names()).toHaveLength(6), SLOW);
    expect(names()[0]).toBe('countries');

    fireEvent.click(screen.getByRole('columnheader', { name: /Rows/ }));
    expect(names()[0]).toBe('events'); // most rows first
    fireEvent.click(screen.getByRole('columnheader', { name: /Rows/ }));
    expect(names()[0]).toBe('countries');

    const search = screen.getByLabelText('Filter objects');
    fireEvent.change(search, { target: { value: 'order' } });
    expect([...names()].sort()).toEqual(['order_lines', 'orders']);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText(/No tables match/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(names()).toHaveLength(6);

    // Arrow down from the search moves into the list; Enter opens like the explorer (the object tab here).
    fireEvent.change(search, { target: { value: 'countries' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(list, { key: 'Enter' });
    await waitFor(() => expect(useTabs.getState().tabs.some((t) => t.kind !== 'view' || t.view !== OBJECTS_VIEW)).toBe(true), SLOW);

    // Right-click: the explorer's table menu.
    fireEvent.contextMenu(screen.getAllByRole('option')[0]);
    const items = (useMenu.getState().open?.items ?? []).map((i) => i.label).filter(Boolean);
    expect(items).toContain('Show dependencies');
    act(() => useMenu.getState().hide());
  });

  it('objects.open accepts explorer containers and objects; hidden for non-relational connections', async () => {
    expect(isEnabled('objects.open', { kind: 'container', connectionId: 'c_pg', database: null, schema: 'public', objectType: 'view' })).toBe(true);
    expect(isEnabled('objects.open', { kind: 'container', connectionId: 'c_redis', database: null, schema: null })).toBe(false);
    runCommand('objects.open', { kind: 'container', connectionId: 'c_pg', database: null, schema: 'public', objectType: 'mview' });
    const tab = useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === OBJECTS_VIEW)!;
    expect((tab.state as ObjectsState).group).toBe('view');
    expect(tab.title).toMatch(/^Objects: .*public$/);
  });
});

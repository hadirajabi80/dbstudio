// Dependencies section (WP3): grouping model, and the panel against the mock engine (both columns, summary, open on
// click, cache per tab, "Show dependencies" opening the object tab on the section).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DependencyGraph, ObjectDependency } from '../../api/types.objects';
import { initCommands } from '../../commands';
import { runCommand } from '../../commands/registry';
import { useConnections } from '../../store/connections';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import { useObjectSectionRequests } from '../ObjectTab/sectionRequests';
import { DependenciesPanel } from './DependenciesPanel';
import { badgeOf, categoryOf, groupDependencies, splitFkDetail, summaryChips } from './model';

const mock = installMockEngine({ frameDelay: 0 });
const SLOW = { timeout: 8000 };

const dep = (kind: ObjectDependency['kind'], name: string, type: ObjectDependency['object']['type'], detail: string | null = null, schema = 'dbo'): ObjectDependency => ({
  kind, object: { database: null, schema, name, type }, detail, isSchemaBound: null,
});

describe('dependency model', () => {
  it('groups FKs first, then tables, views, routines, triggers, other — each sorted', () => {
    const groups = groupDependencies([
      dep('usedBy', 'zeta', 'proc'), dep('trigger', 'trg', 'trigger', 'AFTER INSERT'), dep('usedBy', 'v2', 'view'), dep('fk', 'Lines', 'table', 'FK_L: OrderId → Id'),
      dep('usedBy', 'alpha', 'func'), dep('usedBy', 'mv', 'mview'), dep('uses', 'seq', 'sequence'), dep('uses', 'T', 'table'), dep('usedBy', 'pkg', 'package'),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['fk', 'table', 'view', 'routine', 'trigger', 'other']);
    expect(groups.find((g) => g.category === 'routine')!.items.map((d) => d.object.name)).toEqual(['alpha', 'pkg', 'zeta']);
    expect(groups.find((g) => g.category === 'view')!.items.map((d) => d.object.name)).toEqual(['mv', 'v2']);
  });

  it('badges, FK detail split and the summary line', () => {
    expect(badgeOf(dep('fk', 'X', 'table'))).toBe('FK');
    expect(badgeOf(dep('usedBy', 'X', 'proc'))).toBe('procedure');
    expect(badgeOf(dep('usedBy', 'X', 'tablefunc'))).toBe('table function');
    expect(categoryOf(dep('trigger', 'Orders', 'table', 'fires on'))).toBe('table');
    expect(splitFkDetail('FK_Orders_Customers: CustomerId → Id')).toEqual({ constraint: 'FK_Orders_Customers', mapping: 'CustomerId → Id', note: null });
    expect(splitFkDetail('FK_A: a, b → x, y (disabled)')).toEqual({ constraint: 'FK_A', mapping: 'a, b → x, y', note: 'disabled' });
    const g: DependencyGraph = {
      root: { database: null, schema: 'dbo', name: 'Orders', type: 'table' },
      uses: [dep('fk', 'Customers', 'table', 'FK: CustomerId → Id')],
      usedBy: [dep('fk', 'Lines', 'table', 'FK: OrderId → Id'), dep('usedBy', 'v', 'view'), dep('trigger', 't', 'trigger')],
    };
    expect(summaryChips(g)).toEqual(['2 foreign keys', '1 view', '1 trigger']);
  });
});

describe('Dependencies panel', () => {
  beforeAll(async () => {
    await initCommands();
  });
  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    await useSettings.getState().load();
    await useConnections.getState().load();
  });

  it('shows Uses / Used by side by side, grouped, with a summary; a row opens its object; cached per tab', async () => {
    const ref = { database: null, schema: 'public', name: 'orders', type: 'table' as const };
    const view = render(<DependenciesPanel cacheId="o1" connectionId="c_pg" database={null} objectRef={ref} dialect="pgsql" />);
    const uses = await screen.findByRole('region', { name: 'Uses' }, SLOW);
    const usedBy = screen.getByRole('region', { name: 'Used by' });
    expect(within(uses).getByRole('list', { name: 'Foreign keys' }).textContent).toContain('customers');
    expect(within(uses).getByText('customer_id → id')).toBeInTheDocument();
    expect(within(usedBy).getByRole('list', { name: 'Foreign keys' }).textContent).toContain('order_lines');
    expect(within(usedBy).getByRole('list', { name: 'Views' }).textContent).toMatch(/customer_totals.*v_customer_orders/);
    expect(within(usedBy).getByRole('list', { name: 'Triggers' }).textContent).toContain('trg_orders_check');
    expect(screen.getByText(/2 foreign keys · 2 views/)).toBeInTheDocument();

    fireEvent.click(within(usedBy).getByRole('listitem', { name: /order_lines/ }));
    const opened = useTabs.getState().tabs.find((t) => t.kind === 'object');
    expect(opened && opened.kind === 'object' && opened.ref).toMatchObject({ schema: 'public', name: 'order_lines', type: 'table' });

    // Re-mounting the same tab's section uses the cache (no second request).
    const before = mock.hits('/catalog/dependencies').length;
    view.unmount();
    render(<DependenciesPanel cacheId="o1" connectionId="c_pg" database={null} objectRef={ref} dialect="pgsql" />);
    expect(screen.getByRole('region', { name: 'Uses' })).toBeInTheDocument();
    expect(mock.hits('/catalog/dependencies').length).toBe(before);
  });

  it('empty and error states', async () => {
    render(<DependenciesPanel cacheId="o2" connectionId="c_pg" database={null} objectRef={{ database: null, schema: 'public', name: 'email_address', type: 'type' }} dialect="pgsql" />);
    expect(await screen.findByText('No dependencies', {}, SLOW)).toBeInTheDocument();
    render(<DependenciesPanel cacheId="o3" connectionId="c_pg" database={null} objectRef={{ database: null, schema: 'public', name: 'nope', type: 'table' }} dialect="pgsql" />);
    expect(await screen.findByText('Could not read the dependencies', {}, SLOW)).toBeInTheDocument();
  });

  it('"Show dependencies" opens the object tab on its Dependencies section', async () => {
    act(() => {
      runCommand('objects.dependencies', { kind: 'object', connectionId: 'c_pg', database: null, ref: { database: null, schema: 'public', name: 'orders', type: 'table' } });
    });
    const tab = useTabs.getState().tabs.find((t) => t.kind === 'object')!;
    await waitFor(() => expect(useObjectSectionRequests.getState().requests[tab.id]?.section).toBe('deps'), SLOW);
  });
});

// ClickHouse tab views against the MSW mock engine (mocks/packs/clickhouse.ts): commands and targets, parts &
// partitions (tiles, keys, inactive parts, drop / detach / optimize with confirmation), mutations (filter, kill) and
// merges (progress), read-only connections.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCommand, isEnabled, runCommand } from '../../../commands/registry';
import type { ObjectTarget } from '../../../commands/types';
import { resetClickHouseMock } from '../../../mocks/packs/clickhouse';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { useUi } from '../../../store/ui';
import { installMockEngine } from '../../../test/mockServer';
import ClickHouseView from '../ClickHouseView';
import { registerClickHouseCommands } from '../commands';
import { formatBytes, formatRatio } from '../format';
import { CH_VIEWS, openMerges, openMutations, openParts } from '../open';

const CID = 'c_clickhouse';
const mock = installMockEngine();
beforeAll(() => registerClickHouseCommands());
beforeEach(async () => {
  mock.reset();
  resetClickHouseMock();
  useTabs.setState({ tabs: [], activeId: null, seq: 0 });
  useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
  await useConnections.getState().load();
});

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <ClickHouseView tab={tab} theme="light" visible /> : null;
}

const show = (id: string) => render(<Host id={id} />);
const table = (name: string): ObjectTarget => ({ kind: 'object', connectionId: CID, database: null, ref: { database: null, schema: 'main', name, type: 'table' } });

function setReadOnly(readOnly: boolean) {
  useConnections.setState((s) => ({ connections: s.connections.map((c) => (c.id === CID ? { ...c, readOnly } : c)) }));
  const conn = mock.ctx.engine.conn(CID);
  if (conn) conn.readOnly = readOnly;
}

async function confirm(ok: boolean, ack = false) {
  await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
  useUi.getState().resolveConfirm(ok, ack);
}

describe('mock pack and commands', () => {
  it('lists the ClickHouse provider and its sample connection', () => {
    const s = useConnections.getState();
    expect(s.providers.find((p) => p.id === 'clickhouse')?.dialect).toBe('clickhouse');
    expect(s.connections.find((c) => c.id === CID)?.folder).toBe('Batch 3');
  });

  it('enables the commands only for ClickHouse targets and opens one tab per table', () => {
    expect(isEnabled('clickhouse.parts', table('orders'))).toBe(true);
    expect(isEnabled('clickhouse.parts', { ...table('orders'), connectionId: 'c_pg' })).toBe(false);
    expect(isEnabled('clickhouse.parts', { ...table('daily_sales'), ref: { ...table('daily_sales').ref, type: 'mview' } })).toBe(false);
    expect(isEnabled('clickhouse.mutations', { kind: 'connection', connectionId: CID })).toBe(true);
    expect(isEnabled('clickhouse.merges', { kind: 'connection', connectionId: 'c_kafka' })).toBe(false);
    expect(getCommand('clickhouse.optimize')?.title).toBe('Optimize table…');
    expect(getCommand('clickhouse.optimize')?.category).toBe('ClickHouse');
    void runCommand('clickhouse.parts', table('orders'));
    void runCommand('clickhouse.parts', table('orders'));
    const tabs = useTabs.getState().tabs.filter((t) => t.kind === 'view' && t.view === CH_VIEWS.parts);
    expect(tabs).toHaveLength(1);
    expect((tabs[0] as ViewTab).state).toEqual({ database: 'main', table: 'orders' });
    // from the open parts tab the palette knows the table
    expect(isEnabled('clickhouse.optimize')).toBe(true);
    setReadOnly(true);
    expect(isEnabled('clickhouse.optimize')).toBe(false);
  });
});

describe('parts & partitions', () => {
  it('shows engine keys, tiles, partitions and active parts; inactive parts on request', async () => {
    show(openParts(CID, 'main', 'orders'));
    const view = await screen.findByTestId('ch-parts');
    await within(view).findByRole('table', { name: 'Partitions' });
    expect(within(view).getByText('toYYYYMM(order_date)')).toBeInTheDocument();
    expect(within(view).getAllByText('customer_id, id')).toHaveLength(2);
    expect(within(view).getByText('MergeTree')).toBeInTheDocument();
    const partitions = within(view).getByRole('table', { name: 'Partitions' });
    expect(within(partitions).getAllByRole('row')).toHaveLength(5); // header + 4 months
    const parts = within(view).getByRole('table', { name: 'Parts' });
    expect(within(parts).queryByText('202607_1_3_1')).toBeNull();
    fireEvent.click(within(view).getByLabelText(/Show inactive parts/));
    expect(within(parts).getByText('202607_1_3_1')).toBeInTheDocument();
  });

  it('drops a partition after confirmation and reloads', async () => {
    show(openParts(CID, 'main', 'orders'));
    const view = await screen.findByTestId('ch-parts');
    const drop = await within(view).findByRole('button', { name: 'Drop partition 202608' });
    fireEvent.click(drop);
    await confirm(false);
    expect(mock.hits('/partitions/drop', 'POST')).toHaveLength(0);
    fireEvent.click(drop);
    await confirm(true);
    await waitFor(() => expect(within(view).queryByRole('button', { name: 'Drop partition 202608' })).toBeNull());
    expect(mock.hits('/partitions/drop', 'POST')).toHaveLength(1);
  });

  it('optimizes a partition with FINAL from the acknowledgement checkbox', async () => {
    show(openParts(CID, 'main', 'orders'));
    const view = await screen.findByTestId('ch-parts');
    fireEvent.click(await within(view).findByRole('button', { name: 'Optimize partition 202610' }));
    await confirm(true, true);
    await waitFor(() => expect(mock.hits('/optimize', 'POST')).toHaveLength(1));
  });

  it('hides the write actions on read-only connections', async () => {
    setReadOnly(true);
    show(openParts(CID, 'main', 'orders'));
    const view = await screen.findByTestId('ch-parts');
    await within(view).findByRole('table', { name: 'Partitions' });
    expect(within(view).queryByRole('button', { name: /Drop partition/ })).toBeNull();
    expect(within(view).queryByRole('button', { name: 'Optimize table…' })).toBeNull();
    expect(within(view).getByText('read-only')).toBeInTheDocument();
  });

  it('explains engines without parts', async () => {
    show(openParts(CID, 'main', 'countries'));
    expect(await screen.findByText('Memory does not store data in parts.')).toBeInTheDocument();
  });
});

describe('mutations', () => {
  it('filters running / done and kills a running mutation', async () => {
    show(openMutations(CID));
    const view = await screen.findByTestId('ch-mutations');
    const t = await within(view).findByRole('table', { name: 'Mutations' });
    expect(within(t).getAllByRole('row')).toHaveLength(3); // header + 2 running
    expect(within(t).getByText('Failing')).toBeInTheDocument();
    fireEvent.click(within(view).getByRole('radio', { name: /All/ }));
    expect(within(t).getAllByRole('row')).toHaveLength(4);
    fireEvent.click(within(view).getByRole('radio', { name: /Running/ }));
    fireEvent.click(within(t).getByRole('button', { name: 'Kill mutation mutation_7.txt' }));
    await confirm(true);
    await waitFor(() => expect(within(view).getAllByRole('row')).toHaveLength(2));
    expect(mock.hits('/mutations/kill', 'POST')).toHaveLength(1);
  });

  it('filters to one table', async () => {
    show(openMutations(CID, 'main', 'customers'));
    const view = await screen.findByTestId('ch-mutations');
    const t = await within(view).findByRole('table', { name: 'Mutations' });
    expect(within(t).getAllByRole('row')).toHaveLength(2);
    expect(within(t).getByText('main.customers')).toBeInTheDocument();
  });
});

describe('merges', () => {
  it('lists running merges with progress bars', async () => {
    show(openMerges(CID));
    const view = await screen.findByTestId('ch-merges');
    await within(view).findByRole('table', { name: 'Merges' });
    const bars = within(view).getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(Number(bars[0].getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    expect(within(view).getByText('Mutation')).toBeInTheDocument();
  });
});

describe('format helpers', () => {
  it('formats sizes and ratios', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.00 GiB');
    expect(formatRatio(600, 100)).toBe('6.0×');
    expect(formatRatio(0, 0)).toBe('—');
  });
});

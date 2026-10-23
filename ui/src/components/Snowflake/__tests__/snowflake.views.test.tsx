// plan-batch3 WP-SF: Snowflake commands and views against the MSW mock engine (mocks/packs/snowflake.ts).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { isEnabled, runCommand } from '../../../commands/registry';
import { MOCK_WAREHOUSES } from '../../../mocks/packs/snowflake';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { installMockEngine } from '../../../test/mockServer';
import { registerSnowflakeCommands, SF_VIEWS } from '../commands';
import { formatBytes, formatMs, queryText } from '../format';
import SnowflakeViews from '../views';

const CID = 'c_snowflake';
const mock = installMockEngine();
beforeAll(() => registerSnowflakeCommands());
beforeEach(async () => {
  mock.reset();
  useTabs.setState({ tabs: [], activeId: null, seq: 0 });
  useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
  await useConnections.getState().load();
});

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <SnowflakeViews tab={tab} theme="light" visible /> : null;
}

const target = { kind: 'connection', connectionId: CID } as const;

describe('Snowflake module', () => {
  it('lists the provider and the sample connection', () => {
    const s = useConnections.getState();
    expect(s.providers.find((p) => p.id === 'snowflake')?.dialect).toBe('snowflake');
    expect(s.connections.find((c) => c.id === CID)?.folder).toBe('Batch 3');
  });

  it('commands are enabled for a Snowflake connection only', () => {
    expect(isEnabled('snowflake.warehouses', target)).toBe(true);
    expect(isEnabled('snowflake.warehouses', { kind: 'connection', connectionId: 'c_shop' })).toBe(false);
  });

  it('warehouses: lists and resumes', async () => {
    await runCommand('snowflake.warehouses', target);
    const tab = useTabs.getState().tabs.find((t) => t.kind === 'view' && t.view === SF_VIEWS.warehouses)!;
    render(<Host id={tab.id} />);
    expect(await screen.findByText('ETL_WH')).toBeTruthy();
    expect(screen.getByText('Nightly loads')).toBeTruthy();
    const before = MOCK_WAREHOUSES.find((w) => w.name === 'BI_WH')!.state;
    expect(before).toBe('SUSPENDED');
    fireEvent.click(screen.getAllByRole('button', { name: /Resume/ })[1]);
    await waitFor(() => expect(MOCK_WAREHOUSES.find((w) => w.name === 'BI_WH')!.state).toBe('STARTED'));
  });

  it('objects: switches kinds and shows the DDL of a task', async () => {
    await runCommand('snowflake.objects', target);
    const tab = useTabs.getState().tabs.find((t) => t.kind === 'view' && t.view === SF_VIEWS.objects)!;
    render(<Host id={tab.id} />);
    expect(await screen.findByText('EVENTS_STAGE')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    fireEvent.click(await screen.findByText('NIGHTLY_TOTALS'));
    expect(await screen.findByText(/create or replace task SHOP\.PUBLIC\.NIGHTLY_TOTALS/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /execute/ }).length).toBeGreaterThan(0);
  });

  it('session context endpoints switch warehouse and schema', async () => {
    const ctx = await api.snowflake.sessionContext('s_test');
    expect(ctx.warehouse).toBe('COMPUTE_WH');
    expect((await api.snowflake.use('s_test', 'warehouse', 'ETL_WH')).warehouse).toBe('ETL_WH');
    expect((await api.snowflake.use('s_test', 'schema', 'SHOP.SALES')).schema).toBe('SALES');
    await expect(api.snowflake.use('s_test', 'warehouse', 'NOPE_WH')).rejects.toBeTruthy();
  });
});

describe('helpers', () => {
  it('formats durations and sizes', () => {
    expect(formatMs('47')).toBe('47 ms');
    expect(formatMs('1205')).toBe('1.2 s');
    expect(formatMs('125000')).toBe('2 min 5 s');
    expect(formatBytes('5632')).toBe('5.5 KB');
    expect(formatBytes('')).toBe('');
  });

  it('recovers the statement of a failed history entry', () => {
    expect(queryText({ ts: null, level: 'error', source: 'x', seq: 1, message: 'SELEC 1', detail: 'syntax error\n\nSELEC 1', fields: { errorCode: '1003' } })).toBe('SELEC 1');
    expect(queryText({ ts: null, level: 'info', source: 'x', seq: 2, message: 'SELECT 1' })).toBe('SELECT 1');
  });
});

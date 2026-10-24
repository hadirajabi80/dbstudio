// Cassandra views and commands against the MSW mock engine (mocks/packs/cassandra.ts) and the FakeSocket: the `when`
// logic of the commands, console settings (REST + cqlsh shell commands), the trace timeline, the cluster view (with
// the NOT_SUPPORTED clients fallback) and the table info view.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { engineSocket } from '../../../api/ws';
import { getCommand, isEnabled, runCommand } from '../../../commands/registry';
import type { ConnectionTarget, ObjectTarget } from '../../../commands/types';
import { FakeSocket } from '../../../mocks/fakeSocket';
import { cassandraMockState } from '../../../mocks/packs/cassandra';
import { useConnections } from '../../../store/connections';
import { useSessions } from '../../../store/sessions';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { chooseOption, selectValue } from '../../../test/select';
import { installMockEngine, TEST_ENGINE_URL } from '../../../test/mockServer';
import { useExplorer } from '../../Explorer/explorerStore';
import CassandraView from '../CassandraView';
import { registerCassandraCommands } from '../commands';
import { CASSANDRA_VIEWS, consoleSessionId, openCluster, openTableInfo, openTrace, type TraceViewState } from '../open';

const CID = 'c_cassandra';
const mock = installMockEngine();
const state = () => cassandraMockState(mock.ctx.engine);

beforeAll(() => registerCassandraCommands());
beforeEach(async () => {
  mock.reset();
  useTabs.setState({ tabs: [], activeId: null, seq: 0 });
  useSessions.setState({ sessions: {}, byTab: {} });
  useExplorer.setState({ selected: null, selectedTarget: null });
  useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
  await useConnections.getState().load();
  engineSocket.disconnect();
  engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
  engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
  await waitFor(() => expect(engineSocket.status).toBe('open'));
});

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <div data-tab-host={id}><CassandraView tab={tab} theme="light" visible /></div> : null;
}
const show = (id: string) => render(<Host id={id} />);

const newConsole = (connectionId = CID) => useTabs.getState().newConsole({ connectionId });
const consoleTab = (id: string) => {
  const t = useTabs.getState().tabs.find((x) => x.id === id);
  if (t?.kind !== 'console') throw new Error('no console');
  return t;
};
const activeView = () => useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId) as ViewTab;

async function run(sid: string, sql: string) {
  const before = mock.ctx.engine.history.length;
  await api.execute(sid, { batches: [{ sql, line: 1, col: 1 }], maxRows: 1000, stopOnError: true, label: 'statement' });
  await waitFor(() => expect(mock.ctx.engine.history.length).toBe(before + 1));
  return mock.ctx.engine.history[0];
}

const table = (target: string, name = 'orders_by_customer'): ObjectTarget => ({
  kind: 'object', connectionId: target, database: null, ref: { database: null, schema: 'main', name, type: 'table' },
});

describe('commands', () => {
  it('are registered in the Cassandra category', () => {
    for (const id of ['cassandra.consoleSettings', 'cassandra.toggleTracing', 'cassandra.setConsistency', 'cassandra.showLastTrace', 'cassandra.cluster', 'cassandra.tableInfo']) {
      expect(getCommand(id)?.category, id).toBe('Cassandra');
    }
  });

  it('console commands need an active console on a Cassandra connection', () => {
    expect(isEnabled('cassandra.consoleSettings')).toBe(false);
    newConsole('c_shop');
    expect(isEnabled('cassandra.toggleTracing')).toBe(false);
    const id = newConsole();
    for (const c of ['cassandra.consoleSettings', 'cassandra.toggleTracing', 'cassandra.setConsistency', 'cassandra.showLastTrace']) expect(isEnabled(c), c).toBe(true);
    // the settings tab of that console keeps them enabled
    runCommand('cassandra.consoleSettings');
    expect(activeView().view).toBe(CASSANDRA_VIEWS.session);
    expect(isEnabled('cassandra.toggleTracing')).toBe(true);
    // a cluster tab is not a console
    openCluster(CID);
    expect(isEnabled('cassandra.toggleTracing')).toBe(false);
    useTabs.getState().activate(id);
    expect(isEnabled('cassandra.showLastTrace')).toBe(true);
  });

  it('Show cluster takes a connection target, else the active tab or the explorer selection', () => {
    const conn = (connectionId: string): ConnectionTarget => ({ kind: 'connection', connectionId });
    expect(isEnabled('cassandra.cluster', conn(CID))).toBe(true);
    expect(isEnabled('cassandra.cluster', conn('c_shop'))).toBe(false);
    expect(isEnabled('cassandra.cluster')).toBe(false);
    newConsole('c_shop');
    expect(isEnabled('cassandra.cluster')).toBe(false);
    useExplorer.setState({ selectedTarget: conn(CID) });
    expect(isEnabled('cassandra.cluster')).toBe(true);
    runCommand('cassandra.cluster');
    expect(activeView()).toMatchObject({ view: CASSANDRA_VIEWS.cluster, connectionId: CID });
  });

  it('Table keys & storage takes Cassandra tables and materialized views only', () => {
    expect(isEnabled('cassandra.tableInfo', table(CID))).toBe(true);
    expect(isEnabled('cassandra.tableInfo', { ...table(CID), ref: { ...table(CID).ref, type: 'mview', name: 'orders_by_status' } })).toBe(true);
    expect(isEnabled('cassandra.tableInfo', { ...table(CID), ref: { ...table(CID).ref, type: 'type', name: 'address' } })).toBe(false);
    expect(isEnabled('cassandra.tableInfo', table('c_shop'))).toBe(false);
    expect(isEnabled('cassandra.tableInfo')).toBe(false);
    useExplorer.setState({ selectedTarget: table(CID, 'events') });
    runCommand('cassandra.tableInfo');
    expect(activeView()).toMatchObject({ view: CASSANDRA_VIEWS.table, state: { keyspace: 'main', name: 'events' } });
  });

  it('Toggle tracing flips the session setting; Show last trace opens the trace tab', async () => {
    const id = newConsole();
    runCommand('cassandra.toggleTracing');
    await waitFor(() => expect(useSessions.getState().forTab(id)).toBeTruthy());
    const sid = useSessions.getState().forTab(id)!.sessionId;
    await waitFor(() => expect(state().sessions.get(sid)?.settings.tracing).toBe(true));
    await run(sid, 'SELECT * FROM customers WHERE id = 1');
    runCommand('cassandra.showLastTrace');
    await waitFor(() => expect(activeView()?.view).toBe(CASSANDRA_VIEWS.trace));
    expect((activeView().state as TraceViewState).traceId).toBe(state().sessions.get(sid)!.settings.lastTraceId);
  });
});

describe('mock pack shell commands', () => {
  it('answers cqlsh commands and adds the trace result set while tracing is on', async () => {
    const sid = await consoleSessionId(consoleTab(newConsole()));
    await run(sid, 'CONSISTENCY ONE');
    await run(sid, 'TRACING ON');
    await run(sid, 'PAGING 50');
    expect(state().sessions.get(sid)!.settings).toMatchObject({ consistency: 'ONE', tracing: true, pageSize: 50 });
    const h = await run(sid, 'SELECT * FROM customers');
    expect(h.status).toBe('ok');
    const traceId = state().sessions.get(sid)!.settings.lastTraceId!;
    const sets = mock.ctx.engine.sessions.get(sid)!.lastResults!.sets;
    expect(sets.at(-1)!.columns.map((c) => c.name)).toEqual(['activity', 'timestamp', 'source', 'source_elapsed', 'client']);
    expect(state().traces.get(traceId)!.trace.parameters.consistency_level).toBe('ONE');
    expect((await run(sid, 'CONSISTENCY BOGUS')).status).toBe('error');
  });
});

describe('console settings view', () => {
  it('shows and changes the session settings', async () => {
    const cons = newConsole();
    const vid = (() => { runCommand('cassandra.consoleSettings'); return useTabs.getState().activeId!; })();
    show(vid);
    const level = await screen.findByRole('combobox', { name: 'Consistency' });
    const sid = useSessions.getState().forTab(cons)!.sessionId;
    expect(selectValue(level)).toBe('LOCAL_QUORUM');
    // the connection's keyspace (props.keyspace) and the session id
    expect(screen.getByText('shop', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText(sid, { selector: 'code' })).toBeInTheDocument();

    chooseOption(level, { value: 'LOCAL_ONE' });
    await waitFor(() => expect(state().sessions.get(sid)!.settings.consistency).toBe('LOCAL_ONE'));
    expect(screen.getByText('CONSISTENCY LOCAL_ONE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracing' }));
    await waitFor(() => expect(state().sessions.get(sid)!.settings.tracing).toBe(true));

    const page = screen.getByLabelText('Page size');
    fireEvent.change(page, { target: { value: '0' } });
    fireEvent.blur(page);
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 10000');
    fireEvent.change(page, { target: { value: '250' } });
    fireEvent.keyDown(page, { key: 'Enter' });
    await waitFor(() => expect(state().sessions.get(sid)!.settings.pageSize).toBe(250));

    const ttl = screen.getByLabelText('Insert TTL (s)');
    fireEvent.change(ttl, { target: { value: '86400' } });
    fireEvent.blur(ttl);
    await waitFor(() => expect(state().sessions.get(sid)!.settings.insertTtl).toBe(86400));
  });

  it('follows shell commands run in the console and links the last trace', async () => {
    const cons = newConsole();
    runCommand('cassandra.consoleSettings');
    show(useTabs.getState().activeId!);
    const level = await screen.findByRole('combobox', { name: 'Consistency' });
    const sid = useSessions.getState().forTab(cons)!.sessionId;
    await run(sid, 'CONSISTENCY QUORUM');
    await waitFor(() => expect(selectValue(level)).toBe('QUORUM'));
    await run(sid, 'TRACING ON');
    await run(sid, 'SELECT * FROM orders');
    fireEvent.click(await screen.findByRole('button', { name: 'Open trace' }));
    expect(activeView()).toMatchObject({ view: CASSANDRA_VIEWS.trace, connectionId: CID });
  });

  it('Set consistency level opens the level list', async () => {
    newConsole();
    runCommand('cassandra.setConsistency');
    show(useTabs.getState().activeId!);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Consistency' })).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-value'))).toContain('EACH_QUORUM');
    expect((activeView().state as { focus?: string | null }).focus).toBeNull();
  });

  it('says so when the console was closed', async () => {
    const cons = newConsole();
    runCommand('cassandra.consoleSettings');
    const vid = useTabs.getState().activeId!;
    useTabs.getState().close(cons);
    show(vid);
    expect(await screen.findByText('The console of these settings was closed.')).toBeInTheDocument();
  });
});

describe('trace view', () => {
  it('shows the timeline grouped by node, refetching an incomplete trace', async () => {
    const cons = newConsole();
    const sid = await consoleSessionId(consoleTab(cons));
    const first = state().addTrace(sid, 'SELECT * FROM shop.orders WHERE id = 3')!;
    const id = state().addTrace(sid, 'INSERT INTO shop.product_views (product_id) VALUES (1)')!;
    show(openTrace(CID, null, { consoleTabId: cons, sessionId: sid }));
    // the newest trace is selected; its first fetch is incomplete
    expect(await screen.findByText(/still writing this trace/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/still writing this trace/)).toBeNull(), { timeout: 4000 });
    const wf = screen.getByTestId('cassandra-waterfall');
    const full = state().traces.get(id)!.trace;
    const sources = [...new Set(full.events.map((e) => e.source))];
    expect(sources[0]).toBe('10.0.1.11');
    for (const s of sources) expect(within(wf).getByText(s)).toBeInTheDocument();
    expect(within(wf).getByText('coordinator')).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Trace events' })).getAllByRole('row');
    expect(rows).toHaveLength(full.events.length + 1);
    expect(screen.getByText(/INSERT INTO shop.product_views/, { selector: 'pre' })).toBeInTheDocument();

    // switch to the other trace from the list (keyboard)
    const list = screen.getByRole('listbox', { name: 'Recent traces' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect((activeView().state as TraceViewState).traceId).toBe(first));
    expect(await screen.findByText(/SELECT \* FROM shop.orders WHERE id = 3/, { selector: 'pre' })).toBeInTheDocument();
  });

  it('explains how to get a trace when there is none, and reports unknown ids', async () => {
    const cons = newConsole();
    const sid = await consoleSessionId(consoleTab(cons));
    const vid = openTrace(CID, null, { consoleTabId: cons, sessionId: sid });
    show(vid);
    expect(await screen.findByText(/No traced statement yet/)).toBeInTheDocument();
    useTabs.getState().updateView(vid, { state: { traceId: '00000000-0000-1000-8000-000000000000', consoleTabId: cons, sessionId: sid } });
    expect(await screen.findByRole('alert')).toHaveTextContent('was not found');
  });
});

describe('cluster view', () => {
  it('lists datacenters, nodes and clients', async () => {
    show(openCluster(CID));
    expect(await screen.findByText('Cluster Shop Cluster')).toBeInTheDocument();
    expect(screen.getByText('Apache Cassandra 5.0.2')).toBeInTheDocument();
    expect(screen.getByText('4 / 5')).toBeInTheDocument();
    expect(screen.getByText('Murmur3Partitioner')).toBeInTheDocument();
    const dcs = within(screen.getByRole('table', { name: 'Datacenters' })).getAllByRole('row');
    expect(dcs.map((r) => r.textContent)).toEqual(['DatacenterNodesUpRacks', 'datacenter1' + '33rack1, rack2, rack3', 'datacenter2' + '21rack1, rack2']);
    const nodes = within(screen.getByRole('table', { name: 'Nodes' })).getAllByRole('row').slice(1);
    expect(nodes).toHaveLength(5);
    expect(within(nodes[0]).getByText('local')).toBeInTheDocument();
    expect(within(nodes[4]).getByText('down')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Clients' }));
    const clients = await screen.findByRole('table', { name: 'Clients' });
    expect(within(clients).getAllByRole('row')).toHaveLength(5);
    expect(within(clients).getByText('orders-api-7d9f4')).toBeInTheDocument();
  });

  it('explains that clients need Cassandra 4.0 (400 NOT_SUPPORTED)', async () => {
    state().releaseVersion = '3.11.17';
    show(openCluster(CID, 'clients'));
    expect(await screen.findByRole('status')).toHaveTextContent('needs Cassandra 4.0 or later');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('table info view', () => {
  it('shows keys with their order, options, indexes and the DDL', async () => {
    show(openTableInfo(CID, 'main', 'orders_by_customer'));
    const keys = await screen.findByRole('table', { name: 'Primary key columns' });
    const rows = within(keys).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['customer_idintpartition key—', 'order_datetimestampclustering 1 DESCDESC', 'order_idintclustering 2 ASCASC']);
    expect(screen.getByText('PRIMARY KEY (customer_id, order_date, order_id)')).toBeInTheDocument();
    expect(screen.getByText(/CREATE TABLE main.orders_by_customer/, { selector: 'pre' })).toBeInTheDocument();
    expect(screen.getByText('No secondary indexes.')).toBeInTheDocument();
  });

  it('shows static columns, composite partition keys, SAI indexes and views', async () => {
    show(openTableInfo(CID, 'main', 'events'));
    expect(await screen.findByRole('table', { name: 'Static columns' })).toHaveTextContent('day_note');
    expect(screen.getByText('TimeWindow')).toBeInTheDocument();
    useTabs.setState({ tabs: [], activeId: null });
    show(openTableInfo(CID, 'main', 'customers'));
    expect(await screen.findByText('SAI (StorageAttachedIndex)')).toBeInTheDocument();
  });

  it('links a materialized view and its base table', async () => {
    show(openTableInfo(CID, 'main', 'orders'));
    fireEvent.click(await screen.findByRole('button', { name: 'orders_by_status' }));
    expect(activeView()).toMatchObject({ view: CASSANDRA_VIEWS.table, state: { name: 'orders_by_status' } });
  });

  it('reports a missing table', async () => {
    show(openTableInfo(CID, 'main', 'nope'));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not exist');
  });
});

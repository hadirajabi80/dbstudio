// Kafka workspace against the MSW mock engine (mocks/m2/kafka.ts) and the FakeSocket: explorer tree, commands,
// overview, topics, message browser (fetch + live tail), configs, groups, offset reset, produce, typed confirmations.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../../../api/ws';
import { getCommand, isEnabled, runCommand } from '../../../commands/registry';
import type { SourceTarget } from '../../../commands/types';
import { getSourceModule, sourceNodeId } from '../../../lib/sources';
import { FakeSocket } from '../../../mocks/fakeSocket';
import { getConnection, useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { installMockEngine, TEST_ENGINE_URL } from '../../../test/mockServer';
import { useExplorer } from '../../Explorer/explorerStore';
import { registerKafkaCommands } from '../commands';
import { closeKafkaDialog } from '../dialogHost';
import KafkaView from '../KafkaView';
import { openGroup, openOverview, openProduce, openTopic, openTopics, topicTabState } from '../open';
import { kafkaConn, loadGroups, loadTopics, setShowInternal, useKafka } from '../store';
import { kafkaTree } from '../tree';

const CID = 'c_kafka';
const mock = installMockEngine();
beforeAll(() => registerKafkaCommands());
beforeEach(async () => {
  mock.reset();
  closeKafkaDialog();
  useKafka.setState({ conns: {} });
  useTabs.setState({ tabs: [], activeId: null, seq: 0 });
  useExplorer.setState({ expanded: new Set(), filter: '' });
  useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
  await useConnections.getState().load();
  engineSocket.disconnect();
  engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
  engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
  await waitFor(() => expect(engineSocket.status).toBe('open'));
});

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <div data-tab-host={id}><KafkaView tab={tab} theme="light" visible /></div> : null;
}

const show = (id: string) => render(<Host id={id} />);
const topicTarget = (topic: string): SourceTarget => ({ kind: 'source', connectionId: CID, providerId: 'kafka', nodeType: 'topic', path: ['topics', topic] });
const groupTarget = (g: string): SourceTarget => ({ kind: 'source', connectionId: CID, providerId: 'kafka', nodeType: 'group', path: ['groups', g] });

function setReadOnly(readOnly: boolean) {
  useConnections.setState((s) => ({ connections: s.connections.map((c) => (c.id === CID ? { ...c, readOnly } : c)) }));
}

function setRegistry(url: string | null) {
  useConnections.setState((s) => ({ connections: s.connections.map((c) => (c.id === CID ? { ...c, props: { ...c.props, schemaRegistryUrl: url } } : c)) }));
  const conn = mock.ctx.engine.conn(CID);
  if (conn) conn.props = { ...conn.props, schemaRegistryUrl: url };
}

describe('source module and explorer', () => {
  it('registers the kafka module with menus for topics, groups and the cluster', () => {
    const m = getSourceModule('kafka')!;
    expect(m.kind).toBe('stream');
    const row = (nodeType: string, path: string[]) => ({ id: 'x', kind: 'source' as const, depth: 1, label: '', expandable: false, expanded: false,
      source: { providerId: 'kafka' as const, nodeType, path } });
    expect(m.contextMenuId(row('topic', ['topics', 'orders']))).toBe('explorer.kafka.topic');
    expect(m.contextMenuId(row('group', ['groups', 'billing']))).toBe('explorer.kafka.group');
    expect(m.contextMenuId(row('topics', ['topics']))).toBe('explorer.kafka.cluster');
  });

  it('lists overview, topics with counts and groups; internal topics only on request', async () => {
    const conn = getConnection(CID)!;
    const expanded = new Set([`c:${CID}`, sourceNodeId(CID, ['topics']), sourceNodeId(CID, ['groups'])]);
    expect(kafkaTree({ connection: conn, depth: 1, expanded, filter: '' }).some((r) => r.status === 'loading')).toBe(true);
    await loadTopics(CID);
    await loadGroups(CID);
    const rows = kafkaTree({ connection: conn, depth: 1, expanded, filter: '' });
    expect(rows.map((r) => r.label)).toEqual(['Overview', 'Topics', 'compacted-users', 'events', 'orders', 'payments', 'Consumer groups', 'analytics', 'billing', 'shipping']);
    expect(rows.find((r) => r.label === 'Topics')?.count).toBe(4);
    expect(rows.find((r) => r.label === 'orders')?.detail).toContain('3p');
    expect(rows.find((r) => r.label === 'payments')?.detail).toContain('under-replicated');
    setShowInternal(CID, true);
    await waitFor(() => expect(kafkaConn(CID).topics.data?.some((t) => t.name === '__consumer_offsets')).toBe(true));
  });

  it('filters the tree and contributes Ctrl+P topic entries', async () => {
    await loadTopics(CID);
    await loadGroups(CID);
    const rows = kafkaTree({ connection: getConnection(CID)!, depth: 1, expanded: new Set([`c:${CID}`]), filter: 'pay' });
    expect(rows.map((r) => r.label)).toEqual(['Topics', 'payments']);
    const entries = getSourceModule('kafka')!.paletteEntries();
    expect(entries.find((e) => e.name === 'orders')).toMatchObject({ type: 'kafka.topic', connectionId: CID });
  });

  it('default workspace opens the cluster overview', async () => {
    getSourceModule('kafka')!.defaultWorkspace(CID);
    const tab = useTabs.getState().tabs[0] as ViewTab;
    expect(tab.view).toBe('kafka.overview');
    expect(tab.key).toBe(`${CID}:kafka.overview:`);
  });
});

describe('commands', () => {
  it('registers every reserved menu command', () => {
    for (const id of ['kafka.overview', 'kafka.createTopic', 'kafka.browseMessages', 'kafka.produce', 'kafka.topicConfigs', 'kafka.topicGroups', 'kafka.addPartitions',
      'kafka.deleteTopic', 'kafka.openGroup', 'kafka.resetOffsets', 'kafka.deleteGroup']) {
      expect(getCommand(id), id).toBeDefined();
    }
  });

  it('write commands are disabled on a read-only connection; reads stay enabled', () => {
    expect(isEnabled('kafka.produce', topicTarget('orders'))).toBe(true);
    setReadOnly(true);
    for (const id of ['kafka.produce', 'kafka.addPartitions', 'kafka.deleteTopic', 'kafka.purgeTopic', 'kafka.deleteGroup']) {
      expect(isEnabled(id, id.includes('Group') ? groupTarget('billing') : topicTarget('orders')), id).toBe(false);
    }
    expect(isEnabled('kafka.browseMessages', topicTarget('orders'))).toBe(true);
    expect(isEnabled('kafka.resetOffsets', groupTarget('billing'))).toBe(true); // dry run stays available
  });

  it('browse messages opens the topic tab on the Messages sub-view; re-opening activates it', () => {
    runCommand('kafka.browseMessages', topicTarget('orders'));
    runCommand('kafka.topicConfigs', topicTarget('orders'));
    const tabs = useTabs.getState().tabs as ViewTab[];
    expect(tabs).toHaveLength(1);
    expect(topicTabState(tabs[0]).sub).toBe('configs');
  });
});

describe('views', () => {
  it('overview shows tiles and brokers with the controller', async () => {
    show(openOverview(CID));
    expect(await screen.findByRole('table', { name: 'Brokers' })).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Brokers' })).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('controller');
    expect(screen.getByText('Under-replicated').previousSibling).toHaveTextContent('1');
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Broker configs' }));
    expect(await screen.findByText('log.retention.hours')).toBeInTheDocument();
    expect(screen.getByText('•••••• (sensitive)')).toBeInTheDocument();
  });

  it('topics grid searches and filters under-replicated topics', async () => {
    show(openTopics(CID));
    const table = await screen.findByRole('table', { name: 'Topics' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Under-replicated' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Under-replicated' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search topics' }), { target: { value: 'ord' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('message browser fetches the latest messages over the kafka.fetch stream, newest first', async () => {
    show(openTopic(CID, 'orders', 'messages'));
    const list = await screen.findByRole('listbox', { name: 'Messages' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/messages · .* scanned/));
    const options = within(list).getAllByRole('option');
    expect(options.length).toBeGreaterThan(5);
    // newest first: offsets of the first row are the highest
    expect(options[0]).toHaveTextContent('99');
    fireEvent.click(options[0]);
    expect(await screen.findByLabelText('Message detail')).toHaveTextContent('traceparent');
  });

  it('search in value narrows the fetch', async () => {
    const id = openTopic(CID, 'orders', 'messages', { browse: { partitions: null, start: { kind: 'oldest' }, limit: 500, keyFormat: 'string', valueFormat: 'json', search: 'rush', caseSensitive: false } });
    show(id);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('30 messages matching “rush”'));
  });

  it('live tail appends messages, pauses and resumes', async () => {
    show(openTopic(CID, 'orders', 'messages'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/messages · .* scanned/));
    fireEvent.click(screen.getByRole('button', { name: 'Live tail' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Live · [1-9]/), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Paused'));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Live'));
    fireEvent.click(screen.getByRole('button', { name: 'Live tail' }));
    await waitFor(() => expect(mock.ctx.engine).toBeDefined());
  });

  it('configs: edit, reset and save via IncrementalAlterConfigs', async () => {
    show(openTopic(CID, 'orders', 'configs'));
    const table = await screen.findByRole('table', { name: 'Topic configs' });
    const retention = within(table).getByText('retention.ms').closest('tr')!;
    expect(retention).toHaveClass('kafka-changed');
    const seg = within(table).getByText('segment.bytes').closest('tr')!;
    fireEvent.click(within(seg).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Value of segment.bytes' }), { target: { value: '536870912' } });
    fireEvent.click(within(retention).getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mock.hits('/topics/orders/configs', 'PUT')).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Topic configs' })).getByText('segment.bytes').closest('tr')).toHaveClass('kafka-changed'));
  });

  it('groups grid shows lag heat; the group tab lists members and partitions', async () => {
    const { unmount } = show(openTopics(CID));
    unmount();
    runCommand('kafka.groups', topicTarget('orders'));
    const id = useTabs.getState().activeId!;
    show(id);
    const table = await screen.findByRole('table', { name: 'Consumer groups' });
    const billing = within(table).getByText('billing').closest('tr')!;
    expect(billing.querySelector('.kafka-lag-ok, .kafka-lag-warn, .kafka-lag-danger')).not.toBeNull();
    show(openGroup(CID, 'shipping'));
    expect(await screen.findByRole('table', { name: 'Members' })).toHaveTextContent('shipper-1');
    expect(screen.getByRole('table', { name: 'Group partitions' })).toHaveTextContent('orders');
  });

  it('offset reset: dry run preview, typed confirmation, then apply on an empty group', async () => {
    runCommand('kafka.resetOffsets', groupTarget('billing'));
    const dialog = await screen.findByRole('dialog', { name: 'Reset offsets · billing' });
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview (dry run)' }));
    const preview = await within(dialog).findByRole('table', { name: 'Offset reset preview' });
    expect(within(preview).getAllByRole('row')).toHaveLength(6);
    expect(apply).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type billing to apply' }), { target: { value: 'billing' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.hits('/groups/billing/offsets', 'POST')).toHaveLength(2);
  });

  it('offset reset on an active group is refused with its members', async () => {
    runCommand('kafka.resetOffsets', groupTarget('shipping'));
    const dialog = await screen.findByRole('dialog', { name: 'Reset offsets · shipping' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview (dry run)' }));
    await within(dialog).findByRole('table', { name: 'Offset reset preview' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type shipping to apply' }), { target: { value: 'shipping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('stop its consumers');
    expect(within(dialog).getByRole('list', { name: 'Active members' })).toHaveTextContent('shipper-2');
  });

  it('delete topic needs the typed name and closes its tabs', async () => {
    openTopic(CID, 'events');
    runCommand('kafka.deleteTopic', topicTarget('events'));
    const dialog = await screen.findByRole('dialog', { name: 'Delete topic' });
    const del = within(dialog).getByRole('button', { name: 'Delete topic' });
    expect(del).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type events to confirm' }), { target: { value: 'event' } });
    expect(del).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type events to confirm' }), { target: { value: 'events' } });
    fireEvent.click(del);
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(0));
    expect(kafkaConn(CID).topics.data?.some((t) => t.name === 'events')).toBe(false);
  });

  it('produce sends messages with headers and repeat, and shows the offsets', async () => {
    show(openProduce(CID, 'events', { value: 'hello ${i}', valueFormat: 'string', headers: [{ key: 'h', value: 'v' }], repeat: 3 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Produce 3×' }));
    const results = await screen.findByRole('table', { name: 'Produced messages' });
    expect(within(results).getAllByRole('row')).toHaveLength(4);
    expect(within(results).getAllByRole('row')[1]).toHaveTextContent('25');
  });

  it('produce on a read-only connection is disabled', async () => {
    setReadOnly(true);
    show(openProduce(CID, 'events'));
    expect(await screen.findByText(/read-only: producing is disabled/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Produce' })).toBeDisabled();
  });

  it('schema-registry formats need a configured registry', async () => {
    setRegistry(null);
    show(openProduce(CID, 'payments'));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Value format' }));
    expect(screen.getByRole('option', { name: /Avro \(SR\)/ })).toHaveAttribute('aria-disabled', 'true');
  });
});

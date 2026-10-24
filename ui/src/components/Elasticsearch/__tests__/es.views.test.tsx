// Elasticsearch workspace against the MSW mock engine (mocks/packs/elasticsearch.ts) and the FakeSocket: source module,
// explorer tree, commands (read-only), overview, indices, documents (edit with optimistic concurrency), search with
// aggregations, Dev Tools console, SQL, dialogs (create/delete index, reindex job), tasks stream.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { engineSocket } from '../../../api/ws';
import { getCommand, isEnabled, runCommand } from '../../../commands/registry';
import type { SourceTarget } from '../../../commands/types';
import { getSourceModule, sourceNodeId } from '../../../lib/sources';
import { FakeSocket } from '../../../mocks/fakeSocket';
import { getConnection, useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { installMockEngine, TEST_ENGINE_URL } from '../../../test/mockServer';
import { useExplorer } from '../../Explorer/explorerStore';
import { registerEsCommands } from '../commands';
import { closeEsDialog } from '../dialogHost';
import EsView from '../EsView';
import { openConsole, openIndex, openIndices, openOverview, openSearch, openSql, openTasks } from '../open';
import { esConn, loadAliases, loadIndices, useEs } from '../store';
import { esTree } from '../tree';

const CID = 'c_es';
const mock = installMockEngine();
beforeAll(() => registerEsCommands());
beforeEach(async () => {
  mock.reset();
  closeEsDialog();
  useEs.setState({ conns: {}, fields: {} });
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
  return tab ? <div data-tab-host={id}><EsView tab={tab} theme="light" visible /></div> : null;
}

const show = (id: string) => render(<Host id={id} />);
const indexTarget = (index: string): SourceTarget => ({ kind: 'source', connectionId: CID, providerId: 'elasticsearch', nodeType: 'index', path: ['indices', index] });

function setReadOnly(readOnly: boolean) {
  useConnections.setState((s) => ({ connections: s.connections.map((c) => (c.id === CID ? { ...c, readOnly } : c)) }));
  const conn = mock.ctx.engine.conn(CID);
  if (conn) conn.readOnly = readOnly;
}

describe('source module and explorer', () => {
  it('registers the module with menus for indices, aliases and the cluster', () => {
    const m = getSourceModule('elasticsearch')!;
    expect(m.kind).toBe('search');
    const row = (nodeType: string, path: string[]) => ({ id: 'x', kind: 'source' as const, depth: 1, label: '', expandable: false, expanded: false,
      source: { providerId: 'elasticsearch' as const, nodeType, path } });
    expect(m.contextMenuId(row('index', ['indices', 'shop-orders']))).toBe('explorer.es.index');
    expect(m.contextMenuId(row('alias', ['aliases', 'shop-sales']))).toBe('explorer.es.alias');
    expect(m.contextMenuId(row('indices', ['indices']))).toBe('explorer.es.cluster');
  });

  it('lists the folders, indices with counts and aliases; filter narrows; Ctrl+P entries', async () => {
    const conn = getConnection(CID)!;
    const expanded = new Set([`c:${CID}`, sourceNodeId(CID, ['indices']), sourceNodeId(CID, ['aliases'])]);
    expect(esTree({ connection: conn, depth: 1, expanded, filter: '' }).some((r) => r.status === 'loading')).toBe(true);
    await loadIndices(CID);
    await loadAliases(CID);
    const rows = esTree({ connection: conn, depth: 1, expanded, filter: '' });
    expect(rows.map((r) => r.label)).toEqual(['Overview', 'Dev Tools', 'SQL', 'Indices', 'shop-customers', 'shop-orders', 'shop-products', 'Aliases', 'shop-sales',
      'Data streams', 'Templates', 'Nodes', 'Tasks']);
    expect(rows.find((r) => r.label === 'Indices')?.count).toBe(3);
    expect(rows.find((r) => r.label === 'shop-orders')?.detail).toMatch(/^2,000 docs · /);
    expect(rows.find((r) => r.label === 'shop-sales')?.detail).toBe('→ shop-orders');
    expect(esTree({ connection: conn, depth: 1, expanded, filter: 'prod' }).map((r) => r.label)).toEqual(['Indices', 'shop-products']);
    expect(getSourceModule('elasticsearch')!.paletteEntries().find((e) => e.name === 'shop-orders')).toMatchObject({ type: 'es.index', connectionId: CID });
  });

  it('default workspace opens the overview', () => {
    getSourceModule('elasticsearch')!.defaultWorkspace(CID);
    expect((useTabs.getState().tabs[0] as ViewTab).view).toBe('es.overview');
  });
});

describe('commands', () => {
  it('registers the menu commands and honours read-only connections', async () => {
    await loadIndices(CID);
    for (const id of ['es.overview', 'es.console', 'es.sql', 'es.search', 'es.reindex', 'es.export', 'es.import', 'es.deleteIndex', 'es.addAlias']) expect(getCommand(id), id).toBeDefined();
    expect(isEnabled('es.deleteIndex', indexTarget('shop-orders'))).toBe(true);
    setReadOnly(true);
    for (const id of ['es.deleteIndex', 'es.createIndex', 'es.reindex', 'es.import', 'es.addAlias', 'es.closeIndex']) expect(isEnabled(id, indexTarget('shop-orders')), id).toBe(false);
    for (const id of ['es.openIndex', 'es.search', 'es.export', 'es.refreshIndex', 'es.mappings']) expect(isEnabled(id, indexTarget('shop-orders')), id).toBe(true);
  });

  it('index sub-view commands open one tab per index', () => {
    runCommand('es.openIndex', indexTarget('shop-orders'));
    runCommand('es.mappings', indexTarget('shop-orders'));
    const tabs = useTabs.getState().tabs as ViewTab[];
    expect(tabs).toHaveLength(1);
    expect((tabs[0].state as { sub: string }).sub).toBe('mappings');
  });
});

describe('views', () => {
  it('overview shows health, tiles, nodes and the largest indices', async () => {
    show(openOverview(CID));
    expect(await screen.findByText('rowlit-dev')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Cluster summary' })).toHaveTextContent('Documents');
    const nodes = await screen.findByRole('table', { name: 'Nodes' });
    await waitFor(() => expect(within(nodes).getAllByRole('row')).toHaveLength(4));
    expect(within(nodes).getByLabelText('Elected master')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open shop-orders' })).toBeInTheDocument();
  });

  it('indices view lists indices, toggles hidden ones and opens an index', async () => {
    show(openIndices(CID));
    const table = await screen.findByRole('table', { name: 'Indices' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    fireEvent.click(screen.getByRole('checkbox', { name: /Hidden and system indices/ }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(6));
    expect(table).toHaveTextContent('logs-app-default');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter indices' }), { target: { value: 'sales' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(within(table).getByText('shop-orders'));
    expect((useTabs.getState().tabs.find((t) => t.kind === 'view' && t.view === 'es.index') as ViewTab).key).toBe(`${CID}:es.index:shop-orders`);
  });

  it('documents grid pages and filters with a Lucene query; the record shows the document', async () => {
    show(openIndex(CID, 'shop-customers'));
    const grid = await screen.findByRole('grid', { name: 'Documents' });
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(51));
    expect(screen.getByText(/1–50 of 200/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText(/51–100 of 200/)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Query string' }), { target: { value: 'tier:gold AND address.city:Tehran' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByText(/of \d+$|of \d+ ·/)).toBeInTheDocument());
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBeLessThan(30));
    fireEvent.change(screen.getByRole('textbox', { name: 'Query string' }), { target: { value: 'name:رضایی' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));
    const record = screen.getByRole('complementary', { name: 'Document' });
    expect(record).toHaveTextContent('c0ffee000000000000000002');
    expect(within(record).getByRole('tree', { name: 'Document source' })).toHaveTextContent('علی رضایی');
  });

  it('editing a document uses if_seq_no; a concurrent change shows the conflict, reload and save', async () => {
    show(openIndex(CID, 'shop-products'));
    const grid = await screen.findByRole('grid', { name: 'Documents' });
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBeGreaterThan(10));
    const first = within(grid).getAllByRole('row')[1];
    const id = first.getAttribute('data-doc-id')!;
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    const editor = await screen.findByRole('textbox', { name: 'Document JSON' });
    // someone else writes the document meanwhile
    const cur = await api.es.doc(CID, 'shop-products', id);
    await api.es.putDoc(CID, 'shop-products', id, { source: { ...(cur.source as object), stock: 1 } });
    fireEvent.change(editor, { target: { value: JSON.stringify({ ...(cur.source as object), stock: 999 }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone changed this document/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Document JSON' }) as HTMLTextAreaElement).value).toContain('"stock": 1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Document JSON' }), { target: { value: JSON.stringify({ ...(cur.source as object), stock: 42 }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Document JSON' })).toBeNull());
    expect(((await api.es.doc(CID, 'shop-products', id)).source as { stock: number }).stock).toBe(42);
  });

  it('read-only connections disable document writes', async () => {
    setReadOnly(true);
    show(openIndex(CID, 'shop-products'));
    const grid = await screen.findByRole('grid', { name: 'Documents' });
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBeGreaterThan(10));
    expect(screen.getByRole('button', { name: 'Edit document' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Document$/ })).toBeDisabled();
  });

  it('mappings list fields with types', async () => {
    show(openIndex(CID, 'shop-orders', 'mappings'));
    const table = await screen.findByRole('table', { name: 'Fields' });
    await waitFor(() => expect(table).toHaveTextContent('items'));
    expect(table).toHaveTextContent('nested');
    expect(table).toHaveTextContent('customerId');
  });

  it('search runs the DSL and shows hits and aggregations', async () => {
    const body = JSON.stringify({ query: { term: { status: 'paid' } }, aggs: { per_month: { date_histogram: { field: 'createdAt', calendar_interval: 'month' }, aggs: { revenue: { sum: { field: 'total' } } } } }, size: 3 });
    show(openSearch(CID, 'shop-orders', body, true));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Hits' })).toBeInTheDocument());
    expect(within(screen.getByRole('list', { name: 'Hits' })).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('tab', { name: /Aggregations/ }));
    const agg = await screen.findByRole('region', { name: 'Aggregation per_month' });
    expect(agg).toHaveTextContent('revenue');
    expect(within(agg).getAllByRole('row').length).toBeGreaterThan(10);
  });

  it('search reports DSL errors from the engine', async () => {
    show(openSearch(CID, 'shop-orders', '{ "query": { "bogus": {} } }', true));
    expect(await screen.findByRole('alert')).toHaveTextContent('parsing_exception: unknown query [bogus]');
  });

  it('console runs the request at the cursor and shows status and body', async () => {
    show(openConsole(CID));
    const editor = await screen.findByRole('textbox', { name: 'Console requests' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'GET /_cat/indices?v&s=index\n\nGET /_cluster/health' } });
    editor.setSelectionRange(3, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByText('200 OK')).toBeInTheDocument());
    expect((screen.getByRole('textbox', { name: 'Response' }) as HTMLTextAreaElement).value).toMatch(/health\s+status\s+index/);
    editor.setSelectionRange(editor.value.length, editor.value.length);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Response' }) as HTMLTextAreaElement).value).toContain('"cluster_name": "rowlit-dev"'));
  });

  it('console on a read-only connection refuses writes', async () => {
    setReadOnly(true);
    show(openConsole(CID));
    const editor = await screen.findByRole('textbox', { name: 'Console requests' });
    fireEvent.change(editor, { target: { value: 'DELETE /shop-orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/read-only/);
    expect(esConn(CID).indices.data?.some((i) => i.name === 'shop-orders') ?? true).toBe(true);
  });

  it('SQL runs a GROUP BY and translates to DSL', async () => {
    show(openSql(CID));
    fireEvent.click(await screen.findByRole('button', { name: /Run/ }));
    const table = await screen.findByRole('table', { name: 'SQL results' });
    expect(table).toHaveTextContent('revenue');
    expect(within(table).getAllByRole('row').length).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: /Translate to DSL/ }));
    expect(await screen.findByText('Query DSL')).toBeInTheDocument();
  });

  it('tasks view streams running tasks with progress', async () => {
    show(openTasks(CID));
    const table = await screen.findByRole('table', { name: 'Tasks' });
    await waitFor(() => expect(table).toHaveTextContent('indices:data/write/update/byquery'));
    expect(within(table).getByRole('button', { name: /Cancel/ })).toBeEnabled();
  });
});

describe('dialogs', () => {
  it('create index validates the name and creates it', async () => {
    runCommand('es.createIndex', { kind: 'connection', connectionId: CID });
    const name = await screen.findByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: 'Bad Name' } });
    expect(screen.getByText(/lowercase/)).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'new-index' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(esConn(CID).indices.data?.some((i) => i.name === 'new-index')).toBe(true));
  });

  it('delete index needs the typed name', async () => {
    await loadIndices(CID);
    runCommand('es.deleteIndex', indexTarget('shop-products'));
    const button = await screen.findByRole('button', { name: 'Delete index' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Type shop-products to confirm' }), { target: { value: 'shop-products' } });
    fireEvent.click(button);
    await waitFor(() => expect(esConn(CID).indices.data?.some((i) => i.name === 'shop-products')).toBe(false));
  });

  it('reindex runs as a job with progress and a result', async () => {
    await loadIndices(CID);
    runCommand('es.reindex', indexTarget('shop-products'));
    expect(await screen.findByLabelText(/^Destination/)).toHaveValue('shop-products-copy');
    fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
    await waitFor(() => expect(screen.getByText(/50 created/)).toBeInTheDocument(), { timeout: 4000 });
    await waitFor(() => expect(esConn(CID).indices.data?.find((i) => i.name === 'shop-products-copy')?.docsCount).toBe(50));
  });

  it('import parses NDJSON and bulk-loads it', async () => {
    const { ImportDialog } = await import('../dialogs');
    const done: string[] = [];
    render(<ImportDialog cid={CID} index="imported" onClose={() => undefined} onDone={(i) => done.push(i)}
      initialFile={{ name: 'rows.ndjson', path: null, content: '{"a":1}\n{"a":2}\n{"a":3}\n' }} />);
    expect(await screen.findByText('Preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import/ }));
    await waitFor(() => expect(done).toEqual(['imported']), { timeout: 4000 });
    expect((await api.es.search(CID, { index: 'imported' })).total).toBe(3);
  });
});

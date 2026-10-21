// Aggregations, schema, indexes, validation, explain, change stream, import/export (docs/PLAN-M2.md 6.3–6.5).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { useUi } from '../../../store/ui';
import { stagesFromText, stageError, stageText } from '../AggregationView';
import { CID, renderCollection, setupMongo, tabStateOf } from './helpers';
import { ImportDialog } from '../ImportDialog';
import { ExportDialog } from '../ExportDialog';
import { newStage } from '../open';

const { reset } = setupMongo();
beforeEach(reset);

describe('aggregation builder', () => {
  it('previews each stage (10 documents) and runs the pipeline', async () => {
    const pipeline = [newStage('$match', '{ status: "paid" }'), newStage('$group', '{ _id: "$customer", n: { $sum: 1 } }'), newStage('$sort', '{ n: -1 }')];
    renderCollection('orders', 'aggregate', { pipeline });
    const previews = await screen.findAllByLabelText(/^Output after stage/);
    expect(previews).toHaveLength(3);
    await waitFor(() => expect(previews[0]).toHaveTextContent(/Output after \$match: first 10 documents/), { timeout: 4000 });
    await waitFor(() => expect(previews[2]).toHaveTextContent(/Output after \$sort/), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    const out = await screen.findByRole('region', { name: 'Pipeline output' });
    await waitFor(() => expect(within(out).getAllByRole('listitem').length).toBeGreaterThan(0));
  });

  it('flags an invalid stage and blocks later previews', async () => {
    renderCollection('orders', 'aggregate', { pipeline: [newStage('$match', '{ status: }'), newStage('$limit', '5')] });
    const previews = await screen.findAllByLabelText(/^Output after stage/);
    await waitFor(() => expect(previews[1]).toHaveTextContent('Fix stage 1 first.'));
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/Unexpected '}'/);
  });

  it('adds, moves, disables and deletes stages', async () => {
    const { id } = renderCollection('orders', 'aggregate', { pipeline: [newStage('$match', '{}')] });
    fireEvent.click(await screen.findByRole('button', { name: /Add stage$/ }));
    expect(tabStateOf(id).pipeline).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move stage up' })[1]);
    expect(tabStateOf(id).pipeline!.map((s) => s.op)).toEqual(['$match', '$match']);
    fireEvent.click(screen.getByRole('switch', { name: 'Stage 1 enabled' }));
    expect(tabStateOf(id).pipeline![0].enabled).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete stage' })[0]);
    expect(tabStateOf(id).pipeline).toHaveLength(1);
  });

  it('keyboard: Alt+Down moves the focused stage, Ctrl+/ toggles it', async () => {
    const { id } = renderCollection('orders', 'aggregate', { pipeline: [newStage('$match', '{}'), newStage('$limit', '3')] });
    const heads = await screen.findAllByLabelText(/^Stage \d: /);
    fireEvent.keyDown(heads[0], { key: 'ArrowDown', altKey: true });
    expect(tabStateOf(id).pipeline!.map((s) => s.op)).toEqual(['$limit', '$match']);
    fireEvent.keyDown(screen.getAllByLabelText(/^Stage \d: /)[0], { key: '/', ctrlKey: true });
    expect(tabStateOf(id).pipeline![0].enabled).toBe(false);
  });

  it('skips write stages in previews and confirms before running them', async () => {
    renderCollection('orders', 'aggregate', { pipeline: [newStage('$match', '{ status: "paid" }'), newStage('$out', '"paid_copy"')] });
    const previews = await screen.findAllByLabelText(/^Output after stage/);
    await waitFor(() => expect(previews[1]).toHaveTextContent('the write stage is skipped in previews'), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => expect(useUi.getState().confirm?.title).toBe('Run a write stage?'));
    act(() => useUi.getState().resolveConfirm(true));
    await waitFor(async () => expect((await api.mongo.collections(CID, 'shop')).map((c) => c.name)).toContain('paid_copy'));
  });

  it('exports the pipeline to code in five languages', async () => {
    renderCollection('orders', 'aggregate', { pipeline: [newStage('$match', '{ status: "paid" }')] });
    fireEvent.click(await screen.findByRole('button', { name: /Export to code/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Export pipeline to code' });
    expect(within(dlg).getByLabelText('Generated code')).toHaveTextContent("db.getSiblingDB('shop').getCollection('orders').aggregate([");
    fireEvent.click(within(dlg).getByRole('tab', { name: 'Python' }));
    expect(within(dlg).getByLabelText('Generated code')).toHaveTextContent("pipeline = [{'$match': {'status': 'paid'}}]");
    for (const l of ['Node.js', 'C#', 'Java']) {
      fireEvent.click(within(dlg).getByRole('tab', { name: l }));
      expect(within(dlg).getByLabelText('Generated code').textContent!.length).toBeGreaterThan(100);
    }
  });

  it('parses pasted pipelines into stages', () => {
    const s = stagesFromText('[{ $match: { a: 1 } }, { $limit: 5 }]');
    expect(s.map((x) => x.op)).toEqual(['$match', '$limit']);
    expect(stageText(s[1])).toBe('{ $limit: 5 }');
    expect(stageError(newStage('$match', ''))).toMatch(/empty/);
    expect(() => stagesFromText('[{ a: 1 }]')).toThrow(/one \$stage field/);
  });
});

describe('schema, indexes, validation, explain', () => {
  it('analyzes the schema and flags mixed types', async () => {
    renderCollection('customers', 'schema');
    fireEvent.click((await screen.findAllByRole('button', { name: /Analyze schema/ }))[0]);
    const table = await screen.findByRole('table', { name: 'Fields' });
    expect(within(table).getByText('phone')).toBeInTheDocument();
    expect(within(table).getAllByText('mixed types').length).toBeGreaterThan(0);
    expect(screen.getByText(/60 documents sampled/)).toBeInTheDocument();
  });

  it('uses a schema example as a filter', async () => {
    const { id } = renderCollection('customers', 'schema');
    fireEvent.click((await screen.findAllByRole('button', { name: /Analyze schema/ }))[0]);
    await screen.findByRole('table', { name: 'Fields' });
    const tierChip = screen.getAllByTitle('Use as filter').find((b) => /^"(gold|silver|bronze)"$/.test(b.textContent!))!;
    fireEvent.click(tierChip);
    expect(tabStateOf(id).sub).toBe('documents');
    expect(tabStateOf(id).query?.filter).toMatch(/^\{ tier: "(gold|silver|bronze)" \}$/);
  });

  it('lists indexes, creates one with progress and drops it', async () => {
    renderCollection('orders', 'indexes');
    const table = await screen.findByRole('table', { name: 'Indexes' });
    expect(within(table).getByText('status_1_createdAt_-1')).toBeInTheDocument();
    expect(within(table).getByText('Compound')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Create index/ }));
    const dlg = await screen.findByRole('dialog', { name: /Create index on shop.orders/ });
    fireEvent.change(within(dlg).getByRole('combobox', { name: 'Field 1' }), { target: { value: 'total' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create index' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Indexes' })).getByText('total_1')).toBeInTheDocument(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: 'Drop index total_1' }));
    await waitFor(() => expect(useUi.getState().confirm?.title).toBe('Drop index total_1?'));
    act(() => useUi.getState().resolveConfirm(true));
    await waitFor(() => expect(screen.queryByText('total_1')).not.toBeInTheDocument());
  });

  it('refuses a TTL on a compound index', async () => {
    renderCollection('products', 'indexes');
    fireEvent.click(await screen.findByRole('button', { name: /Create index/ }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('button', { name: /Add field/ }));
    fireEvent.change(within(dlg).getByLabelText('TTL (seconds)'), { target: { value: '60' } });
    expect(within(dlg).getByRole('alert')).toHaveTextContent('TTL indexes have exactly one field.');
  });

  it('edits validation rules and tests them against the data', async () => {
    renderCollection('customers', 'validation');
    const editor = (await screen.findByRole('textbox', { name: 'Validator' })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('$jsonSchema'));
    fireEvent.change(editor, { target: { value: '{ tier: "gold" }' } });
    fireEvent.click(screen.getByRole('button', { name: /Test against sample/ }));
    const test = await screen.findByRole('region', { name: 'Validation test' });
    expect(test).toHaveTextContent(/documents would fail/);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(async () => expect((await api.mongo.validation(CID, 'shop', 'customers')).validator).toContain('gold'));
  });

  it('shows the explain summary with the COLLSCAN warning', async () => {
    renderCollection('orders', 'explain', { query: { filter: '{ total: { $gt: 100 } }', projection: '', sort: '{ total: -1 }', collation: '', skip: 0, limit: 20, maxTimeMs: 30000 }, runSeq: 1 });
    const summary = await screen.findByRole('region', { name: 'Query performance summary' });
    expect(summary).toHaveTextContent('No index');
    expect(screen.getByRole('list', { name: 'Warnings' })).toHaveTextContent('Collection scan: no index was used');
    const tree = screen.getByRole('tree', { name: 'Winning plan' });
    expect(within(tree).getByText('COLLSCAN')).toBeInTheDocument();
    expect(within(tree).getByText('SORT')).toBeInTheDocument();
  });

  it('explains an indexed query as IXSCAN', async () => {
    renderCollection('orders', 'explain', { query: { filter: '{ status: "paid" }', projection: '', sort: '', collation: '', skip: 0, limit: 20, maxTimeMs: 30000 }, runSeq: 1 });
    const summary = await screen.findByRole('region', { name: 'Query performance summary' });
    expect(summary).toHaveTextContent('status_1_createdAt_-1');
    expect(within(screen.getByRole('tree', { name: 'Winning plan' })).getByText('IXSCAN')).toBeInTheDocument();
  });

  it('opens Explain from the query bar', async () => {
    const { id } = renderCollection('orders');
    fireEvent.click(await screen.findByRole('button', { name: /Explain/ }));
    expect(tabStateOf(id).sub).toBe('explain');
    expect(await screen.findByRole('region', { name: 'Query performance summary' })).toBeInTheDocument();
  });
});

describe('change stream, import and export', () => {
  it('counts changes while watching and refreshes on click', async () => {
    renderCollection('products');
    await waitFor(() => expect(document.querySelectorAll('.mg-card').length).toBe(12));
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Watching' })).toBeInTheDocument());
    await api.mongo.insert(CID, 'shop', 'products', { doc: '{ sku: "LIVE" }' });
    const badge = await screen.findByRole('button', { name: /\+1 change, click to refresh/ });
    fireEvent.click(badge);
    await waitFor(() => expect(document.querySelectorAll('.mg-card').length).toBe(13));
    expect(screen.queryByText(/click to refresh/)).not.toBeInTheDocument();
  });

  it('previews a CSV with type mapping and imports it', async () => {
    const csv = 'sku,qty,price,active,since\nA-1,3,9.5,true,2024-01-02\nA-2,x,1.5,false,2024-02-03\n';
    render(<ImportDialog cid={CID} db="shop" coll="products" collections={['products']} onClose={() => undefined} initialFile={{ name: 'p.csv', path: null, content: csv }} />);
    const map = await screen.findByRole('table', { name: 'Column types' });
    expect(within(map).getByRole('combobox', { name: 'Type of price' })).toHaveTextContent('Number');
    expect(within(map).getByRole('combobox', { name: 'Type of active' })).toHaveTextContent('Boolean');
    expect(within(map).getByRole('combobox', { name: 'Type of since' })).toHaveTextContent('Date');
    expect(within(map).getByRole('combobox', { name: 'Type of qty' })).toHaveTextContent('String');
    fireEvent.click(screen.getByRole('button', { name: /^Import$/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('2 documents inserted');
    const r = await api.mongo.find(CID, 'shop', 'products', { filter: '{ sku: "A-1" }', skip: 0, limit: 5 });
    expect(r.docs[0]).toContain('"price":{"$numberDouble":"9.5"}');
    expect(r.docs[0]).toContain('"active":true');
  });

  it('reports row errors after a type override', async () => {
    const csv = 'sku,qty\nB-1,3\nB-2,x\n';
    render(<ImportDialog cid={CID} db="shop" coll="products" collections={['products']} onClose={() => undefined} initialFile={{ name: 'q.csv', path: null, content: csv }} />);
    const map = await screen.findByRole('table', { name: 'Column types' });
    fireEvent.click(within(map).getByRole('combobox', { name: 'Type of qty' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Number' }));
    await waitFor(() => expect(screen.getByText(/'x' is not a number for column qty/)).toBeInTheDocument());
  });

  it('imports JSON Lines with upsert', async () => {
    const lines = '{ _id: "u1", sku: "U" }\n{ _id: "u1", sku: "U2" }\n';
    render(<ImportDialog cid={CID} db="shop" coll="products" collections={['products']} onClose={() => undefined} initialFile={{ name: 'u.jsonl', path: null, content: lines }} />);
    await screen.findByText(/Preview: 2 documents/);
    fireEvent.click(screen.getByRole('radio', { name: 'Upsert' }));
    fireEvent.click(screen.getByRole('button', { name: /^Import$/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/1 document inserted, 1 document upserted/);
  });

  it('exports the current query as a browser download', async () => {
    const saved: { name: string; size: number }[] = [];
    const { setPlatform } = await import('../../../platform');
    const { createBrowserPlatform } = await import('../../../platform/browser');
    const p = createBrowserPlatform();
    setPlatform({ ...p, saveFile: async ({ suggestedName, content }) => { saved.push({ name: suggestedName, size: typeof content === 'string' ? content.length : content.size }); return suggestedName; } });
    try {
      render(<ExportDialog cid={CID} db="shop" coll="orders" query={{ filter: '{ status: "paid" }', projection: '', sort: '', collation: '', skip: 0, limit: 20, maxTimeMs: 30000 }} onClose={() => undefined} />);
      fireEvent.click(screen.getByRole('radio', { name: 'CSV' }));
      fireEvent.click(screen.getByRole('button', { name: /Export/ }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0].name).toBe('orders.csv');
      expect(saved[0].size).toBeGreaterThan(100);
    } finally {
      setPlatform(null);
    }
  });

  it('keeps the tab state JSON-serializable', async () => {
    const { id } = renderCollection('orders', 'aggregate', { pipeline: [newStage('$match', '{}')] });
    await screen.findAllByLabelText(/^Output after stage/);
    const t = useTabs.getState().tabs.find((x) => x.id === id) as ViewTab;
    expect(JSON.parse(JSON.stringify(t.state))).toEqual(t.state);
  });
});

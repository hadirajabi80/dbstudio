// Documents view against the MSW shop fixture: query bar, three views, count badge, pagination, insert / edit /
// clone / delete round trips with typed values, read-only enforcement (docs/PLAN-M2.md 6.3, QA Mongo).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { getPath, parseEjsonDoc } from '../../../mongo/bson';
import { useConnections } from '../../../store/connections';
import { useUi } from '../../../store/ui';
import { CID, renderCollection, setupMongo, tabStateOf } from './helpers';

const { reset } = setupMongo();
beforeEach(reset);

const cards = () => screen.queryAllByRole('listitem').filter((el) => el.classList.contains('mg-card'));

async function waitDocs(n?: number) {
  await waitFor(() => {
    const c = cards();
    expect(c.length).toBeGreaterThan(0);
    if (n !== undefined) expect(c.length).toBe(n);
  });
}

describe('documents view', () => {
  it('lists the first page with the namespace header and an exact count', async () => {
    renderCollection();
    await waitDocs(20);
    expect(screen.getByRole('heading', { name: 'shop.orders' })).toBeInTheDocument();
    expect(screen.getByText(/^1–20 of/)).toBeInTheDocument();
    expect(screen.getByText('240')).toHaveClass('mg-count-n');
    expect(await screen.findByText('240 documents')).toBeInTheDocument();
  });

  it('runs a filter typed in the query bar (Enter) and shows the filtered count', async () => {
    renderCollection();
    await waitDocs();
    const filter = screen.getByRole('textbox', { name: 'Filter' });
    fireEvent.change(filter, { target: { value: '{ status: "cancelled" }' } });
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('(filtered)')).toBeInTheDocument());
    for (const c of cards()) expect(c.textContent).toContain('"cancelled"');
  });

  it('applies projection, sort, skip and limit from the options', async () => {
    const { id } = renderCollection();
    await waitDocs();
    fireEvent.click(screen.getByRole('button', { name: /Options/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Project' }), { target: { value: '{ total: 1, _id: 0 }' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Sort' }), { target: { value: '{ total: -1 }' } });
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Find/ }));
    await waitDocs(5);
    expect(tabStateOf(id).query).toMatchObject({ projection: '{ total: 1, _id: 0 }', sort: '{ total: -1 }', limit: 5 });
    const totals = cards().map((c) => Number(/total:([\d.]+)/.exec(c.textContent!.replace(/\s/g, ''))?.[1]));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(cards()[0].textContent).not.toContain('_id');
  });

  it('shows parse errors and disables Find', async () => {
    renderCollection();
    await waitDocs();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: '{ status: paid }' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/filter: Unknown identifier 'paid'/);
    expect(screen.getByRole('button', { name: /Find/ })).toBeDisabled();
  });

  it('reports engine query errors', async () => {
    renderCollection();
    await waitDocs();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: '{ total: { $bogus: 1 } }' } });
    fireEvent.click(screen.getByRole('button', { name: /Find/ }));
    expect(await screen.findByText(/unknown operator: \$bogus/)).toBeInTheDocument();
  });

  it('pages forward and back', async () => {
    const { id } = renderCollection();
    await waitDocs();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText(/^21–40 of/)).toBeInTheDocument());
    expect(tabStateOf(id).query?.skip).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(screen.getByText(/^1–20 of/)).toBeInTheDocument());
  });

  it('marks an estimated count', async () => {
    renderCollection('orders', 'documents', { query: { filter: '{ $where: "true" }', projection: '', sort: '', collation: '', skip: 0, limit: 20, maxTimeMs: 30000 } });
    expect(await screen.findByText('estimated')).toBeInTheDocument();
    expect(screen.getByText('~240')).toHaveClass('estimated');
  });

  it('switches between list, JSON and table views', async () => {
    const { id } = renderCollection();
    await waitDocs();
    fireEvent.click(screen.getByRole('radio', { name: /JSON/ }));
    const json = await screen.findByRole('textbox', { name: 'Documents as JSON' });
    expect((json as HTMLTextAreaElement).value).toMatch(/^\[\n {2}\{\n {4}_id: ObjectId\("/);
    expect(tabStateOf(id).view).toBe('json');
    fireEvent.click(screen.getByRole('radio', { name: /Table/ }));
    const grid = await screen.findByRole('grid', { name: 'Documents table' });
    const headers = within(grid).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 4)).toEqual(['#', '_id', 'customerId', 'customer']);
    // drill into the items array of the first row
    fireEvent.click(within(grid).getAllByRole('button', { name: /^\[ \d \]$/ })[0]);
    expect(await screen.findByRole('navigation', { name: 'Drill-down path' })).toHaveTextContent('items');
  });

  it('truncates long strings and loads the full document for editing', async () => {
    renderCollection('orders', 'documents', { query: { filter: '{ notes: { $exists: true } }', projection: '', sort: '', collation: '', skip: 0, limit: 20, maxTimeMs: 30000 } });
    await waitDocs(1);
    expect(screen.getByText(/38,500 chars/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    const editor = await screen.findByRole('textbox', { name: 'Document' });
    expect((editor as HTMLTextAreaElement).value.length).toBeGreaterThan(38_000);
  });
});

describe('document writes', () => {
  it('inserts a document with typed values that round-trip', async () => {
    renderCollection('customers');
    await waitDocs();
    fireEvent.click(screen.getByRole('button', { name: /Insert/ }));
    const editor = await screen.findByRole('textbox', { name: 'Document' });
    const text = '{ _id: ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), name: "Zed", at: ISODate("2024-05-01T10:00:00Z"), big: NumberLong("9007199254740993"), price: NumberDecimal("19.99"), bin: BinData(0, "AQID"), ratio: 2.0, n: 3 }';
    fireEvent.change(editor, { target: { value: text } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const r = await api.mongo.doc(CID, 'shop', 'customers', 'ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa")');
    const d = parseEjsonDoc(r.doc!);
    expect(getPath(d, 'at')).toEqual({ t: 'date', v: Date.UTC(2024, 4, 1, 10) });
    expect(getPath(d, 'big')).toEqual({ t: 'long', v: '9007199254740993' });
    expect(getPath(d, 'price')).toEqual({ t: 'decimal', v: '19.99' });
    expect(getPath(d, 'bin')).toEqual({ t: 'binData', v: 'AQID', sub: '00' });
    expect(getPath(d, 'ratio')).toEqual({ t: 'double', v: 2 });
    expect(getPath(d, 'n')).toEqual({ t: 'int', v: 3 });
  });

  it('inserts an array of documents', async () => {
    renderCollection('products');
    await waitDocs();
    fireEvent.click(screen.getByRole('button', { name: /Insert/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Document' }), { target: { value: '[{ sku: "X1" }, { sku: "X2" }]' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(screen.getByText(/^1–14 of/)).toBeInTheDocument());
  });

  it('edits a document (replace by _id) keeping its types', async () => {
    renderCollection('products');
    await waitDocs();
    fireEvent.click(within(cards()[0]).getByRole('button', { name: 'Edit document' }));
    const editor = (await screen.findByRole('textbox', { name: 'Document' })) as HTMLTextAreaElement;
    expect(editor.value).toMatch(/price: NumberDecimal\("/);
    expect(editor.value).toMatch(/stock: NumberLong\("/);
    fireEvent.change(editor, { target: { value: editor.value.replace(/name: "[^"]+"/, 'name: "Renamed beans"') } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(cards()[0].textContent).toContain('Renamed beans'));
    const id = /ObjectId\("([0-9a-f]{24})"\)/.exec(editor.value)![1];
    const d = parseEjsonDoc((await api.mongo.doc(CID, 'shop', 'products', `ObjectId("${id}")`)).doc!);
    expect(getPath(d, 'price')?.t).toBe('decimal');
    expect(getPath(d, 'stock')?.t).toBe('long');
  });

  it('changing _id asks, then inserts and deletes', async () => {
    renderCollection('products');
    await waitDocs();
    fireEvent.click(within(cards()[0]).getByRole('button', { name: 'Edit document' }));
    const editor = (await screen.findByRole('textbox', { name: 'Document' })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: editor.value.replace(/_id: ObjectId\("[0-9a-f]{24}"\)/, '_id: "new-id"') } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(useUi.getState().confirm?.title).toBe('Change _id?'));
    act(() => useUi.getState().resolveConfirm(true));
    await waitFor(async () => expect((await api.mongo.doc(CID, 'shop', 'products', '"new-id"')).doc).not.toBeNull());
    expect((await api.mongo.find(CID, 'shop', 'products', { filter: '', skip: 0, limit: 100 })).count.value).toBe(12);
  });

  it('clones without the _id', async () => {
    renderCollection('products');
    await waitDocs();
    fireEvent.click(within(cards()[1]).getByRole('button', { name: 'Clone document' }));
    const editor = (await screen.findByRole('textbox', { name: 'Document' })) as HTMLTextAreaElement;
    expect(editor.value).not.toMatch(/_id:/);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(screen.getByText(/of 13$|^1–13 of/)).toBeInTheDocument());
  });

  it('deletes after an inline confirmation', async () => {
    renderCollection('products');
    await waitDocs(12);
    fireEvent.click(within(cards()[0]).getByRole('button', { name: 'Delete document' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete document' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitDocs(11);
  });

  it('keyboard: arrows move the selection, Delete asks', async () => {
    renderCollection('products');
    await waitDocs();
    const body = document.querySelector('.mg-docs-body')!;
    fireEvent.keyDown(body, { key: 'ArrowDown' });
    await waitFor(() => expect(cards()[1]).toHaveClass('selected'));
    fireEvent.keyDown(body, { key: 'Delete' });
    expect(within(cards()[1]).getByRole('alertdialog')).toBeInTheDocument();
  });

  it('read-only connections disable writes', async () => {
    useConnections.setState((s) => ({ connections: s.connections.map((c) => (c.id === CID ? { ...c, readOnly: true } : c)) }));
    renderCollection('products');
    await waitDocs();
    expect(screen.getByRole('button', { name: /Insert/ })).toBeDisabled();
    expect(within(cards()[0]).getByRole('button', { name: 'Delete document' })).toBeDisabled();
    expect(screen.getByText('read-only')).toBeInTheDocument();
  });
});

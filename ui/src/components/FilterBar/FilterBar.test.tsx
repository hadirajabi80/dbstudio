import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ColumnInfo, ColumnKind } from '../../api/types';
import { columnSignature, type FilterGroup } from '../../filter/model';
import { useGridMockEngine, until } from '../../mocks/m15/testServer';
import { useFilters } from '../../store/filters';
import { MenuHost } from '../common/Menu';
import { FilterBar } from './FilterBar';

const mock = useGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'orders', schema: 'main', isKey: false,
});
const COLS = [col('Id', 'int', 0), col('Name', 'string', 1), col('Total', 'decimal', 2), col('OrderDate', 'datetime', 3)];

let last: FilterGroup | null = null;
function Harness({ columns = COLS, initial = null as FilterGroup | null, server }: { columns?: ColumnInfo[]; initial?: FilterGroup | null; server?: { onApply(): void } }) {
  const [filter, setFilter] = useState<FilterGroup | null>(initial);
  const [quick, setQuick] = useState('');
  return (
    <>
      <FilterBar
        columns={columns}
        filter={filter}
        quick={quick}
        onChange={(f) => {
          last = f;
          setFilter(f);
        }}
        onQuickChange={setQuick}
        onClose={() => {}}
        dialect="sqlite"
        saved={{ connectionId: 'c_shop', signature: columnSignature(columns) }}
        server={server ? { available: true, active: false, onApply: server.onApply } : null}
      />
      <MenuHost />
    </>
  );
}

const wait = (ms = 250) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('FilterBar', () => {
  beforeEach(() => {
    last = null;
    mock.ctx.filters.filters = [];
    useFilters.setState({ saved: {}, status: {}, error: {}, recent: {} });
  });

  it('builds conditions with type-aware operators and AND/OR logic', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    // first unused column (Id, number): number operators only
    const ops = within(screen.getAllByLabelText('Operator')[0]).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(ops).toEqual(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'notIn', 'isNull', 'isNotNull']);
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'gt' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '5' } });
    await wait();
    expect(last!.items[0]).toMatchObject({ column: 'Id', op: 'gt', values: ['5'] });

    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    const colSelects = screen.getAllByLabelText('Column');
    expect((colSelects[1] as HTMLSelectElement).value).toBe('1'); // next unused column: Name
    const ops2 = within(screen.getAllByLabelText('Operator')[1]).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(ops2[0]).toBe('contains');
    expect(ops2).toContain('regex');
    fireEvent.change(screen.getAllByLabelText('Value')[1], { target: { value: 'acme' } });
    await wait();
    fireEvent.click(screen.getByTitle('Switch AND / OR for this group'));
    expect(last!.logic).toBe('or');
    expect(last!.items).toHaveLength(2);
  });

  it('switching to a date column offers date operators; invalid values are flagged, not applied', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: '3' } });
    expect((screen.getByLabelText('Operator') as HTMLSelectElement).value).toBe('onDate');
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'tomorrow' } });
    await wait();
    expect(screen.getByRole('note')).toHaveTextContent('YYYY-MM-DD');
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'last' } });
    expect(screen.getByLabelText('Count')).toBeInTheDocument();
    expect((screen.getByLabelText('Unit') as HTMLSelectElement).value).toBe('days');
  });

  it('removing a condition and Clear', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    fireEvent.click(screen.getAllByLabelText('Remove condition')[0]);
    expect(last!.items).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(last).toBeNull();
    expect(screen.getByText('No conditions.')).toBeInTheDocument();
  });

  it('Ctrl+Shift+Enter applies on the server', () => {
    let applied = 0;
    render(<Harness server={{ onApply: () => applied++ }} />);
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }));
    fireEvent.keyDown(screen.getByLabelText('Value'), { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(applied).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /Apply on server/ }));
    expect(applied).toBe(2);
  });

  it('saved filters round-trip through /filters and reappear only for the same column signature', async () => {
    const initial: FilterGroup = { kind: 'group', id: 'g', logic: 'and', items: [{ kind: 'condition', id: 'c', column: 'Total', op: 'gt', values: ['100'], ordinal: 2 }] };
    const view = render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save as/ }));
    fireEvent.change(screen.getByLabelText('Filter name'), { target: { value: 'Big orders' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await until(() => mock.ctx.filters.filters.length === 1);
    const saved = mock.ctx.filters.filters[0];
    expect(saved).toMatchObject({ connectionId: 'c_shop', signature: 'Id:int|Name:string|OrderDate:datetime|Total:decimal', name: 'Big orders' });
    expect(saved.model.root.items[0]).toMatchObject({ column: 'Total', op: 'gt', values: ['100'] });
    expect(saved.model.root.items[0]).not.toHaveProperty('ordinal');
    view.unmount();

    // Same columns in another order (another query): the saved filter is offered and applies.
    useFilters.setState({ saved: {}, status: {} });
    const reordered = [COLS[3], COLS[2], COLS[1], COLS[0]].map((c, i) => ({ ...c, ordinal: i }));
    const v2 = render(<Harness columns={reordered} />);
    await until(() => useFilters.getState().status.c_shop === 'ready');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Big orders' }));
    expect(last!.items[0]).toMatchObject({ column: 'Total', op: 'gt', values: ['100'] });
    expect(last!.items[0].id).not.toBe('c');
    v2.unmount();

    // Different columns: not offered.
    useFilters.setState({ saved: {}, status: {} });
    render(<Harness columns={[col('Id', 'int', 0), col('City', 'string', 1)]} />);
    await until(() => useFilters.getState().status.c_shop === 'ready');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    expect(await screen.findByRole('menuitem', { name: 'No saved filters for these columns' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Big orders' })).toBeNull();
  });

  it('manage dialog renames and deletes saved filters', async () => {
    mock.ctx.filters.create({ connectionId: 'c_shop', signature: columnSignature(COLS), name: 'Old name', model: { root: { id: 'r', logic: 'and', items: [] } } });
    render(<Harness />);
    await until(() => useFilters.getState().status.c_shop === 'ready');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Manage/ }));
    fireEvent.click(screen.getByLabelText('Rename Old name'));
    fireEvent.change(screen.getByLabelText('Filter name'), { target: { value: 'New name' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Save name'));
    });
    await until(() => mock.ctx.filters.filters[0].name === 'New name');
    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Delete New name'));
    });
    await until(() => mock.ctx.filters.filters.length === 0);
    expect(await screen.findByText('No saved filters yet')).toBeInTheDocument();
  });
});

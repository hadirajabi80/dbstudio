// Keyboard-only operation of the table designer's column grid (acceptance: no mouse needed).
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { DesignerType, TableModel } from '../../api/types';
import { ColumnGrid } from '../table/ColumnGrid';
import { addColumn, duplicateColumn, moveColumn, newTableModel, removeColumn, togglePrimaryKey, updateColumn } from '../table/model';

const TYPES: DesignerType[] = ['int', 'bigint', 'nvarchar(100)', 'datetime2(3)', 'decimal(18,2)'].map((t) => ({ name: t.replace(/\(.*/, ''), default: t, params: 'none', category: 'other' }));

let latest: TableModel;

function Harness() {
  const [t, setT] = useState<TableModel>(() => addColumn(newTableModel('tsql', 'dbo', 'Customers'), 'tsql', 1, { name: 'Name', type: 'nvarchar(100)' }));
  const [active, setActive] = useState(0);
  latest = t;
  return (
    <ColumnGrid
      table={t}
      dialect="tsql"
      types={TYPES}
      features={null}
      readOnly={false}
      errorRows={new Set()}
      active={active}
      onActiveChange={setActive}
      onChange={(i, p) => setT((x) => updateColumn(x, i, p, 'tsql'))}
      onTogglePk={(i) => setT((x) => togglePrimaryKey(x, i, 'tsql'))}
      onAdd={(at) => setT((x) => addColumn(x, 'tsql', at))}
      onRemove={(i) => setT((x) => removeColumn(x, i))}
      onMove={(i, d) => setT((x) => moveColumn(x, i, d))}
      onDuplicate={(i) => setT((x) => duplicateColumn(x, i, 'tsql'))}
    />
  );
}

const names = () => latest.columns.map((c) => c.name);
const cell = (row: number, col: number) => document.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)!;

describe('ColumnGrid keyboard', () => {
  it('is a grid with one tab stop (roving tabindex)', () => {
    render(<Harness />);
    expect(screen.getByRole('grid', { name: 'Columns' })).toHaveAttribute('aria-rowcount', '4');
    const focusable = [...document.querySelectorAll('[data-cell]')].filter((e) => e.getAttribute('tabindex') === '0');
    expect(focusable).toHaveLength(1);
  });

  it('adds, names and types a column without the mouse', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(0, 0).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(cell(2, 0)); // the "add column" row
    await user.keyboard('{Enter}');
    expect(names()).toEqual(['Id', 'Name', 'Column1']);
    await user.keyboard('{Control>}a{/Control}Email{Tab}');
    expect(names()[2]).toBe('Email');
    expect(document.activeElement).toBe(cell(2, 1));
    await user.keyboard('{Enter}');
    const combo = screen.getByRole('combobox');
    await user.clear(combo);
    await user.type(combo, 'datet');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(latest.columns[2].type).toBe('datetime2(3)');
    // Tab moves along the row; Space toggles the Null cell.
    cell(2, 2).focus();
    expect(latest.columns[2].nullable).toBe(true);
    await user.keyboard(' ');
    expect(latest.columns[2].nullable).toBe(false);
  });

  it('typing on a text cell starts editing it; Esc cancels', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(1, 0).focus();
    await user.keyboard('Full');
    await user.keyboard('{Escape}');
    expect(names()[1]).toBe('Name');
    expect(document.activeElement).toBe(cell(1, 0));
    await user.keyboard('FullName{Enter}');
    expect(names()[1]).toBe('FullName');
  });

  it('reorders with Alt+Up/Down, duplicates with Ctrl+D, inserts with Insert and removes with Delete', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(1, 0).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(names()).toEqual(['Name', 'Id']);
    expect(document.activeElement).toBe(cell(0, 0));
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(names()).toEqual(['Id', 'Name']);
    await user.keyboard('{Control>}d{/Control}');
    expect(names()).toEqual(['Id', 'Name', 'Name_copy']);
    await user.keyboard('{Insert}');
    expect(names()).toHaveLength(4);
    await user.keyboard('{Escape}');
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    expect(names()).toEqual(['Id', 'Name', 'Name_copy']);
  });

  it('PK toggles with Space and keeps the key column NOT NULL', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(1, 3).focus();
    await user.keyboard(' ');
    expect(latest.primaryKey?.columns).toEqual(['Id', 'Name']);
    expect(latest.columns[1].nullable).toBe(false);
    expect(cell(1, 3)).toHaveAttribute('aria-checked', 'true');
  });
});

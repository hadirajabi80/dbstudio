// DataGrid behaviour with the canvas grid replaced by a probe (glide needs a real canvas): auto column widths
// (styles-r1-01), the keyboard context menu (design-04), Ctrl+0 left to Reset zoom (design-13), controller focus.
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ForwardedRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { resolveKey } from '../../commands/dispatcher';
import { EMPTY_VIEW } from '../../filter/model';
import { useEdits } from '../../store/edits';
import { MenuHost, useMenu } from '../common/Menu';
import { registerGridCommands } from '../DataTab/commands';
import { DataGrid, type DataGridProps } from './DataGrid';
import { focusGrid, setActiveGridKey } from './controller';
import type { Editability } from './editability';

const probe = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@glideapps/glide-data-grid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@glideapps/glide-data-grid')>();
  const React = await import('react');
  const DataEditor = React.forwardRef(function DataEditorProbe(p: Record<string, unknown>, ref: ForwardedRef<unknown>) {
    probe.props = p;
    const canvas = React.useRef<HTMLCanvasElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => canvas.current?.focus(),
      // Cell rectangles in client coordinates: 100 px wide columns, 28 px rows under a 28 px header.
      getBounds: (col?: number, row?: number) => ({ x: 50 + (col ?? 0) * 100, y: 40 + ((row ?? -1) + 1) * 28, width: 100, height: 28 }),
      scrollTo: () => undefined,
      appendRow: async () => undefined,
      emit: async () => undefined,
      updateCells: () => undefined,
      getMouseArgsForPosition: () => undefined,
      remeasureColumns: () => undefined,
    }));
    return React.createElement('canvas', { 'data-testid': 'data-grid-canvas', tabIndex: 0, ref: canvas });
  });
  return { ...actual, DataEditor };
});

const col = (name: string, kind: ColumnKind, ordinal: number, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, ordinal, dbType: kind === 'int' ? 'INTEGER' : 'TEXT', kind, nullable: true, size: null, precision: null, scale: null, table: 'Customers', schema: 'main', isKey: false, ...extra,
});
const COLUMNS = [col('Id', 'int', 0, { isKey: true, nullable: false }), col('FirstName', 'string', 1), col('Email', 'string', 2)];
const ROWS: CellValue[][] = Array.from({ length: 20 }, (_, i) => [i + 1, `Name${i}`, `sophia.muller${i}@example-mail.com`]);
const list = (rows: CellValue[][]) => ({ length: rows.length, get: (i: number) => rows[i] });

const EDITABLE: Editability = {
  editable: true, reason: null, editableColumns: new Set([1, 2]), keyOrdinals: [0],
  target: { schema: 'main', name: 'Customers', keyColumns: ['Id'] },
};

function props(over: Partial<DataGridProps> = {}): DataGridProps {
  return {
    gridKey: 'g1', columns: COLUMNS, rows: list(ROWS), rev: 1, done: true, view: EMPTY_VIEW, onViewChange: () => undefined,
    dialect: 'sqlite', theme: 'light', nullText: 'NULL', dateFormat: 'iso', ...over,
  };
}

type ProbeColumn = { id: string; title: string; width: number };
const shownColumns = () => (probe.props?.columns ?? []) as ProbeColumn[];
const canvas = () => screen.getByTestId('data-grid-canvas');
/** Select a cell like glide does (controlled gridSelection). */
const selectCell = (c: number, r: number) =>
  act(() => {
    const onChange = probe.props!.onGridSelectionChange as (s: unknown) => void;
    onChange({ columns: { length: 0, toArray: () => [], hasIndex: () => false, first: () => undefined }, rows: emptySel(), current: { cell: [c, r], range: { x: c, y: r, width: 1, height: 1 }, rangeStack: [] } });
  });
const emptySel = () => ({ length: 0, toArray: () => [], hasIndex: () => false, first: () => undefined });

describe('DataGrid', () => {
  beforeAll(() => registerGridCommands());
  afterEach(() => {
    act(() => useMenu.getState().hide(false));
    useEdits.getState().reset('g1');
    setActiveGridKey(null);
    probe.props = null;
  });

  it('measures column widths when columns and rows arrive in the same update (styles-r1-01)', () => {
    // First render without a result (columns and rows unknown), then everything at once, as a fast query delivers it.
    const { rerender } = render(<DataGrid {...props({ columns: [], rows: list([]), done: false, rev: 0 })} />);
    rerender(<DataGrid {...props()} />);
    const cols = shownColumns();
    expect(cols).toHaveLength(3);
    expect(cols.every((c) => c.width === 140)).toBe(false);
    const width = (name: string) => cols.find((c) => c.title.startsWith(name))!.width;
    expect(width('Email')).toBeGreaterThan(width('Id'));
    // A new, equal column list (the next page of a Data tab) keeps the measured widths.
    const before = cols.map((c) => c.width);
    rerender(<DataGrid {...props({ columns: COLUMNS.map((c) => ({ ...c })), rev: 2 })} />);
    expect(shownColumns().map((c) => c.width)).toEqual(before);
    // Different columns are measured again.
    rerender(<DataGrid {...props({ columns: [col('Code', 'string', 0)], rows: list([['x'.repeat(60)]]), rev: 3 })} />);
    expect(shownColumns()[0].width).toBeGreaterThan(140);
  });

  it('Shift+F10 opens the cell context menu at the focused cell (design-04)', () => {
    render(<><DataGrid {...props({ editability: EDITABLE })} /><MenuHost /></>);
    selectCell(1, 2);
    act(() => canvas().focus());
    const ev = fireEvent.keyDown(canvas(), { key: 'F10', code: 'F10', shiftKey: true });
    expect(ev).toBe(false); // default prevented: no second, native context menu
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Revert row');
    expect(menu).toHaveTextContent('Copy value');
    // Anchored at the cell (x 50 + 1 * 100, below row 2), not at the corner of the window.
    const open = useMenu.getState().open!;
    expect(open.x).toBeGreaterThanOrEqual(150);
    expect(open.x).toBeLessThan(250);
    expect(open.y).toBe(40 + 3 * 28 + 28);
    expect(open.fromKeyboard).toBe(true);
  });

  it('the ContextMenu key opens the header menu when a column is the target', () => {
    render(<><DataGrid {...props()} /><MenuHost /></>);
    act(() => {
      const onChange = probe.props!.onGridSelectionChange as (s: unknown) => void;
      onChange({ columns: { length: 1, toArray: () => [2], hasIndex: (i: number) => i === 2, first: () => 2 }, rows: emptySel(), current: undefined });
    });
    fireEvent.keyDown(canvas(), { key: 'ContextMenu' });
    expect(screen.getByRole('menu')).toHaveTextContent('Sort ascending');
  });

  it('Ctrl+0 is left to Reset zoom; Set NULL is Mod+Alt+N through the registry (design-13)', () => {
    render(<DataGrid {...props({ editability: EDITABLE })} />);
    selectCell(1, 0);
    act(() => canvas().focus());
    const ev = fireEvent.keyDown(canvas(), { key: '0', code: 'Digit0', ctrlKey: true });
    expect(ev).toBe(true); // not handled by the grid: it bubbles to view.zoomReset
    expect(Object.keys(useEdits.getState().get('g1').pending.updates)).toHaveLength(0);
    expect(resolveKey('ctrl+alt+n', ['grid', 'global'])).toBe('grid.setNull');
    expect(resolveKey('ctrl+0', ['grid', 'global'])).not.toBe('grid.setNull');
  });

  it('the controller focuses the canvas and keeps the selection', () => {
    render(<><button>outside</button><DataGrid {...props()} /></>);
    selectCell(2, 3);
    screen.getByText('outside').focus();
    expect(focusGrid('g1')).toBe(true);
    expect(document.activeElement).toBe(canvas());
    const sel = probe.props!.gridSelection as { current?: { cell: number[] } };
    expect(sel.current?.cell).toEqual([2, 3]);
  });
});

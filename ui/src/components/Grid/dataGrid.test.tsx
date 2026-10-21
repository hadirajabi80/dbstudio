// DataGrid behaviour with the canvas grid replaced by a probe (glide needs a real canvas): auto column widths
// (styles-r1-01), the keyboard context menu (design-04), Ctrl+0 left to Reset zoom (design-13), controller focus.
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ForwardedRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { resolveKey } from '../../commands/dispatcher';
import { runCommand } from '../../commands/registry';
import { EMPTY_VIEW } from '../../filter/model';
import { useEdits } from '../../store/edits';
import { useUi } from '../../store/ui';
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

  it('RTL values of text columns are right-aligned cells and drawn right-to-left; LTR text and numbers keep theirs', () => {
    const rows: CellValue[][] = [[1, 'علی رضایی', 'Order #12 سفارش'], [2, 'Ada', '12 سفارش'], [3, 'محمد', null]];
    render(<DataGrid {...props({ rows: list(rows), editability: EDITABLE })} />);
    const get = probe.props!.getCellContent as (i: [number, number]) => { contentAlign?: string; displayData?: string; data?: unknown };
    expect(get([1, 0]).contentAlign).toBe('right');
    expect(get([1, 0]).data).toBe('علی رضایی'); // the editor gets the value unchanged
    expect(get([2, 0]).contentAlign).toBe('left'); // mixed, Latin first
    expect(get([1, 1]).contentAlign).toBe('left');
    expect(get([2, 1]).contentAlign).toBe('right'); // numbers first, then Persian
    expect(get([0, 0]).contentAlign).toBe('right'); // numbers as before
    expect(get([2, 2]).displayData).toBe('NULL');
    expect(get([2, 2]).contentAlign).toBe('left');
    // The draw hook switches the canvas to RTL for the RTL cell only.
    const drawCell = probe.props!.drawCell as (a: unknown, draw: () => void) => void;
    const ctx = { direction: 'inherit', save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} } as Record<string, unknown>;
    const seen: string[] = [];
    const theme = { baseFontStyle: '13px', fontFamily: 'mono', cellHorizontalPadding: 8 };
    for (const [c, r] of [[1, 0], [1, 1]] as const) {
      drawCell({ ctx, rect: { x: 0, y: 0, width: 400, height: 28 }, col: c, row: r, cell: get([c, r]), theme }, () => seen.push(String(ctx.direction)));
    }
    expect(seen).toEqual(['rtl', 'inherit']);
    expect(ctx.direction).toBe('inherit');
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

  describe('Set selected cells to NULL on NOT NULL columns (design-r2-04)', () => {
    // FirstName and LastName are NOT NULL, Email is nullable; all three are editable.
    const NN_COLUMNS = [
      col('Id', 'int', 0, { isKey: true, nullable: false }), col('FirstName', 'string', 1, { nullable: false }),
      col('LastName', 'string', 2, { nullable: false }), col('Email', 'string', 3),
    ];
    const NN_ROWS: CellValue[][] = [[1, 'Sophia', 'Muller', 's@x.io'], [2, 'Liam', 'Smith', 'l@x.io']];
    const NN_EDITABLE: Editability = { ...EDITABLE, editableColumns: new Set([1, 2, 3]) };
    const nnProps = () => props({ columns: NN_COLUMNS, rows: list(NN_ROWS), editability: NN_EDITABLE });
    const selectRange = (x: number, y: number, width: number, height: number) =>
      act(() => {
        const onChange = probe.props!.onGridSelectionChange as (s: unknown) => void;
        onChange({ columns: emptySel(), rows: emptySel(), current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] } });
      });
    const setNullItem = () => screen.getAllByRole('menuitem').find((m) => m.textContent?.includes('Set selected cells to NULL'))!;
    const openMenu = () => {
      act(() => canvas().focus());
      fireEvent.keyDown(canvas(), { key: 'F10', code: 'F10', shiftKey: true });
    };
    const toasts = () => useUi.getState().toasts;

    afterEach(() => useUi.setState({ toasts: [] }));

    it('a NOT NULL cell: the menu item is disabled with the reason, and Ctrl+Alt+N says why nothing changed', () => {
      render(<><DataGrid {...nnProps()} /><MenuHost /></>);
      selectCell(1, 0);
      openMenu();
      expect(setNullItem()).toHaveAttribute('aria-disabled', 'true');
      expect(setNullItem()).toHaveTextContent('Set selected cells to NULL (FirstName is NOT NULL)');
      act(() => useMenu.getState().hide(false));
      act(() => runCommand('grid.setNull', { gridKey: 'g1' }));
      expect(useEdits.getState().get('g1').pending.updates).toEqual({});
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0]).toMatchObject({ kind: 'info', text: 'Cannot set to NULL', detail: 'FirstName is NOT NULL' });
    });

    it('several NOT NULL columns give one reason for all of them', () => {
      render(<><DataGrid {...nnProps()} /><MenuHost /></>);
      selectRange(1, 0, 2, 2);
      openMenu();
      expect(setNullItem()).toHaveAttribute('aria-disabled', 'true');
      expect(setNullItem()).toHaveTextContent('(Selected columns are NOT NULL)');
    });

    it('a nullable cell keeps the item enabled', () => {
      render(<><DataGrid {...nnProps()} /><MenuHost /></>);
      selectCell(3, 1);
      openMenu();
      expect(setNullItem()).not.toHaveAttribute('aria-disabled');
      expect(setNullItem().textContent).not.toMatch(/NOT NULL/);
    });

    it('a mixed range sets the nullable cells in one undo step and reports the skipped ones once', () => {
      render(<><DataGrid {...nnProps()} /><MenuHost /></>);
      selectRange(1, 0, 3, 2); // FirstName, LastName, Email of both rows
      openMenu();
      expect(setNullItem()).not.toHaveAttribute('aria-disabled');
      act(() => fireEvent.click(setNullItem()));
      const b = useEdits.getState().get('g1');
      expect(b.pending.updates).toEqual({ 0: { 3: null }, 1: { 3: null } });
      expect(b.undo).toHaveLength(1);
      expect(toasts()).toEqual([expect.objectContaining({ kind: 'info', text: '4 cells skipped: columns are NOT NULL' })]);
      act(() => useEdits.getState().undo('g1'));
      expect(useEdits.getState().get('g1').pending.updates).toEqual({});
    });

    it('one skipped column reads "column is"; cells of a new row take NULL whatever the column', () => {
      render(<><DataGrid {...nnProps()} /><MenuHost /></>);
      act(() => {
        useEdits.getState().addInsert('g1', 4, { 1: 'New' });
      });
      selectRange(1, 1, 1, 2); // FirstName of row 2 (stored) and of the new row
      act(() => runCommand('grid.setNull', { gridKey: 'g1' }));
      const b = useEdits.getState().get('g1');
      expect(b.pending.inserts[0].values[1]).toBeNull();
      expect(b.pending.inserts[0].touched).toEqual({ 1: true });
      expect(b.pending.updates).toEqual({});
      expect(toasts()).toEqual([expect.objectContaining({ text: '1 cell skipped: column is NOT NULL' })]);
    });
  });
});

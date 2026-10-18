// user-02: Ctrl+S / Save apply grid edits directly (no SQL dialog, like Navicat); errors roll back, keep the buffer,
// mark the row and say so in a toast; the SQL preview is opt-in (setting) or on demand.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { pendingCount, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { DEFAULT_SETTINGS, useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { PendingBar } from './PendingBar';
import { copyPendingSql, discardPendingChanges, savePendingChanges, showSqlBeforeSave } from './save';
import type { EditContext } from './submit';
import { usePendingChanges } from './usePendingChanges';

const mock = installGridMockEngine({ frameDelay: 0 }, true);

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'people', schema: 'main', isKey: name === 'Id',
});
const COLUMNS = [col('Id', 'int', 0), col('Name', 'string', 1), col('Total', 'decimal', 2)];
const KEY = 'save-test';
const seed = (): CellValue[][] => [[1, 'Ada', '10.5'], [2, 'Grace', '20'], [3, 'Linus', null]];
let base: CellValue[][] = seed();

function ctx(): EditContext {
  return {
    gridKey: KEY, tabId: 'tab-save', connectionId: 'c_shop', database: null, dialect: 'sqlite',
    target: { schema: 'main', name: 'people', keyColumns: ['Id'], identityColumns: ['Id'], defaultSchema: 'main' },
    columns: COLUMNS, rowAt: (i) => base[i], sourceLength: base.length, sqliteVersion: '3.46.1',
  };
}

const setGrid = (grid: Partial<typeof DEFAULT_SETTINGS.grid>) =>
  useSettings.setState({ settings: { ...useSettings.getState().settings, grid: { ...DEFAULT_SETTINGS.grid, ...grid } } });
const toasts = () => useUi.getState().toasts;
const lastToast = () => toasts()[toasts().length - 1];

describe('direct save of grid edits (user-02)', () => {
  beforeAll(async () => {
    await useConnections.getState().load();
  });
  beforeEach(() => {
    base = seed();
    mock.ctx.engine.addTable('people', { columns: COLUMNS, rows: seed().map((r) => [...r]), key: 'Id' });
    mock.ctx.engine.conflictOn = null;
    mock.ctx.engine.log = [];
    useEdits.getState().reset(KEY);
    useSessions.setState({ sessions: {}, byTab: {} });
    useUi.setState({ toasts: [] });
    setGrid({});
  });
  afterEach(() => setGrid({}));

  it('"Show SQL before saving" is off by default', () => {
    expect(DEFAULT_SETTINGS.grid.showSqlBeforeSave).toBe(false);
    expect(showSqlBeforeSave()).toBe(false);
  });

  it('saves directly in one transaction: no preview, a success toast, the buffer is cleared', async () => {
    useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    useEdits.getState().toggleDelete(KEY, [2]);
    const preview = vi.fn();
    const r = await savePendingChanges(ctx(), { preview });
    expect(preview).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, executed: 2 });
    expect(mock.ctx.engine.tables.get('people')!.rows.map((x) => x[1])).toEqual(['Ada L.', 'Grace']);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
    expect(mock.hits('/commit', 'POST')).toHaveLength(1);
    expect(lastToast()).toMatchObject({ kind: 'success', text: 'Saved 2 changes to people' });
  });

  it('with "Show SQL before saving" on, Save opens the preview and runs nothing', async () => {
    setGrid({ showSqlBeforeSave: true });
    useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    const preview = vi.fn();
    expect(await savePendingChanges(ctx(), { preview })).toBeNull();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(mock.ctx.engine.log).toEqual([]);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(1);
    // the preview's own Save button passes direct: true
    expect(await savePendingChanges(ctx(), { preview, direct: true })).toMatchObject({ ok: true });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('nothing pending: no statement, no toast', async () => {
    expect(await savePendingChanges(ctx(), { preview: vi.fn() })).toBeNull();
    expect(mock.ctx.engine.log).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it('an error rolls back, keeps the edits, marks the row and offers the SQL', async () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'x', 'Ada');
    const id = s.addInsert(KEY, 3);
    s.setInsertCell(KEY, id, 1, 'fail');
    const preview = vi.fn();
    const r = await savePendingChanges(ctx(), { preview });
    expect(r?.ok).toBe(false);
    expect(mock.hits('/rollback', 'POST').length).toBeGreaterThan(0);
    const b = useEdits.getState().get(KEY);
    expect(pendingCount(b.pending)).toBe(2);
    expect(b.issues[0]).toMatchObject({ ref: id, kind: 'error' });
    const t = lastToast();
    expect(t).toMatchObject({ kind: 'error', text: 'Could not save the changes to people (new row)' });
    expect(t.detail).toMatch(/Your edits are kept/);
    expect(t.action?.label).toBe('Show SQL');
    t.action!.run();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(mock.hits('/commit', 'POST')).toHaveLength(0);
  });

  it('a conflict (verify unchanged values) is reported on the row; Overwrite saves without verification', async () => {
    setGrid({ verifyUnchanged: true });
    useEdits.getState().setCell(KEY, 1, 1, 'Grace H.', 'Grace');
    mock.ctx.engine.conflictOn = /AND Name = @p3/;
    const r = await savePendingChanges(ctx(), { preview: vi.fn() });
    expect(r?.ok).toBe(false);
    expect(useEdits.getState().get(KEY).issues[0]).toMatchObject({ ref: '1', kind: 'conflict' });
    const t = lastToast();
    expect(t.text).toBe('Not saved: the row was changed by someone else (row 2)');
    expect(t.action?.label).toBe('Overwrite');
    await act(async () => {
      t.action!.run();
    });
    await until(() => pendingCount(useEdits.getState().get(KEY).pending) === 0);
    expect(mock.ctx.engine.tables.get('people')!.rows[1][1]).toBe('Grace H.');
  });

  it('a second Save while one is running does nothing', async () => {
    useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    const first = savePendingChanges(ctx(), { preview: vi.fn() });
    expect(useEdits.getState().get(KEY).status).toBe('submitting');
    expect(await savePendingChanges(ctx(), { preview: vi.fn() })).toBeNull();
    expect(await first).toMatchObject({ ok: true, executed: 1 });
  });

  it('Discard drops every pending change without a dialog; the toast can undo it', () => {
    const s = useEdits.getState();
    s.setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    s.toggleDelete(KEY, [1]);
    discardPendingChanges(KEY);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
    const t = lastToast();
    expect(t).toMatchObject({ kind: 'info', text: 'Discarded 2 pending changes' });
    t.action!.run();
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(2);
  });

  it('Copy SQL of pending changes puts the statements on the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
    copyPendingSql(ctx());
    await until(() => writeText.mock.calls.length > 0);
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toContain("UPDATE people SET Name = 'Ada L.' WHERE Id = 1");
  });

  describe('toolbar: Discard / Save (n) ▾', () => {
    function Harness() {
      const actions = usePendingChanges(ctx());
      const n = pendingCount(useEdits((st) => st.buffers[KEY])?.pending ?? { updates: {}, inserts: [], deletes: {} });
      return (
        <>
          {n > 0 && <PendingBar gridKey={KEY} count={n} actions={actions} />}
          <button onClick={actions.preview}>open preview</button>
          {actions.dialog}
        </>
      );
    }

    it('Save writes the edits without showing the SQL dialog', async () => {
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      render(<Harness />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Save \(1\)/ }));
      });
      await until(() => pendingCount(useEdits.getState().get(KEY).pending) === 0);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(mock.ctx.engine.tables.get('people')!.rows[0][1]).toBe('Ada L.');
      expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
    });

    it('Discard reverts without a dialog; the preview is still there on demand', () => {
      useEdits.getState().setCell(KEY, 0, 1, 'Ada L.', 'Ada');
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'open preview' }));
      expect(screen.getByRole('dialog')).toHaveTextContent("UPDATE people SET Name = 'Ada L.' WHERE Id = 1");
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
    });
  });
});

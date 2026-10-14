import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { QueryParam } from '../../api/types';
import { useGridMockEngine, until } from '../../mocks/m15/testServer';
import { useParams } from '../../store/params';
import { useSettings } from '../../store/settings';
import { ParamsDialogHost, resolveParams } from './ParamsDialog';

const mock = useGridMockEngine();
const batch = (sql: string) => [{ sql, line: 1, col: 1 }];

describe('Parameters dialog', () => {
  beforeEach(async () => {
    useParams.setState({ request: null, skip: {} });
    // Local reset only (no debounced PUT racing the assertions below); the engine copy is reset directly.
    mock.ctx.engine.settings = { ...mock.ctx.engine.settings, ui: { ...mock.ctx.engine.settings.ui, paramHistory: {} } };
    await useSettings.getState().load();
  });

  it('no parameters → undefined (run directly)', async () => {
    expect(await resolveParams('t', 'c_prod', 'tsql', batch('SELECT 1'))).toBeUndefined();
    expect(await resolveParams('t', 'c_prod', 'tsql', batch('DECLARE @id int = 1; SELECT @id'))).toBeUndefined();
  });

  it('prompts for @id on T-SQL, Ctrl+Enter runs, values are typed and remembered', async () => {
    render(<ParamsDialogHost />);
    let result: QueryParam[] | null | undefined;
    void resolveParams('t1', 'c_prod', 'tsql', batch('SELECT * FROM dbo.customers WHERE id = @id AND name LIKE @name')).then((r) => (result = r));
    const id = await screen.findByLabelText('Value of @id');
    expect((screen.getByLabelText('Type of @id') as HTMLSelectElement).value).toBe('int');
    fireEvent.change(id, { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Value of @name'), { target: { value: 'Ac%' } });
    await act(async () => {
      fireEvent.keyDown(id, { key: 'Enter', ctrlKey: true });
    });
    await until(() => result !== undefined);
    expect(result).toEqual([{ name: 'id', kind: 'int', value: 42 }, { name: 'name', kind: 'string', value: 'Ac%' }]);
    // MRU persisted to settings (engine PUT /settings)
    await until(() => !!(mock.ctx.engine.settings.ui?.paramHistory as Record<string, unknown> | undefined)?.c_prod, 5000);
    expect(mock.ctx.engine.settings.ui?.paramHistory).toMatchObject({ c_prod: { id: { kind: 'int', values: ['42'] } } });

    // Next run pre-fills the remembered value.
    void resolveParams('t1', 'c_prod', 'tsql', batch('SELECT * FROM t WHERE id = @id'));
    expect(((await screen.findByLabelText('Value of @id')) as HTMLInputElement).value).toBe('42');
    act(() => useParams.getState().close(null));
  });

  it('prompts for :id on Oracle with refcursor available; Cancel returns null', async () => {
    render(<ParamsDialogHost />);
    let result: QueryParam[] | null | undefined = undefined;
    void resolveParams('t2', 'c_ora', 'plsql', batch('BEGIN shop.get_orders(:id, :rc); END;')).then((r) => (result = r));
    await screen.findByLabelText('Value of :id');
    const kinds = Array.from((screen.getByLabelText('Type of :rc') as HTMLSelectElement).options).map((o) => o.value);
    expect(kinds).toContain('refcursor');
    fireEvent.change(screen.getByLabelText('Type of :rc'), { target: { value: 'refcursor' } });
    fireEvent.change(screen.getByLabelText('Value of :id'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Type of :id'), { target: { value: 'int' } });
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    await until(() => result !== undefined);
    expect(result).toEqual([{ name: 'id', kind: 'int', value: 7 }, { name: 'rc', kind: 'refcursor', value: null, direction: 'out' }]);

    void resolveParams('t2', 'c_ora', 'plsql', batch('SELECT * FROM t WHERE x = :x')).then((r) => (result = r));
    await screen.findByLabelText('Value of :x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await until(() => result === null);
  });

  it('invalid values block Run; "Don\'t ask again" skips the dialog when every value is remembered', async () => {
    render(<ParamsDialogHost />);
    let result: QueryParam[] | null | undefined;
    void resolveParams('t3', 'c_shop', 'sqlite', batch('SELECT * FROM t WHERE id = :id')).then((r) => (result = r));
    const input = await screen.findByLabelText('Value of :id');
    fireEvent.change(screen.getByLabelText('Type of :id'), { target: { value: 'int' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(screen.getByRole('button', { name: /Run/ })).toBeDisabled();
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText(/Don't ask again/));
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
    await until(() => result !== undefined);
    result = undefined;
    const again = await resolveParams('t3', 'c_shop', 'sqlite', batch('SELECT * FROM t WHERE id = :id'));
    expect(again).toEqual([{ name: 'id', kind: 'int', value: 3 }]);
    expect(useParams.getState().request).toBeNull();
    // Ctrl+Alt+P (params.edit) always asks, with the remembered value pre-filled
    void resolveParams('t3', 'c_shop', 'sqlite', batch('SELECT * FROM t WHERE id = :id'), { force: true });
    expect(((await screen.findByLabelText('Value of :id')) as HTMLInputElement).value).toBe('3');
    act(() => useParams.getState().close(null));
  });
});

// logic-r1-04: the Parameters dialog seeds each type from the column the parameter is compared with (positional `?`
// included), before the name heuristic, and names its primary button after the caller (Explain does not run).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogSnapshot, ConnectionProfile, QueryParam } from '../../api/types';
import sqliteShop from '../../intel/__tests__/fixtures/shop-sqlite.json';
import tsqlShop from '../../intel/__tests__/fixtures/shop-tsql.json';
import { dbKey, useCatalog, type DbCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useParams } from '../../store/params';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { selectValue } from '../../test/select';
import { explainInTab } from '../PlanView/explain';
import { inferredKinds, kindOfParamType, ParamsDialogHost, resolveParams } from './ParamsDialog';

const SQLITE = sqliteShop as unknown as CatalogSnapshot;
const TSQL = tsqlShop as unknown as CatalogSnapshot;
const batch = (sql: string) => [{ sql, line: 1, col: 1 }];

function consoleTab(id: string, connectionId: string, database: string | null): ConsoleTab {
  return { kind: 'console', id, title: id, connectionId, database, text: '', savedText: '', filePath: null, txMode: 'auto', maxRows: null };
}

function withCatalog(connectionId: string, database: string | null, snapshot: CatalogSnapshot) {
  useCatalog.setState({
    dbs: { [dbKey(connectionId, database)]: { connectionId, database, snapshot } as unknown as DbCatalog },
    conns: {},
  });
}

describe('parameter kinds from the catalog (logic-r1-04)', () => {
  beforeEach(() => {
    useParams.setState({ request: null, skip: {} });
    useCatalog.setState({ dbs: {}, conns: {} });
    useTabs.setState({ tabs: [consoleTab('t_lite', 'c_lite', 'main')], activeId: 't_lite', mru: [], closed: [] });
  });

  it('maps column types to dialog kinds', () => {
    expect(kindOfParamType('long')).toBe('int');
    expect(kindOfParamType('int')).toBe('int');
    expect(kindOfParamType('decimal')).toBe('decimal');
    expect(kindOfParamType('date')).toBe('datetime');
    expect(kindOfParamType('datetime')).toBe('datetime');
    expect(kindOfParamType('bool')).toBe('bool');
    expect(kindOfParamType('guid')).toBe('string');
  });

  it('types positional ? by position and named binds by name, across batches', () => {
    const k = inferredKinds(
      [...batch('SELECT * FROM customers WHERE name = :name AND id > ?'), ...batch('SELECT * FROM customers WHERE country_id = ? AND name = ?')],
      'sqlite', SQLITE,
    );
    expect(Object.fromEntries(k)).toEqual({ NAME: 'string', 1: 'int', 2: 'int', 3: 'string' });
    expect(inferredKinds(batch('SELECT * FROM customers WHERE id > ?'), 'sqlite', null).size).toBe(0);
  });

  it('seeds the dialog: ? compared with an INTEGER column is int, a name with no column falls back to the heuristic', async () => {
    withCatalog('c_lite', 'main', SQLITE);
    render(<ParamsDialogHost />);
    let result: QueryParam[] | null | undefined;
    void resolveParams('t_lite', 'c_lite', 'sqlite', batch('SELECT * FROM customers c WHERE c.name = :city AND c.id > ? AND :orderId = 1'))
      .then((r) => (result = r));
    const type = async (label: string) => selectValue(await screen.findByLabelText(label));
    // the column type wins over the name ("city" would be a string anyway; "? 1" used to be string)
    expect(await type('Type of :city')).toBe('string');
    expect(await type('Type of ?')).toBe('int');
    // compared with a literal: nothing to infer, the name heuristic still applies
    expect(await type('Type of :orderId')).toBe('int');
    // primary button: Run by default
    expect(screen.getByRole('button', { name: /^Run/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Value of ?'), { target: { value: '3' } });
    act(() => useParams.getState().close(null));
    await act(async () => {});
    expect(result).toBeNull();
  });

  it('T-SQL: @id compared with an int column is int even without an id-like name', async () => {
    useTabs.setState({ tabs: [consoleTab('t_ms', 'c_ms', 'Shop')], activeId: 't_ms', mru: [], closed: [] });
    withCatalog('c_ms', 'Shop', TSQL);
    render(<ParamsDialogHost />);
    void resolveParams('t_ms', 'c_ms', 'tsql', batch('UPDATE dbo.Products SET Price = @p WHERE Id = @which'));
    expect(selectValue(await screen.findByLabelText('Type of @p'))).toBe('decimal');
    expect(selectValue(screen.getByLabelText('Type of @which'))).toBe('int');
    act(() => useParams.getState().close(null));
  });

  it('names the primary button after the caller: Explain opens it with "Explain", not "Run"', async () => {
    useConnections.setState({
      connections: [{ id: 'c_lite', name: 'Lite', providerId: 'sqlite', color: null, readOnly: false } as unknown as ConnectionProfile],
      providers: [], loaded: true, error: null,
    });
    withCatalog('c_lite', 'main', SQLITE);
    render(<ParamsDialogHost />);
    const done = explainInTab({ tabId: 't_lite', dialect: 'sqlite', mode: 'estimated', batch: batch('SELECT * FROM customers WHERE id > ?')[0] });
    const button = await screen.findByRole('button', { name: /^Explain/ });
    expect(button).toHaveAttribute('title', 'Explain');
    expect(screen.queryByRole('button', { name: /^Run/ })).not.toBeInTheDocument();
    expect(selectValue(screen.getByLabelText('Type of ?'))).toBe('int');
    act(() => useParams.getState().close(null));
    await done;
  });
});

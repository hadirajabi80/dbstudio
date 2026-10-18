import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import { Explorer, useExplorer } from './Explorer';

const mock = installMockEngine();

function row(label: string) {
  return screen.getAllByRole('treeitem').find((el) => el.querySelector('.tree-label')?.textContent === label);
}

async function expand(label: string) {
  const r = await waitFor(() => {
    const el = row(label);
    if (!el) throw new Error(`row ${label} not found`);
    return el;
  });
  fireEvent.click(r.querySelector('.tree-twisty')!);
}

describe('Explorer', () => {
  beforeEach(async () => {
    mock.reset();
    localStorage.clear();
    useExplorer.setState({ expanded: new Set(), collapsedFolders: new Set(), filter: '', selected: null });
    useCatalog.setState({ conns: {}, dbs: {} });
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    useTabs.setState({ tabs: [], activeId: null, seq: 0 });
    await useConnections.getState().load();
  });

  it('shows every saved connection as a root (grouped by folder) without loading any catalog', () => {
    render(<Explorer />);
    expect(row('Shop (SQLite)')).toBeDefined();
    expect(row('Work')).toBeDefined(); // folder
    expect(row('Prod SQL')).toBeDefined();
    expect(row('Oracle Shop')).toBeDefined();
    expect(mock.ctx.requests.filter((r) => r.url.pathname.includes('/catalog'))).toHaveLength(0);
  });

  it('loads databases, schemas and objects lazily, one level per expansion', async () => {
    render(<Explorer />);
    await expand('Prod SQL');
    await waitFor(() => expect(row('Shop')).toBeDefined());
    expect(row('master')).toBeDefined();
    expect(mock.hits('/catalog/databases')).toHaveLength(1);
    expect(mock.hits('/catalog/schemas')).toHaveLength(0);
    expect(mock.hits('/catalog')).toHaveLength(0);

    await expand('Shop');
    await waitFor(() => expect(row('dbo')).toBeDefined());
    expect(row('Sales')).toBeDefined();
    expect(mock.hits('/catalog/schemas')).toHaveLength(1);
    expect(mock.hits('/catalog')).toHaveLength(0);

    await expand('dbo');
    await waitFor(() => expect(row('Tables')).toBeDefined());
    expect(row('Procedures')).toBeDefined();
    const catalogCalls = mock.hits('/catalog');
    expect(catalogCalls).toHaveLength(1);
    expect(catalogCalls[0].url.searchParams.get('schemas')).toBe('dbo');
    expect(catalogCalls[0].url.searchParams.get('database')).toBe('Shop');
    // Sales was never expanded, so it was never fetched.
    expect(useCatalog.getState().dbs[`c_prod\u0001Shop`].loaded.Sales).toBeUndefined();

    await expand('Tables');
    await waitFor(() => expect(row('customers')).toBeDefined());
    await expand('customers');
    await waitFor(() => expect(row('email')).toBeDefined());
    // Columns come from the already loaded snapshot: no extra request.
    expect(mock.hits('/catalog')).toHaveLength(1);
  });

  it('skips the schema level when a database has a single schema (SQLite) and keeps connections independent', async () => {
    render(<Explorer />);
    await expand('Shop (SQLite)');
    // SQLite's single "main" database and single schema are both flattened.
    await waitFor(() => expect(row('Tables')).toBeDefined());
    expect(row('main')).toBeUndefined();
    expect(row('Triggers')).toBeDefined();
    // a second connection open at the same time
    await expand('Prod SQL');
    await waitFor(() => expect(row('Shop')).toBeDefined());
    expect(Object.keys(useCatalog.getState().conns).sort()).toEqual(['c_prod', 'c_shop']);
    expect(row('Tables')).toBeDefined(); // SQLite tree still expanded
  });

  it('fuzzy-filters loaded objects across connections', async () => {
    render(<Explorer />);
    await expand('Shop (SQLite)');
    // SQLite's single "main" database and single schema are both flattened.
    await waitFor(() => expect(row('Tables')).toBeDefined());
    expect(row('main')).toBeUndefined();
    act(() => useExplorer.getState().setFilter('ordln'));
    await waitFor(() => expect(row('order_lines')).toBeDefined());
    expect(row('customers')).toBeUndefined();
    expect(screen.getByRole('treeitem', { name: /order_lines/ }).querySelectorAll('mark').length).toBeGreaterThan(0);
  });

  it('shows a load error under the connection and does not retry in a loop', async () => {
    mock.ctx.engine.connections.push({ ...mock.ctx.engine.connections[0], id: 'c_gone', name: 'Gone' });
    await useConnections.getState().load();
    mock.ctx.engine.connections = mock.ctx.engine.connections.filter((c) => c.id !== 'c_gone');
    render(<Explorer />);
    await expand('Gone');
    await waitFor(() => expect(screen.getByText('Connection not found')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.hits('/catalog/databases')).toHaveLength(1);
  });
});

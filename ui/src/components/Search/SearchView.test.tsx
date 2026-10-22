// Find in database against the mock engine (db.search stream over the FakeSocket): Ctrl+Shift+F takes its scope from
// the explorer selection, results stream in grouped connection › schema › object › match, the keyboard walks and opens
// them, Esc cancels.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../../api/ws';
import { initCommands } from '../../commands';
import { onGlobalKeyDown, resolveKey, scopesFor } from '../../commands/dispatcher';
import { normalizeShortcut } from '../../commands/keys';
import { findConflicts, getCommand, isEnabled, listBindings, runCommand } from '../../commands/registry';
import { FakeSocket } from '../../mocks/fakeSocket';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useSettings } from '../../store/settings';
import { useTabs, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { installMockEngine, TEST_ENGINE_URL } from '../../test/mockServer';
import { useExplorer } from '../Explorer/explorerStore';
import { useObjectSectionRequests } from '../ObjectTab/sectionRequests';
import { SEARCH_VIEW, type SearchTabState } from './model';
import { openSearch } from './open';
import { SearchView } from './SearchView';
import { useSearchRuns } from './searchStore';

const mock = installMockEngine({ frameDelay: 0 });
const SLOW = { timeout: 8000 };

beforeAll(async () => {
  await initCommands();
  engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
  engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
  await waitFor(() => expect(engineSocket.status).toBe('open'));
});

afterAll(() => engineSocket.disconnect());

beforeEach(async () => {
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
  useExplorer.setState({ selected: null, selectedTarget: null });
  useSearchRuns.setState({ runs: {} });
  useCatalog.setState({ conns: {}, dbs: {} });
  await useSettings.getState().load();
  await useConnections.getState().load();
});

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <SearchView tab={tab} theme="light" visible /> : null;
}

const searchTab = () => useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === SEARCH_VIEW);
const stateOf = () => searchTab()!.state as SearchTabState;

/** Focus an element inside a fake explorer (the dispatcher and openSearch look at the focused element). */
function focusExplorer(): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-command-scope', 'explorer');
  const tree = document.createElement('div');
  tree.tabIndex = 0;
  host.appendChild(tree);
  document.body.appendChild(host);
  tree.focus();
  return tree;
}

describe('Ctrl+Shift+F', () => {
  it('is Find in database everywhere, and the grid quick filter moved to Ctrl+Alt+F', () => {
    expect(getCommand('search.findInDatabase')?.shortcut).toBe('Mod+Shift+F');
    expect(findConflicts()).toEqual([]);
    // In a grid the global command wins now: no grid command is bound to the key any more.
    expect(resolveKey(normalizeShortcut('Mod+Shift+F'), ['grid', 'dataTab', 'global'])).toBe('search.findInDatabase');
    expect(listBindings().filter((b) => b.commandId === 'grid.quickFilterCell').map((b) => [b.key, b.scope])).toEqual([[normalizeShortcut('Mod+Alt+F'), 'grid']]);
  });

  it('takes the scope from the explorer selection when the explorer has focus', () => {
    useExplorer.setState({ selectedTarget: { kind: 'container', connectionId: 'c_prod', database: 'Shop', schema: 'dbo' } });
    const tree = focusExplorer();
    expect(scopesFor(tree)).toContain('explorer');
    const ev = new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'target', { value: tree });
    act(() => onGlobalKeyDown(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(stateOf().scope).toEqual({ kind: 'schema', connectionId: 'c_prod', database: 'Shop', schema: 'dbo' });
    expect(useTabs.getState().activeId).toBe(searchTab()!.id);

    // A type folder: its schema and the type filter; a table: that table. Re-opening reuses the one Search tab.
    useExplorer.setState({ selectedTarget: { kind: 'container', connectionId: 'c_prod', database: 'Shop', schema: 'dbo', objectType: 'proc' } });
    tree.focus();
    act(() => void runCommand('search.findInDatabase'));
    expect(stateOf()).toMatchObject({ scope: { kind: 'schema', schema: 'dbo' }, types: ['procs'] });
    useExplorer.setState({ selectedTarget: { kind: 'object', connectionId: 'c_prod', database: 'Shop', ref: { database: 'Shop', schema: 'dbo', name: 'orders', type: 'table' } } });
    tree.focus();
    act(() => void runCommand('search.findInDatabase'));
    expect(stateOf().scope).toEqual({ kind: 'objects', connectionId: 'c_prod', database: 'Shop', objects: [{ schema: 'dbo', name: 'orders', type: 'table' }] });
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'view' && t.view === SEARCH_VIEW)).toHaveLength(1);
    tree.parentElement!.remove();
  });

  it('searches every connected connection when the explorer does not have focus, and offers the console connection', () => {
    useExplorer.setState({ selectedTarget: { kind: 'connection', connectionId: 'c_prod' } });
    useTabs.getState().newConsole({ connectionId: 'c_pg' });
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => void runCommand('search.findInDatabase'));
    expect(stateOf().scope).toEqual({ kind: 'all' });
    expect(stateOf().consoleConnectionId).toBe('c_pg');
  });

  it('a context menu passes its node; Redis is not searchable', () => {
    expect(isEnabled('search.findInDatabase', { kind: 'connection', connectionId: 'c_redis' })).toBe(false);
    act(() => void runCommand('search.findInDatabase', { kind: 'connection', connectionId: 'c_ora' }));
    expect(stateOf().scope).toEqual({ kind: 'connection', connectionId: 'c_ora' });
    // Selected Redis node with the explorer focused: falls back to every connection with a note.
    useExplorer.setState({ selectedTarget: { kind: 'connection', connectionId: 'c_redis' } });
    const tree = focusExplorer();
    useUi.setState({ toasts: [] });
    act(() => void runCommand('search.findInDatabase'));
    expect(stateOf().scope).toEqual({ kind: 'all' });
    expect(useUi.getState().toasts.some((t) => t.kind === 'info' && /cannot be searched/.test(t.text))).toBe(true);
    tree.parentElement!.remove();
    expect(runCommand('search.findInDatabase', { kind: 'connection', connectionId: 'c_redis' })).toBe(false);
  });
});

describe('Search tab', () => {
  it('streams grouped results, walks them with the keyboard and opens matches', async () => {
    const { tabId } = openSearch({ kind: 'connection', connectionId: 'c_prod' });
    render(<Host id={tabId} />);
    const input = screen.getByRole('textbox', { name: 'Search for' });
    fireEvent.change(input, { target: { value: 'customer' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();
    await waitFor(() => expect(useSearchRuns.getState().runs[tabId]?.status).toBe('done'), SLOW);
    expect(mock.hits('/streams', 'POST')).toHaveLength(1);

    const tree = screen.getByRole('tree', { name: 'Search results' });
    const items = () => within(tree).getAllByRole('treeitem');
    await waitFor(() => expect(items().length).toBeGreaterThan(5));
    expect(items()[0].textContent).toContain('Prod SQL');
    expect(items()[1].textContent).toMatch(/Shop › dbo/);
    const labels = items().map((i) => i.textContent ?? '');
    expect(labels.some((l) => l.includes('customers') && l.includes('name'))).toBe(true); // name match badge
    expect(labels.some((l) => l.includes('customer_id'))).toBe(true); // a column
    expect(labels.some((l) => /^\s*\d+\s*SELECT \* FROM dbo\.customers/.test(l))).toBe(true); // a code line with its number
    expect(screen.getByRole('status').textContent).toMatch(/\d+ matches in \d+ objects/);
    expect(tree.querySelector('mark')?.textContent?.toLowerCase()).toBe('customer');

    // Keyboard: ArrowDown from the box into the list; Left collapses; Enter on a code line opens the DDL at the match.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(tree.getAttribute('aria-activedescendant')).toBe('sx-row-0');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(items()).toHaveLength(1);
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(items().length).toBeGreaterThan(5);
    const codeIndex = items().findIndex((i) => /SELECT \* FROM dbo\.customers/.test(i.textContent ?? ''));
    for (let i = 0; i < codeIndex; i++) fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree.getAttribute('aria-activedescendant')).toBe(`sx-row-${codeIndex}`);
    fireEvent.keyDown(tree, { key: 'Enter' });
    const objectTab = useTabs.getState().tabs.find((t) => t.kind === 'object');
    expect(objectTab).toMatchObject({ kind: 'object', ref: { name: 'GetCustomer', type: 'proc' }, database: 'Shop' });
    expect(useObjectSectionRequests.getState().requests[objectTab!.id]).toMatchObject({ section: 'ddl', reveal: { text: 'customer', line: 5 } });

    // Double-click on an object row opens it (the object tab of the table).
    const customers = items().find((i) => i.querySelector('.sx-name')?.textContent === 'customers')!;
    fireEvent.doubleClick(customers);
    expect(useTabs.getState().tabs.some((t) => t.kind === 'object' && t.ref.name === 'customers')).toBe(true);
  });

  it('data search opens the table filtered on the row; Esc cancels a running search', async () => {
    const { tabId } = openSearch({ kind: 'container', connectionId: 'c_shop', database: 'main', schema: 'main' });
    act(() => useTabs.getState().updateView(tabId, { state: { ...stateOf(), term: 'Lovelace', names: false, columns: false, code: false, data: true, rowLimit: 3 } }));
    render(<Host id={tabId} />);
    expect(screen.getByRole('checkbox', { name: 'Table data' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Rows per table' })).toHaveValue(3);
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(useSearchRuns.getState().runs[tabId]?.status).toBe('done'), SLOW);
    const run = useSearchRuns.getState().runs[tabId];
    expect(run.hits.length).toBeGreaterThan(0);
    expect(run.hits.every((h) => h.match === 'data')).toBe(true);
    const tree = screen.getByRole('tree', { name: 'Search results' });
    const dataRow = within(tree).getAllByRole('treeitem').find((i) => i.textContent?.includes('Lovelace') && i.textContent.includes('id = '))!;
    fireEvent.doubleClick(dataRow);
    const data = useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === 'data');
    expect(data?.title).toMatch(/customers/);
    expect(JSON.stringify((data!.state as { filter: unknown }).filter)).toMatch(/"op":"eq"/);

    // A connection-wide scope disables data search.
    act(() => useTabs.getState().updateView(tabId, { state: { ...stateOf(), scope: { kind: 'connection', connectionId: 'c_shop' } } }));
    expect(screen.getByRole('checkbox', { name: 'Table data' })).toBeDisabled();

    // Esc in the box while running cancels (the stream is closed).
    act(() => useTabs.getState().updateView(tabId, { state: { ...stateOf(), term: 'a', names: true } }));
    const input = screen.getByRole('textbox', { name: 'Search for' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(useSearchRuns.getState().runs[tabId]?.streamId).toBeTruthy());
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(useSearchRuns.getState().runs[tabId]?.status).toBe('cancelled'));
    await waitFor(() => expect(mock.ctx.requests.some((r) => r.method === 'DELETE' && r.url.pathname.includes('/streams/'))).toBe(true));
    expect(screen.getByRole('status').textContent).toMatch(/cancelled/);
  });

  it('the scope picker lists connections and switches the scope', async () => {
    const { tabId } = openSearch({ kind: 'connection', connectionId: 'c_prod' });
    render(<Host id={tabId} />);
    fireEvent.click(screen.getByRole('button', { name: /Prod SQL/ }));
    const picker = screen.getByRole('dialog', { name: 'Where to search' });
    const rows = () => within(picker).getAllByRole('treeitem');
    expect(rows().map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('All connected connections'), expect.stringContaining('Oracle Shop')]));
    expect(rows().some((r) => r.textContent?.includes('Redis'))).toBe(false); // not searchable
    // Prod SQL is expanded (the current scope): its databases load.
    await waitFor(() => expect(rows().some((r) => r.textContent === 'Shop')).toBe(true), SLOW);
    fireEvent.click(rows().find((r) => r.textContent === 'Shop')!);
    expect(stateOf().scope).toEqual({ kind: 'database', connectionId: 'c_prod', database: 'Shop' });
    expect(screen.queryByRole('dialog', { name: 'Where to search' })).toBeNull();
    expect(screen.getByRole('button', { name: /Prod SQL › Shop/ })).toBeInTheDocument();
  });
});

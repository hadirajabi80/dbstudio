// Saved queries end to end against the mock engine: the commands and menus, saving a console to a schema (the dialog,
// its inline duplicate check), the console's binding (title, unsaved dot, Ctrl+S writes the query back, ordered after
// edit sessions and before files), opening / renaming / duplicating / deleting, Ctrl+P and the Objects tab group.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTab } from '../../app/actions';
import { initCommands } from '../../commands';
import { normalizeShortcut } from '../../commands/keys';
import { CONTEXT_MENUS, MENUS } from '../../commands/menuModel';
import { findConflicts, getCommand, isEnabled, listBindings, runCommand } from '../../commands/registry';
import type { SavedQueryTarget } from '../../commands/types';
import { useDesignerUi } from '../../designer/store';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useSavedQueries } from '../../store/savedQueries';
import { useSettings } from '../../store/settings';
import { isDirty, useTabs, type ConsoleTab, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { installMockEngine } from '../../test/mockServer';
import { getPlatform } from '../../platform';
import { collectEntries, searchObjects } from '../CommandPalette/objectIndex';
import { runObjectHit } from '../CommandPalette/CommandPalette';
import { MenuHost } from '../common/Menu';
import { useExplorer } from '../Explorer/explorerStore';
import { OBJECTS_VIEW } from '../ObjectList/model';
import { ObjectListView } from '../ObjectList/ObjectListView';
import type { ObjectsState } from '../ObjectList/open';
import { Toolbar } from '../Toolbar/Toolbar';
import { applyRename, consoleScope, openSavedQuery, saveConsoleAs } from './actions';
import { useSavedQueryDialog } from './dialogStore';
import { scopeOptions } from './model';
import { SavedQueryDialog } from './SavedQueryDialog';

const mock = installMockEngine({ frameDelay: 0 });
const SLOW = { timeout: 8000 };

beforeAll(() => initCommands(), 60_000);

const consoleOn = (over: Partial<ConsoleTab> = {}): ConsoleTab => ({
  kind: 'console', id: 't1', title: 'Console 1', connectionId: 'c_shop', database: null, text: 'SELECT * FROM orders', savedText: '', filePath: null,
  txMode: 'auto', maxRows: null, ...over,
});

const tab = (id = 't1') => useTabs.getState().tabs.find((t) => t.id === id) as ConsoleTab;
const top: SavedQueryTarget = { kind: 'savedQuery', connectionId: 'c_shop', database: 'main', schema: 'main', id: 'q_seed_1', name: 'Top customers' };

let ask: ReturnType<typeof vi.fn>;
let origAsk: ReturnType<typeof useUi.getState>['askConfirm'];

beforeEach(async () => {
  mock.reset();
  useSavedQueries.setState({ byConn: {} });
  useSavedQueryDialog.setState({ request: null });
  useDesignerUi.setState({ edits: {}, editRunInFlight: {} });
  useTabs.setState({ tabs: [consoleOn()], activeId: 't1', seq: 1, mru: [], closed: [] });
  useExplorer.setState({ selected: null, selectedTarget: null });
  await useSettings.getState().load();
  await useConnections.getState().load();
  await useCatalog.getState().loadDatabases('c_shop');
  await useCatalog.getState().ensureDefault('c_shop', 'main');
  origAsk = useUi.getState().askConfirm;
  ask = vi.fn(async () => true);
  useUi.setState({ askConfirm: ask as unknown as typeof origAsk, toasts: [] });
});

afterEach(() => {
  useUi.setState({ askConfirm: origAsk });
});

describe('commands and menus', () => {
  it('registers Save query to schema on Mod+Alt+S without a conflict, in the File menu and the tab menu', () => {
    const c = getCommand('queries.saveToSchema')!;
    expect(c.shortcut).toBe('Mod+Alt+S');
    expect(listBindings().filter((b) => b.key === normalizeShortcut('Mod+Alt+S') && b.scope === 'global').map((b) => b.commandId)).toEqual(['queries.saveToSchema']);
    expect(findConflicts().filter((x) => x.commands.some((id) => id.startsWith('queries.')))).toEqual([]);
    expect(MENUS.find((m) => m.id === 'file')!.items.some((i) => 'command' in i && i.command === 'queries.saveToSchema')).toBe(true);
    expect(CONTEXT_MENUS.tab.some((e) => typeof e === 'object' && 'command' in e && e.command === 'queries.saveToSchema')).toBe(true);
    expect(getCommand('queries.rename')).toMatchObject({ shortcut: 'F2', scope: 'explorer' });
    expect(isEnabled('queries.saveToSchema')).toBe(true); // the active console has a SQL connection
    useTabs.setState({ tabs: [consoleOn({ connectionId: null })] });
    expect(isEnabled('queries.saveToSchema')).toBe(false);
  });

  it('every saved query menu entry is a registered command', () => {
    for (const id of ['explorer.queries', 'explorer.savedQuery']) {
      for (const e of CONTEXT_MENUS[id]) if (typeof e === 'object' && 'command' in e) expect(getCommand(e.command), e.command).toBeTruthy();
    }
  });
});

describe('saving a console to a schema', () => {
  it('defaults to the console database and schema, refined by an explorer schema of the same database', () => {
    expect(consoleScope(tab())).toEqual({ connectionId: 'c_shop', database: 'main', schema: 'main' });
    useExplorer.setState({ selectedTarget: { kind: 'container', connectionId: 'c_shop', database: 'main', schema: 'temp' } });
    expect(consoleScope(tab())?.schema).toBe('temp');
    useExplorer.setState({ selectedTarget: { kind: 'container', connectionId: 'c_prod', database: 'Shop', schema: 'sales' } });
    expect(consoleScope(tab())?.schema).toBe('main');
  });

  it('the command opens the dialog; a duplicate name is an inline error; Save binds the console', async () => {
    expect(runCommand('queries.saveToSchema')).toBe(true);
    const req = useSavedQueryDialog.getState().request!;
    expect(req).toMatchObject({ mode: 'save', tabId: 't1', connectionId: 'c_shop', scope: { database: 'main', schema: 'main' } });
    render(<SavedQueryDialog request={req} />);
    await waitFor(() => expect(useSavedQueries.getState().byConn.c_shop?.status).toBe('ready'));
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name.value).toBe('Query 1');
    fireEvent.change(name, { target: { value: 'top CUSTOMERS' } });
    expect(screen.getByRole('alert')).toHaveTextContent('A query named “top CUSTOMERS” already exists in main.');
    expect(screen.getByTestId('sq-submit')).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Big orders' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'over 100' } });
    fireEvent.click(screen.getByTestId('sq-submit'));
    await waitFor(() => expect(useSavedQueryDialog.getState().request).toBeNull(), SLOW);

    const t = tab();
    expect(t.title).toBe('Query: Big orders');
    expect(t.savedQuery).toMatchObject({ connectionId: 'c_shop', database: 'main', schema: 'main', name: 'Big orders' });
    expect(isDirty(t)).toBe(false);
    const saved = useSavedQueries.getState().byConn.c_shop!.items.find((x) => x.name === 'Big orders')!;
    expect(saved).toMatchObject({ sql: 'SELECT * FROM orders', description: 'over 100' });
  });

  it('a name the server refuses (another window took it) shows the inline error too', async () => {
    useSavedQueries.setState({ byConn: { c_shop: { status: 'ready', items: [] } } }); // the UI does not know the seeded names
    render(<SavedQueryDialog request={{ mode: 'save', tabId: 't1', connectionId: 'c_shop', scope: { connectionId: 'c_shop', database: 'main', schema: 'main' } }} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Low stock' } });
    fireEvent.click(screen.getByTestId('sq-submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already exists'), SLOW);
    expect(tab().savedQuery).toBeFalsy();
  });

  it('the schema picker lists the catalog schemas, the default first', () => {
    const { options } = scopeOptions(useCatalog.getState().dbs, 'c_shop', false, { connectionId: 'c_shop', database: 'main', schema: 'main' });
    expect(options[0]).toMatchObject({ label: 'main' });
    const none = scopeOptions({}, 'c_x', true, { connectionId: 'c_x', database: 'Shop', schema: 'dbo' });
    expect(none.options).toEqual([{ value: 'Shop\u0001dbo', label: 'dbo', group: 'Shop' }]);
  });
});

describe('a console bound to a saved query', () => {
  async function bound() {
    await useSavedQueries.getState().ensure('c_shop');
    await saveConsoleAs('t1', { connectionId: 'c_shop', database: 'main', schema: 'main' }, 'Weekly', null);
    return tab().savedQuery!;
  }

  it('shows the unsaved dot; Ctrl+S (file.save) writes the text back to the query', async () => {
    const b = await bound();
    act(() => useTabs.getState().updateText('t1', 'SELECT 42'));
    expect(isDirty(tab())).toBe(true);
    const { container } = render(<Toolbar tab={tab()} />);
    const save = container.querySelector<HTMLButtonElement>('[data-command="file.save"]')!;
    expect(save).toHaveAttribute('data-dirty', 'true');
    expect(save).toHaveAccessibleName('Save query, unsaved changes');

    expect(runCommand('file.save')).toBe(true);
    await waitFor(() => expect(isDirty(tab())).toBe(false), SLOW);
    expect(mock.hits(`/queries/${b.id}`, 'PUT')).toHaveLength(1);
    expect(useSavedQueries.getState().byConn.c_shop!.items.find((x) => x.id === b.id)?.sql).toBe('SELECT 42');
    expect(tab().title).toBe('Query: Weekly');
  });

  it('an edit session wins over the binding, an ordinary console never writes a query', async () => {
    await bound();
    const qs = getCommand('queries.save')!;
    const orig = qs.run;
    const spy = vi.fn();
    qs.run = spy;
    const file = vi.spyOn(getPlatform(), 'saveFile').mockResolvedValue(null);
    try {
      useDesignerUi.setState({ edits: { t1: { connectionId: 'c_shop', database: null, ref: { database: null, schema: 'main', name: 'v', type: 'view' }, dialect: 'sqlite', savedText: '' } } });
      runCommand('file.save');
      expect(spy).not.toHaveBeenCalled();
      useDesignerUi.setState({ edits: {} });
      runCommand('file.save');
      expect(spy).toHaveBeenCalledTimes(1);
      useTabs.getState().bindSavedQuery('t1', null);
      runCommand('file.save');
      expect(spy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(file).toHaveBeenCalledTimes(1)); // an ordinary console saves a .sql file
    } finally {
      qs.run = orig;
      file.mockRestore();
    }
  });

  it('closing with unsaved changes asks first', async () => {
    await bound();
    act(() => useTabs.getState().updateText('t1', 'SELECT 7'));
    ask.mockResolvedValueOnce(false);
    await closeTab('t1');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unsaved changes', message: expect.stringContaining('the query Weekly') }));
    expect(useTabs.getState().tabs).toHaveLength(1);
  });

  it('Save as a .sql file turns it back into a file console; a rename follows into the title', async () => {
    const b = await bound();
    const q = useSavedQueries.getState().byConn.c_shop!.items.find((x) => x.id === b.id)!;
    applyRename(q, { ...q, name: 'Weekly v2' });
    expect(tab().title).toBe('Query: Weekly v2');
    expect(tab().savedQuery?.name).toBe('Weekly v2');
    useTabs.getState().markSaved('t1', 'C:/sql/weekly.sql', 'weekly.sql');
    expect(tab().savedQuery).toBeNull();
    expect(tab().filePath).toBe('C:/sql/weekly.sql');
  });
});

describe('opening, duplicating and deleting', () => {
  it('opens a query in a console bound to it (once), on its connection', async () => {
    openSavedQuery(top);
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2), SLOW);
    const t = useTabs.getState().tabs.find((x) => x.id !== 't1') as ConsoleTab;
    expect(t).toMatchObject({ title: 'Query: Top customers', connectionId: 'c_shop', database: null });
    expect(t.text).toContain('SUM(o.total)');
    expect(isDirty(t)).toBe(false);
    useTabs.getState().activate('t1');
    runCommand('queries.open', top);
    await waitFor(() => expect(useTabs.getState().activeId).toBe(t.id));
    expect(useTabs.getState().tabs).toHaveLength(2);
  });

  it('duplicates next to the original and selects the copy in the explorer', async () => {
    await useSavedQueries.getState().ensure('c_shop');
    runCommand('queries.duplicate', top);
    await waitFor(() => expect(useSavedQueries.getState().byConn.c_shop!.items.some((x) => x.name === 'Top customers (copy)')).toBe(true), SLOW);
    expect(useExplorer.getState().selectedTarget).toMatchObject({ kind: 'savedQuery', name: 'Top customers (copy)' });
  });

  it('delete asks, removes the query and unbinds its console', async () => {
    await useSavedQueries.getState().ensure('c_shop');
    openSavedQuery(top);
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(2), SLOW);
    const id = useTabs.getState().tabs.find((x) => x.id !== 't1')!.id;
    runCommand('queries.delete', top);
    await waitFor(() => expect(useSavedQueries.getState().byConn.c_shop?.items.some((x) => x.id === top.id)).toBe(false), SLOW);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete query', danger: true }));
    await waitFor(() => expect(tab(id).savedQuery).toBeNull());
    expect(tab(id).title).toBe('Top customers');
  });

  it('rename opens the dialog on the query', async () => {
    runCommand('queries.rename', top);
    await waitFor(() => expect(useSavedQueryDialog.getState().request).toMatchObject({ mode: 'rename', query: { id: top.id } }), SLOW);
  });
});

describe('Ctrl+P and the Objects tab', () => {
  it('Go to object finds saved queries (q: prefix) and opens them', async () => {
    await useSavedQueries.getState().ensure('c_shop');
    const groups = collectEntries({}, false, false, useSavedQueries.getState().byConn);
    const hits = searchObjects(groups, 'q:low');
    expect(hits.map((h) => h.entry.name)).toEqual(['Low stock']);
    expect(searchObjects(groups, 't:low')).toEqual([]);
    runObjectHit(hits[0].entry, 'open');
    await waitFor(() => expect(useTabs.getState().tabs.some((t) => t.title === 'Query: Low stock')).toBe(true), SLOW);
  });

  it('lists the schema queries in a Queries group with its count, Enter opens one', async () => {
    const state: ObjectsState = { connectionId: 'c_shop', database: null, schema: 'main', group: 'queries', layout: 'list', sort: { key: 'name', dir: 'asc' } };
    const view: ViewTab = { kind: 'view', id: 'v1', title: 'Objects: main', view: OBJECTS_VIEW, connectionId: 'c_shop', database: null, state };
    act(() => useTabs.setState({ tabs: [consoleOn(), view], activeId: 'v1' }));
    render(<><ObjectListView tab={view} theme="light" visible /><MenuHost /></>);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3), SLOW);
    const groups = screen.getByRole('tablist', { name: 'Object types' });
    expect(within(groups).getByRole('tab', { name: /^Queries\s*3$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.ol-name-text')?.textContent)).toEqual(['Low stock', 'Orders this week', 'Top customers']);
    expect(screen.getByRole('columnheader', { name: /Description/ })).toBeInTheDocument();
    expect(screen.getByText('Products to reorder')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter queries'), { target: { value: 'week' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    const list = screen.getByRole('listbox');
    fireEvent.focus(list);
    fireEvent.keyDown(list, { key: 'Enter' });
    await waitFor(() => expect(useTabs.getState().tabs.some((t) => t.title === 'Query: Orders this week')).toBe(true), SLOW);
  });
});

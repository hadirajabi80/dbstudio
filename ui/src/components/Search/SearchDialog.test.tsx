// The Find in database dialog (Ctrl+Shift+F) against the mock engine: it opens over the workspace with the box
// focused, searches as you type (table data waits for Enter), walks the matches with the focus in the box, opens
// one (Enter closes, Ctrl+Enter keeps it open), previews the selected match, cancels then closes on Esc, comes back
// with the last query and results, and "Open in tab" moves everything into the Search tab.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../../api/ws';
import { initCommands } from '../../commands';
import { runCommand } from '../../commands/registry';
import { FakeSocket } from '../../mocks/fakeSocket';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useSettings } from '../../store/settings';
import { useTabs, type ViewTab } from '../../store/tabs';
import { installMockEngine, TEST_ENGINE_URL } from '../../test/mockServer';
import { useExplorer } from '../Explorer/explorerStore';
import { SEARCH_DIALOG_RUN, useSearchDialog } from './dialogStore';
import { SEARCH_VIEW, type SearchTabState } from './model';
import { clearPreviewCache } from './previewCache';
import { SearchDialogHost } from './SearchDialogHost';
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
  useSearchDialog.setState({ open: false, state: null, explorerKey: null, size: null, preview: true });
  useCatalog.setState({ conns: {}, dbs: {} });
  clearPreviewCache();
  await useSettings.getState().load();
  await useConnections.getState().load();
});

const posts = () => mock.hits('/streams', 'POST').length;
const run = () => useSearchRuns.getState().runs[SEARCH_DIALOG_RUN];

async function openDialog(args?: unknown) {
  act(() => void runCommand('search.findInDatabase', args));
  const dialog = await screen.findByRole('dialog', { name: 'Find in database' });
  const input = within(dialog).getByRole('textbox', { name: 'Search for' });
  return { dialog, input };
}

/** Types a term and waits for the as-you-type search to finish. */
async function search(input: HTMLElement, term: string) {
  fireEvent.change(input, { target: { value: term } });
  await waitFor(() => expect(run()?.status).toBe('done'), SLOW);
}

const items = () => within(screen.getByRole('tree', { name: 'Search results' })).getAllByRole('treeitem');
const activeText = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.textContent ?? '';

describe('Find in database dialog', () => {
  it('opens with the box focused, searches as you type, Esc closes, Ctrl+Shift+F brings the query and results back', async () => {
    render(<SearchDialogHost />);
    const { dialog, input } = await openDialog({ kind: 'connection', connectionId: 'c_prod' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(within(dialog).getByRole('button', { name: /Prod SQL/ })).toBeInTheDocument(); // the scope

    await search(input, 'customer');
    expect(posts()).toBe(1);
    await waitFor(() => expect(items().length).toBeGreaterThan(5));
    expect(within(dialog).getAllByRole('status')[0].textContent).toMatch(/\d+ matches in \d+ objects/);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useSearchDialog.getState().open).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find in database' })).toBeNull());

    const again = await openDialog();
    expect(again.input).toHaveValue('customer');
    expect(items().length).toBeGreaterThan(5); // the results came back, nothing was searched again
    expect(posts()).toBe(1);
  });

  it('↑/↓ walk the matches with the focus in the box; Ctrl+Enter opens and stays, Enter opens and closes', async () => {
    render(<SearchDialogHost />);
    const { input } = await openDialog({ kind: 'connection', connectionId: 'c_prod' });
    await search(input, 'customer');
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toBeTruthy());
    // The first match is selected (the connection and schema headers are skipped).
    expect(activeText(input)).toContain('customers');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeText(input)).not.toContain('customers table');
    expect(document.activeElement).toBe(input);

    // Down to the code line of GetCustomer, then up and down again.
    for (let i = 0; i < 20 && !/SELECT \* FROM dbo\.customers/.test(activeText(input)); i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeText(input)).toMatch(/SELECT \* FROM dbo\.customers/);

    // The preview shows the definition around the match, the match highlighted.
    const preview = await screen.findByRole('region', { name: 'Preview' });
    await waitFor(() => expect(preview.querySelector('.sx-pv-line.focus')?.textContent).toMatch(/SELECT \* FROM dbo\.customers/), SLOW);
    expect(preview.querySelector('.sx-pv-line.focus mark')?.textContent?.toLowerCase()).toBe('customer');

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    const objectTab = () => useTabs.getState().tabs.find((t) => t.kind === 'object');
    expect(objectTab()).toMatchObject({ kind: 'object', ref: { type: 'proc' } });
    expect(useSearchDialog.getState().open).toBe(true);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSearchDialog.getState().open).toBe(false);
  });

  it('table data waits for Enter; Esc cancels a running search before it closes the dialog', async () => {
    render(<SearchDialogHost />);
    const { input } = await openDialog({ kind: 'container', connectionId: 'c_shop', database: 'main', schema: 'main' });
    act(() => useSearchDialog.getState().update({ names: false, columns: false, code: false, data: true, rowLimit: 3 }));
    fireEvent.change(input, { target: { value: 'Lovelace' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(posts()).toBe(0); // not as you type
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(run()?.status).toBe('done'), SLOW);
    expect(run().hits.every((h) => h.match === 'data')).toBe(true);

    // A long search: Esc cancels it (the dialog stays), the next Esc closes.
    act(() => useSearchDialog.getState().update({ names: true, data: true }));
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(run()?.streamId).toBeTruthy());
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(run()?.status).toBe('cancelled'));
    expect(useSearchDialog.getState().open).toBe(true);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useSearchDialog.getState().open).toBe(false);
  });

  it('"Open in tab" moves the query and its results into the Search tab', async () => {
    render(<SearchDialogHost />);
    const { dialog, input } = await openDialog({ kind: 'connection', connectionId: 'c_prod' });
    await search(input, 'customer');
    const hits = run().hits.length;
    expect(hits).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /Open in tab/ }));
    expect(useSearchDialog.getState().open).toBe(false);
    const tab = useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === SEARCH_VIEW)!;
    expect(tab).toBeDefined();
    expect(useTabs.getState().activeId).toBe(tab.id);
    expect(tab.state as SearchTabState).toMatchObject({ term: 'customer', scope: { kind: 'connection', connectionId: 'c_prod' } });
    expect(useSearchRuns.getState().runs[tab.id]?.hits).toHaveLength(hits);
    expect(run()).toBeUndefined();
  });

  it('a running search keeps streaming into the tab it moved to', async () => {
    useSearchDialog.setState({ open: false, state: null });
    render(<SearchDialogHost />);
    const { input } = await openDialog({ kind: 'container', connectionId: 'c_shop', database: 'main', schema: 'main' });
    act(() => useSearchDialog.getState().update({ data: true }));
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(run()?.streamId).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Open in tab/ }));
    const tab = useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === SEARCH_VIEW)!;
    await waitFor(() => expect(useSearchRuns.getState().runs[tab.id]?.status).not.toBe('running'), SLOW);
    expect(useSearchRuns.getState().runs[tab.id]?.hits.length).toBeGreaterThan(0);
    expect(run()).toBeUndefined();
  });
});

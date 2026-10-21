// ER diagram view over the MSW mock engine (SQLite shop): renders cards, search, remove, layout save + restore,
// keyboard-only walk (Tab through cards → Enter opens data → F4 designs).
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../../../commands';
import { installKeyDispatcher } from '../../../commands/dispatcher';
import { getCommand, runCommand } from '../../../commands/registry';
import { CONTEXT_MENUS } from '../../../commands/menuModel';
import { until } from '../../../mocks/m15/testServer';
import { mockDiagrams } from '../../../mocks/m2/er';
import { installMockEngine } from '../../../test/mockServer';
import { useCatalog } from '../../../store/catalog';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { activeController } from '../controllers';
import { ErDiagramView } from '../ErDiagramView';
import { ER_VIEW, type ErTabState } from '../store';

const mock = installMockEngine();
let uninstallKeys: () => void = () => {};
const realRect = Element.prototype.getBoundingClientRect;

beforeAll(async () => {
  await initCommands();
  uninstallKeys = installKeyDispatcher();
  await useConnections.getState().load();
  // jsdom has no layout: give the canvas a viewport
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    if (this.classList?.contains('er-canvas')) return { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON: () => ({}) } as DOMRect;
    return realRect.call(this);
  };
}, 60_000);
afterAll(() => {
  uninstallKeys();
  Element.prototype.getBoundingClientRect = realRect;
});
beforeEach(() => {
  mockDiagrams.items = [];
  useTabs.setState({ tabs: [], activeId: null, mru: [] });
  useCatalog.setState({ conns: {}, dbs: {} });
});
afterEach(() => {
  for (const t of useTabs.getState().tabs) useTabs.getState().close(t.id);
});

function openTab(): ViewTab {
  const state: ErTabState = { connectionId: 'c_shop', database: null, scope: { database: null, schema: 'main' } };
  const id = useTabs.getState().openView({ view: ER_VIEW, title: 'ER: Shop (SQLite)', connectionId: 'c_shop', database: null, state, key: 'k' });
  return useTabs.getState().tabs.find((t) => t.id === id) as ViewTab;
}

const cards = () => screen.queryAllByRole('button', { name: /^(Table|View) / });
const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^(Table|View) ${name},`) });

async function mountReady(tab = openTab()) {
  const r = render(<ErDiagramView tab={tab} theme="light" visible />);
  await until(() => activeController()?.state.phase === 'ready' && cards().length >= 7, 8000);
  return r;
}

describe('ER diagram view', () => {
  it('renders every table of the schema with columns, keys and relationships', async () => {
    await mountReady();
    const orders = card('orders');
    expect(within(orders).getByText('customer_id')).toBeInTheDocument();
    expect(orders.querySelector('.er-row.fk[data-col="customer_id"]')).not.toBeNull();
    expect(orders.querySelector('.er-row.pk[data-col="id"]')).not.toBeNull();
    expect(card('v_customer_orders').className).toContain('view');
    expect(document.querySelectorAll('.er-edges [data-edge].er-edge')).toHaveLength(5);
    expect(screen.getByRole('application', { name: /ER: Shop/ })).toBeInTheDocument();
    expect(screen.getByText(/7 tables · 5 relationships/)).toBeInTheDocument();
    // details pane summary with nothing selected
    expect(screen.getByRole('complementary', { name: 'Diagram details' })).toHaveTextContent('Relationships5');
  });

  it('search highlights matches and Enter zooms to and pulses the next one', async () => {
    await mountReady();
    const box = screen.getByRole('textbox', { name: 'Find table or column' });
    fireEvent.change(box, { target: { value: 'product' } });
    await until(() => card('products').className.includes('match'));
    expect(card('order_lines').className).toContain('match'); // column product_id
    expect(card('customers').className).not.toContain('match');
    fireEvent.keyDown(box, { key: 'Enter' });
    await until(() => card('products').className.includes('pulse'));
    expect(activeController()!.state.selection).toEqual(['main.products']);
    expect(screen.getByText('1/2')).toBeInTheDocument();
    // Ctrl+F (er scope) focuses the box again
    card('products').focus();
    fireEvent.keyDown(card('products'), { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(document.activeElement).toBe(box);
  });

  it('Delete removes a table from the diagram (not the database) and the layout is saved and restored', async () => {
    const tab = openTab();
    const r = await mountReady(tab);
    const events = card('events');
    fireEvent.pointerDown(events, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(events, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(activeController()!.state.selection).toEqual(['main.events']);
    fireEvent.keyDown(events, { key: 'Delete', code: 'Delete' });
    await until(() => !screen.queryByRole('button', { name: /^Table events,/ }));
    expect(screen.getByText(/6 tables · 4 relationships/)).toBeInTheDocument();
    // moved card + debounced save (800 ms)
    const c = activeController()!;
    const before = c.state.positions['main.orders'];
    act(() => c.moveTo({ 'main.orders': [before[0] + 120, before[1] + 40] }));
    await until(() => mockDiagrams.items.length === 1 && c.state.save === 'saved', 4000);
    const saved = mockDiagrams.items[0].layout;
    expect(saved.hidden).toEqual(['main.events']);
    expect(saved.scope).toEqual({ database: null, schema: 'main' });
    expect(saved.positions['main.orders']).toEqual([before[0] + 120, before[1] + 40]);
    expect(mock.hits('/er/layouts/' + saved.id, 'PUT').length).toBeGreaterThan(0);
    r.unmount();

    // a new view of the same scope restores the saved layout
    const r2 = render(<ErDiagramView tab={tab} theme="light" visible />);
    await until(() => activeController()?.state.phase === 'ready' && cards().length >= 6, 8000);
    expect(activeController()!.state.layoutId).toBe(saved.id);
    expect(activeController()!.state.positions['main.orders']).toEqual([before[0] + 120, before[1] + 40]);
    expect(screen.queryByRole('button', { name: /^Table events,/ })).toBeNull();
    r2.unmount();
  });

  it('keyboard-only walk: Tab through cards, Enter opens data, F4 designs', async () => {
    await mountReady();
    const canvas = screen.getByRole('application');
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Tab', code: 'Tab' });
    await until(() => (document.activeElement as HTMLElement | null)?.classList.contains('er-card') ?? false);
    const first = document.activeElement as HTMLElement;
    const order = activeController()!.order();
    expect(first.dataset.key).toBe(order[0]);
    fireEvent.keyDown(first, { key: 'Tab', code: 'Tab' });
    await until(() => (document.activeElement as HTMLElement).dataset.key === order[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', code: 'Tab', shiftKey: true });
    await until(() => (document.activeElement as HTMLElement).dataset.key === order[0]);
    // arrows move the focused card by 8 px
    const c = activeController()!;
    const p = c.state.positions[order[0]];
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(c.state.positions[order[0]]).toEqual([p[0] + 8, p[1]]);
    const key = order[0];
    const name = key.split('.')[1];
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', code: 'Enter' });
    await until(() => useTabs.getState().tabs.some((t) => t.kind === 'view' && t.view === 'data' && (t.state as { name?: string }).name === name));
    // back to the diagram, F4 opens the designer of the same table
    const erTab = useTabs.getState().tabs.find((t) => t.kind === 'view' && t.view === ER_VIEW)!;
    act(() => useTabs.getState().activate(erTab.id));
    const el = document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    el.focus();
    fireEvent.keyDown(el, { key: 'F4', code: 'F4' });
    await until(() => useTabs.getState().tabs.some((t) => t.kind === 'view' && t.view === 'designer.table'), 5000);
  });

  it('ghost-free shop + commands: FK creation is refused on SQLite with the reason; menus list the ER entries', async () => {
    await mountReady();
    const c = activeController()!;
    c.select(['main.orders']);
    c.store.setState({ focusKey: 'main.orders' });
    expect(getCommand('er.createFk')).toBeDefined();
    expect(runCommand('er.createFk')).toBe(false);
    const handle = card('orders').querySelector('[data-handle="customer_id"]')!;
    expect(handle.getAttribute('title')).toBe('SQLite cannot add a foreign key to an existing table');
    const ids = (m: string) => CONTEXT_MENUS[m].flatMap((e) => (typeof e === 'object' && 'command' in e ? [e.command] : []));
    expect(ids('explorer.table')).toContain('er.openRelated');
    expect(ids('explorer.container')).toContain('er.open');
    // show related / remove / add back
    act(() => c.remove(['main.customers']));
    expect(c.state.model!.byKey.has('main.customers')).toBe(false);
    act(() => c.showRelated('main.orders'));
    expect(c.state.model!.byKey.get('main.customers')?.ghost).toBe(false);
    // fit and zoom commands
    act(() => {
      runCommand('er.zoomReset');
    });
    expect(c.state.transform.k).toBe(1);
    act(() => {
      runCommand('er.zoomIn');
    });
    expect(c.state.transform.k).toBe(1.25);
    act(() => {
      runCommand('er.fit');
    });
    expect(c.state.transform.k).toBeLessThanOrEqual(1);
  });

  it('switching the scope schema loads another layout key', async () => {
    const tab = openTab();
    await mountReady(tab);
    const c = activeController()!;
    act(() => c.setScope({ database: null, tables: ['main.orders', 'main.customers'] }));
    await until(() => c.state.phase === 'ready' && c.state.model!.memberCount === 2, 5000);
    // the related ghosts of the two tables are drawn too
    expect(c.state.model!.nodes.filter((n) => n.ghost).map((n) => n.key).sort()).toEqual(['main.countries', 'main.events', 'main.order_lines']);
  });
});

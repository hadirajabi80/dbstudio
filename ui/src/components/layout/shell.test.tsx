// Shell behaviour of the B3 batch: view tabs hide themselves (features-05), danger confirmations default to Cancel and
// need an armed checkbox for read-only writes (design-02), WAI-ARIA menus (design-04), focus restore (design-03),
// the overflow toolbar fit (styles-03), the explorer chip scope (logic-10) and the tab strip (features-r1-05).
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatformForTests } from '../../commands/keys';
import type { ConnectionProfile } from '../../api/types';
import { useConnections } from '../../store/connections';
import { useTabs, type ConsoleTab, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { captureFocus, useRestoreFocus } from '../common/focus';
import { MenuHost, useMenu } from '../common/Menu';
import { ALL_CONNECTIONS, chipsFor, useExplorer } from '../Explorer/explorerStore';
import { fitItems, type OverflowItem } from './OverflowToolbar';
import { registerTabView, type TabViewProps } from './tabViews';
import { TabBar } from './TabBar';
import { ViewTabHost } from './ViewTabHost';

afterEach(() => setPlatformForTests(null));

/** A view that ignores `visible` (like the plan tab used to). */
function Careless({ tab }: TabViewProps) {
  return <div data-testid={`view-${tab.id}`}>content of {tab.title}</div>;
}

describe('ViewTabHost (features-05)', () => {
  it('only the active view tab is visible, even when the view ignores `visible`', () => {
    const off = registerTabView('careless', { component: Careless, icon: 'File' });
    const a = { id: 'va', kind: 'view', view: 'careless', title: 'A', state: null } as unknown as ViewTab;
    const b = { id: 'vb', kind: 'view', view: 'careless', title: 'B', state: null } as unknown as ViewTab;
    const { rerender } = render(
      <>
        <ViewTabHost tab={a} theme="light" visible />
        <ViewTabHost tab={b} theme="light" visible={false} />
      </>,
    );
    expect(screen.getByTestId('view-va')).toBeVisible();
    expect(screen.getByTestId('view-vb')).not.toBeVisible();
    rerender(
      <>
        <ViewTabHost tab={a} theme="light" visible={false} />
        <ViewTabHost tab={b} theme="light" visible />
      </>,
    );
    expect(screen.getByTestId('view-va')).not.toBeVisible();
    expect(screen.getByTestId('view-vb')).toBeVisible();
    off();
  });
});

describe('ConfirmDialog (design-02)', () => {
  beforeEach(() => useUi.setState({ confirm: null }));

  it('danger: Cancel has the focus, so Enter cancels', async () => {
    render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void useUi.getState().askConfirm({ title: 'Run destructive statement?', message: 'DELETE without WHERE', confirmLabel: 'Run anyway', danger: true }).then((r) => (result = r));
    });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await act(async () => {});
    expect(result).toBe(false);
  });

  it('read-only override: the danger button stays disabled until "Allow this statement…" is ticked', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);
    let result: { ok: boolean; ack: boolean } | null = null;
    act(() => {
      void useUi.getState().askConfirmAck({
        title: 'Read-only connection', message: 'refused', confirmLabel: 'Run with writes', danger: true,
        ack: { label: 'Allow this statement to write to “Prod copy”', required: true },
      }).then((r) => (result = r));
    });
    const run = await screen.findByRole('button', { name: 'Run with writes' });
    expect(run).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('checkbox', { name: /Allow this statement to write/ }));
    expect(run).toBeEnabled();
    await user.click(run);
    expect(result).toEqual({ ok: true, ack: true });
  });

  it('a required acknowledgement that was not ticked never confirms', async () => {
    let result: { ok: boolean; ack: boolean } | null = null;
    void useUi.getState().askConfirmAck({ title: 'x', message: 'y', danger: true, ack: { label: 'Allow', required: true } }).then((r) => (result = r));
    useUi.getState().resolveConfirm(true, false);
    await Promise.resolve();
    expect(result).toEqual({ ok: false, ack: false });
  });
});

describe('Menu (design-04)', () => {
  it('focuses the menu, tracks the active item with aria-activedescendant, opens submenus with ArrowRight and gives focus back on Esc', async () => {
    setPlatformForTests(false);
    const invoker = document.createElement('button');
    invoker.textContent = 'tree';
    document.body.appendChild(invoker);
    invoker.focus();
    render(<MenuHost />);
    let ran = '';
    act(() => {
      useMenu.getState().show(10, 10, [
        { id: 'a', label: 'Alpha', shortcut: 'Mod+C', onClick: () => (ran = 'a') },
        { id: 'off', label: 'Disabled', disabled: true },
        { id: 'copy', label: 'Copy as', submenu: [{ id: 'csv', label: 'CSV', onClick: () => (ran = 'csv') }, { id: 'json', label: 'JSON' }] },
      ], { fromKeyboard: true });
    });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveFocus();
    const first = screen.getByRole('menuitem', { name: /Alpha/ });
    expect(menu).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveTextContent('Ctrl+C');
    // ArrowDown skips the disabled item.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    const sub = screen.getByRole('menuitem', { name: /Copy as/ });
    expect(menu).toHaveAttribute('aria-activedescendant', sub.id);
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    const menus = screen.getAllByRole('menu');
    expect(menus).toHaveLength(2);
    expect(menus[1]).toHaveFocus();
    expect(menus[1]).toHaveAttribute('aria-activedescendant', screen.getByRole('menuitem', { name: 'CSV' }).id);
    fireEvent.keyDown(menus[1], { key: 'ArrowLeft' });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(menu).toHaveFocus();
    // Typeahead, then Esc restores the invoker.
    fireEvent.keyDown(menu, { key: 'a' });
    expect(menu).toHaveAttribute('aria-activedescendant', first.id);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(invoker).toHaveFocus();
    expect(ran).toBe('');
    invoker.remove();
  });

  it('shows ⌘ shortcuts on macOS', () => {
    setPlatformForTests(true);
    render(<MenuHost />);
    act(() => useMenu.getState().show(0, 0, [{ id: 'a', label: 'Copy', shortcut: 'Mod+C' }]));
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toHaveTextContent('⌘C');
    act(() => useMenu.getState().hide());
  });
});

describe('focus restore (design-03)', () => {
  function Overlay({ onMount }: { onMount?: () => void }) {
    useRestoreFocus(true);
    useEffect(() => onMount?.(), [onMount]);
    return <input aria-label="overlay input" autoFocus />;
  }

  it('gives focus back to the element focused before the overlay opened', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const { rerender } = render(<Overlay />);
    expect(screen.getByLabelText('overlay input')).toHaveFocus();
    rerender(<></>);
    await act(async () => {});
    expect(before).toHaveFocus();
    before.remove();
  });

  it('does not steal focus that an action moved elsewhere on purpose', () => {
    const a = document.createElement('button');
    const b = document.createElement('button');
    document.body.append(a, b);
    a.focus();
    const restore = captureFocus();
    b.focus();
    restore();
    expect(b).toHaveFocus();
    a.remove();
    b.remove();
  });
});

describe('OverflowToolbar fit (styles-03)', () => {
  const items: OverflowItem[] = [
    { id: 'run' }, { id: 'multi', priority: 3 }, { id: 'sep', separator: true }, { id: 'conn' },
    { id: 'explain', priority: 2 }, { id: 'code', priority: 1 }, { id: 'sp', spacer: true }, { id: 'rows', priority: 0 },
  ];
  const widths = new Map(Object.entries({ run: 60, multi: 70, conn: 160, explain: 80, code: 70, rows: 120 }));

  it('hides nothing when everything fits', () => {
    expect([...fitItems(items, widths, 2000, 4)]).toEqual([]);
  });

  it('collapses the lowest priorities first and never the unprioritised items', () => {
    expect([...fitItems(items, widths, 480, 4)]).toEqual(['rows', 'code']);
    expect([...fitItems(items, widths, 100, 4)].sort()).toEqual(['code', 'explain', 'multi', 'rows']);
  });
});

describe('explorer chips (logic-10)', () => {
  beforeEach(() => useExplorer.setState({ chips: { [ALL_CONNECTIONS]: [] }, chipScope: ALL_CONNECTIONS }));

  it('are global by default; selecting a node never moves the scope', () => {
    const ex = useExplorer.getState();
    ex.select('c:c_copy', { kind: 'connection', connectionId: 'c_copy' });
    ex.toggleChip('tables');
    const s = useExplorer.getState();
    expect(s.chipScope).toBe(ALL_CONNECTIONS);
    expect(chipsFor(s, 'c_shop')).toEqual(['tables']);
    expect(chipsFor(s, 'c_copy')).toEqual(['tables']);
  });

  it('a per-connection override is explicit and is dropped when that connection is deleted', () => {
    const ex = useExplorer.getState();
    ex.toggleChip('views');
    ex.scopeChipsTo('c_copy');
    ex.toggleChip('tables');
    let s = useExplorer.getState();
    expect(chipsFor(s, 'c_copy')).toEqual(['views', 'tables']);
    expect(chipsFor(s, 'c_shop')).toEqual(['views']);
    ex.forgetConnection('c_copy');
    s = useExplorer.getState();
    expect(s.chipScope).toBe(ALL_CONNECTIONS);
    expect(chipsFor(s, 'c_shop')).toEqual(['views']);
  });
});

describe('tabs focus request (design-15)', () => {
  it('opening a tab asks the shell to focus its primary element', () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [], focusRequest: null });
    const id = useTabs.getState().openView({ view: 'careless', title: 'X', key: 'x' });
    expect(useTabs.getState().focusRequest?.tabId).toBe(id);
    const seq = useTabs.getState().focusRequest!.seq;
    // Re-opening the same keyed view focuses it again.
    useTabs.getState().openView({ view: 'careless', title: 'X', key: 'x' });
    expect(useTabs.getState().focusRequest!.seq).toBeGreaterThan(seq);
  });
});

describe('tab strip (features-r1-05)', () => {
  const tab = (id: string, connectionId: string | null): ConsoleTab => ({
    kind: 'console', id, title: `Console ${id}`, connectionId, database: null, text: '', savedText: '', filePath: null, txMode: 'auto', maxRows: null,
  });
  const conn = (id: string, name: string) => ({ id, name, providerId: 'sqlite', color: 'blue', readOnly: false }) as unknown as ConnectionProfile;

  beforeEach(() => {
    useConnections.setState({ connections: [conn('c1', 'Shop'), conn('c2', 'Prod')], loaded: true, error: null });
  });

  it('omits the connection suffix while every tab is on one connection (the colour bar names it)', () => {
    useTabs.setState({ tabs: [tab('1', 'c1'), tab('2', 'c1'), tab('3', null)], activeId: '1', mru: [], closed: [] });
    const { container } = render(<TabBar />);
    expect(container.querySelectorAll('.tab')).toHaveLength(3);
    expect(container.querySelectorAll('.tab-conn')).toHaveLength(0);
    // the connection is still named in the tooltip
    expect(container.querySelector('.tab')!.getAttribute('title')).toMatch(/Shop/);
  });

  it('shows the suffix once tabs of two connections are open, next to the title in one clipped label', () => {
    useTabs.setState({ tabs: [tab('1', 'c1'), tab('2', 'c2')], activeId: '1', mru: [], closed: [] });
    const { container } = render(<TabBar />);
    expect([...container.querySelectorAll('.tab-conn')].map((n) => n.textContent)).toEqual(['Shop', 'Prod']);
    for (const label of container.querySelectorAll('.tab-label')) {
      expect([...label.children].map((c) => c.className)).toEqual(['tab-title', 'tab-conn']);
    }
  });

  it('gives the title priority: tabs scroll at 120 px, the name shrinks first and wraps out of sight', async () => {
    // Node API, typed locally (the app tsconfig has no Node types; vitest runs on Node)
    const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(p: string, e: 'utf8'): string };
    const css = fs.readFileSync(`${(globalThis as unknown as { process: { cwd(): string } }).process.cwd()}/src/theme/app.css`, 'utf8');
    const rule = (sel: string) => new RegExp(`(?:^|\n)${sel.replace(/[.]/g, '\.')} \{([^}]*)\}`).exec(css)?.[1] ?? '';
    expect(rule('.tab')).toMatch(/min-width: 120px;/);
    expect(rule('.tab-title')).toMatch(/flex: 1 1 auto;[\s\S]*min-width: 6ch;/);
    expect(rule('.tab-conn')).toMatch(/flex: 0 10 auto;/);
    expect(rule('.tab-label')).toMatch(/flex-wrap: wrap;[\s\S]*overflow: hidden;/);
  });
});

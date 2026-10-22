// Data tab: primary focus after opening (design-15), no discard prompt for edits that do not reload (design-r1-02),
// and keyless paging order (features-r1-04). The canvas grid is replaced by a probe.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { CellValue, ColumnInfo, ColumnKind, ObjectDetails } from '../../api/types';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { useTabs, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import type { DataGridProps } from '../Grid/DataGrid';
import { useTabFocusRequests, ViewTabHost } from '../layout/ViewTabHost';
import { registerGridCommands } from './commands';
import { DataTabView } from './DataTabView';
import { dataGridKey, openDataTab } from './open';
import { setSqlRunner, type QueryOutcome } from './runner';

let gridProps: DataGridProps | null = null;
vi.mock('../Grid/DataGrid', async () => {
  const React = await import('react');
  const { registerGridController } = await import('../Grid/controller');
  return {
    DataGrid: (p: DataGridProps) => {
      gridProps = p;
      const ref = React.useRef<HTMLCanvasElement>(null);
      React.useEffect(
        () =>
          registerGridController({
            key: p.gridKey, editable: true, openFilter: () => undefined, quickFilterCell: () => undefined, clearFilter: () => undefined,
            focus: () => {
              ref.current?.focus();
              return document.activeElement === ref.current;
            },
          }),
        [p.gridKey], // eslint-disable-line react-hooks/exhaustive-deps
      );
      return React.createElement('div', { className: 'grid-host', 'data-command-scope': 'grid' },
        React.createElement('canvas', { 'data-testid': 'data-grid-canvas', tabIndex: 0, ref }));
    },
    rowValue: () => null,
  };
});

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number, isKey = false): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey,
});
const KEYED = [col('id', 'int', 0, true), col('name', 'string', 1)];
const KEYLESS = [col('id', 'int', 0), col('name', 'string', 1), col('email', 'string', 2)];

let columns = KEYED;
let total = 50;
let pageDelay = 0;
const calls: string[] = [];

function outcome(cols: ColumnInfo[], rows: CellValue[][]): QueryOutcome {
  return { executionId: 'x', status: 'ok', resultSets: [{ columns: cols, rows, truncated: false }], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 1, txOpen: false };
}

const tabState = (id: string, type: 'table' | 'view' = 'table'): ViewTab => ({
  kind: 'view', id, title: 'customers', view: 'data', connectionId: 'c_shop', database: null, state: { schema: 'main', name: 'customers', type },
});

beforeAll(async () => {
  registerGridCommands();
  await useConnections.getState().load();
  setSqlRunner(async (_sid, sql) => {
    calls.push(sql);
    if (sql.includes('WHERE 1 = 0')) return outcome(columns, []);
    if (sql.startsWith('SELECT COUNT(*)')) return outcome([col('row_count', 'int', 0)], [[total]]);
    if (pageDelay) await new Promise((r) => setTimeout(r, pageDelay));
    const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
    const [limit, offset] = [Number(m[1]), Number(m[2])];
    const rows: CellValue[][] = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) rows.push([i + 1, `name ${i + 1}`, `u${i + 1}@x.test`].slice(0, columns.length));
    return outcome(columns, rows);
  });
});
afterAll(() => setSqlRunner(null));
beforeEach(() => {
  // A previous test's Shell must not survive into the next one, and neither may its tabs: a stale Data tab would be
  // mounted again by the next <Shell/> and render a second grid canvas next to the new one (code-r2-01).
  cleanup();
  useTabs.setState({ tabs: [], activeId: null, mru: [], closed: [], focusRequest: null });
  calls.length = 0;
  gridProps = null;
  columns = KEYED;
  total = 50;
  pageDelay = 0;
  useSessions.setState({ sessions: {}, byTab: {} });
});
afterEach(() => vi.restoreAllMocks());

/** The DOM container of the visible view tab: a hidden tab can neither break a query nor satisfy it. */
function activeHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('[data-tab-host]:not([aria-hidden="true"])');
  if (!host) throw new Error('no visible view tab host');
  return host;
}

/** The shell around the workspace tabs: focus requests + view hosts, and an explorer-like tree that had focus. */
function Shell() {
  useTabFocusRequests();
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.activeId);
  return (
    <>
      <div role="tree" tabIndex={0} aria-label="Explorer" />
      {tabs.map((t) => (t.kind === 'view' ? <ViewTabHost key={t.id} tab={t} theme="light" visible={t.id === active} /> : null))}
    </>
  );
}

describe('Data tab primary focus (design-15)', () => {
  it('opening from the explorer focuses the grid canvas once the first page arrives, never the search box', async () => {
    pageDelay = 1200; // longer than the shell's own retries
    render(<Shell />);
    const tree = screen.getByRole('tree');
    tree.focus();
    const focused: string[] = [];
    const onFocusIn = (e: FocusEvent) => focused.push((e.target as HTMLElement).getAttribute('aria-label') ?? (e.target as HTMLElement).tagName);
    document.addEventListener('focusin', onFocusIn);
    try {
      act(() => {
        openDataTab({ connectionId: 'c_shop', database: null, schema: 'main', name: 'customers', type: 'table' });
      });
      await until(() => document.activeElement?.tagName === 'CANVAS', 5000);
      expect(document.activeElement).toBe(within(activeHost()).getByTestId('data-grid-canvas'));
      expect(focused).not.toContain('Search text columns');
    } finally {
      document.removeEventListener('focusin', onFocusIn);
    }
  });

  it('the user moving focus while the rows load cancels the request', async () => {
    pageDelay = 300;
    render(<Shell />);
    screen.getByRole('tree').focus();
    act(() => {
      openDataTab({ connectionId: 'c_shop', database: null, schema: 'main', name: 'orders', type: 'table' });
    });
    const host = activeHost();
    expect(host.getAttribute('data-tab-host')).toBe(useTabs.getState().activeId);
    expect(document.querySelectorAll('[data-tab-host]')).toHaveLength(1);
    const search = await within(host).findByRole('textbox', { name: 'Search text columns' });
    search.focus();
    await within(host).findByTestId('data-grid-canvas');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(document.activeElement).toBe(search);
  });
});

// What a complete condition does with pending edits (deferred behind a Save / Discard notice, design-r2-01) is
// covered in dataTabFilterDraft.test.tsx.
describe('Data tab pending edits and the filter bar (design-r1-02)', () => {
  it('adding an empty (draft) condition does not ask to discard', async () => {
    const ask = vi.fn(async () => false);
    const orig = useUi.getState().askConfirm;
    useUi.setState({ askConfirm: ask });
    try {
      const tab = tabState('dt-guard');
      render(<DataTabView tab={tab} theme="light" visible />);
      await until(() => gridProps?.rows.length === 50);
      act(() => useEdits.getState().setCell(dataGridKey(tab.id), 0, 1, 'changed', 'name 1'));
      fireEvent.click(screen.getByRole('button', { name: /^Add condition/ }));
      await screen.findByRole('group', { name: /Condition on/ });
      expect(ask).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(Object.keys(useEdits.getState().get(dataGridKey(tab.id)).pending.updates)).toHaveLength(1);
    } finally {
      useUi.setState({ askConfirm: orig });
    }
  });
});

// A small keyless object is now counted before its first page and ordered from page 1 (features-r2-02): see
// dataTabKeyless.test.tsx.
describe('keyless paging order (features-r1-04)', () => {
  const pages = () => calls.filter((c) => c.includes('LIMIT'));
  // The mock catalog knows customers' primary key, and a data tab loads its table's schema: these cases are about an
  // object whose key is unknown, so no catalog is available.
  beforeEach(() => {
    useCatalog.setState({ dbs: {} });
    vi.spyOn(api, 'catalog').mockRejectedValue(new Error('catalog unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('a large keyless object pages unordered and says so', async () => {
    columns = KEYLESS;
    total = 600_000;
    render(<DataTabView tab={tabState('dt-big', 'view')} theme="light" visible />);
    await screen.findByText(/1,000 of 600,000 rows/);
    expect(screen.getByText('No key column: rows beyond the first page may repeat or be skipped')).toBeInTheDocument();
    await act(async () => {
      gridProps!.onReachEnd!();
    });
    await until(() => gridProps!.rows.length === 2000);
    expect(pages().at(-1)).toBe('SELECT *\nFROM customers\nLIMIT 1000 OFFSET 1000');
  });

  it('a table without a primary key orders by a unique index from the catalog', async () => {
    columns = KEYLESS;
    total = 2500;
    const details = { indexes: [{ name: 'ix_name', unique: false, columns: ['name'], type: null, isPrimaryKey: false }, { name: 'ux_email', unique: true, columns: ['email'], type: null, isPrimaryKey: false }] } as unknown as ObjectDetails;
    const spy = vi.spyOn(api, 'objectDetails').mockResolvedValue(details);
    render(<DataTabView tab={tabState('dt-ux')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pages()[0]).toBe('SELECT *\nFROM customers\nORDER BY email\nLIMIT 1000 OFFSET 0');
    await act(async () => {
      gridProps!.onReachEnd!();
    });
    await until(() => gridProps!.rows.length === 2000);
    expect(pages().at(-1)).toBe('SELECT *\nFROM customers\nORDER BY email\nLIMIT 1000 OFFSET 1000');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

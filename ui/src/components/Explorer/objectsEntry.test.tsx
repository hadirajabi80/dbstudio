// WP3: Enter / double-click on a database, schema or type folder shows its Objects tab (and expands the node);
// the container context menu offers "Show objects".
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../../commands';
import { contextMenu } from '../layout/commandMenu';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import type { ObjectsState } from '../ObjectList/open';
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

const objectsTabs = () => useTabs.getState().tabs.filter((t): t is ViewTab => t.kind === 'view' && t.view === 'objects');

describe('Explorer → Objects tab', () => {
  beforeAll(async () => {
    await initCommands();
  });
  beforeEach(async () => {
    mock.reset();
    localStorage.clear();
    useExplorer.setState({ expanded: new Set(), collapsedFolders: new Set(), filter: '', selected: null });
    useCatalog.setState({ conns: {}, dbs: {} });
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    useTabs.setState({ tabs: [], activeId: null, seq: 0 });
    await useConnections.getState().load();
  });

  it('double-click on a schema and Enter on a type folder open the Objects tab for that scope', async () => {
    render(<Explorer />);
    await expand('Prod SQL');
    await expand('Shop');
    await waitFor(() => expect(row('dbo')).toBeDefined(), { timeout: 8000 });
    fireEvent.doubleClick(row('dbo')!);
    await waitFor(() => expect(objectsTabs()).toHaveLength(1), { timeout: 8000 });
    const st = objectsTabs()[0].state as ObjectsState;
    expect(st).toMatchObject({ connectionId: 'c_prod', database: 'Shop', schema: 'dbo', group: 'all' });
    expect(objectsTabs()[0].title).toBe('Objects: Shop.dbo');
    await waitFor(() => expect(row('Procedures')).toBeDefined(), { timeout: 8000 }); // the schema is expanded

    fireEvent.mouseDown(row('Procedures')!);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' });
    await waitFor(() => expect((objectsTabs()[0].state as ObjectsState).group).toBe('proc'), { timeout: 8000 });
    expect(objectsTabs()).toHaveLength(1); // same scope, same tab
  });

  it('the container menu starts with "Show objects"', () => {
    const items = contextMenu('explorer.container', { kind: 'container', connectionId: 'c_shop', database: null, schema: 'main' });
    expect(items[0].label).toBe('Show objects');
  });
});

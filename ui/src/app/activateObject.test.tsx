// "Open procedures and functions in edit mode" (Settings ▸ Editor, off by default): the default open of a routine
// (explorer double-click / Enter, Ctrl+P Enter) goes to its F4 "Edit:" console when on, to the read-only object tab
// when off. Explicit commands (Edit / F4, Open DDL) ignore the setting.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../commands';
import { runCommand } from '../commands/registry';
import { runObjectHit } from '../components/CommandPalette/CommandPalette';
import { Explorer, useExplorer } from '../components/Explorer/Explorer';
import { peekEditSession } from '../designer/editSession';
import { useDesignerUi } from '../designer/store';
import { useCatalog } from '../store/catalog';
import { useConnections } from '../store/connections';
import { DEFAULT_SETTINGS, OPEN_ROUTINES_IN_EDIT_KEY, openRoutinesInEditMode, useSettings } from '../store/settings';
import { useTabs } from '../store/tabs';
import { installMockEngine } from '../test/mockServer';
import { activateObject } from './actions';

installMockEngine({ frameDelay: 0 });
beforeAll(() => initCommands(), 60_000);

const proc = { database: 'Shop', schema: 'dbo', name: 'GetCustomer', type: 'proc' as const };
const target = { kind: 'object' as const, connectionId: 'c_prod', database: 'Shop', ref: proc };

function setEditMode(on: boolean) {
  const s = useSettings.getState().settings;
  useSettings.setState({ settings: { ...s, ui: { ...s.ui, [OPEN_ROUTINES_IN_EDIT_KEY]: on } } });
}

const active = () => useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId);

async function opened(): Promise<'edit' | 'object'> {
  return waitFor(() => {
    const t = active();
    if (t?.kind === 'object') return 'object' as const;
    if (t?.kind === 'console' && peekEditSession(t.id)) return 'edit' as const;
    throw new Error('nothing opened yet');
  });
}

beforeEach(async () => {
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
  useDesignerUi.setState({ edits: {} });
  setEditMode(false);
  await useConnections.getState().load();
});

describe('Open procedures and functions in edit mode', () => {
  it('is off by default', () => {
    expect(openRoutinesInEditMode(DEFAULT_SETTINGS)).toBe(false);
  });

  it('off: opening a routine shows the read-only object tab', async () => {
    activateObject('c_prod', 'Shop', proc);
    expect(await opened()).toBe('object');
  });

  it('on: opening a routine goes to its "Edit:" console; opening it again reuses that console', async () => {
    setEditMode(true);
    activateObject('c_prod', 'Shop', proc);
    expect(await opened()).toBe('edit');
    expect(active()?.title).toBe('Edit: GetCustomer');
    const first = active()!.id;
    activateObject('c_prod', 'Shop', proc);
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'console')).toHaveLength(1);
    expect(active()!.id).toBe(first);
  });

  it('on: tables and views still open as before; a column of a routine never edits', async () => {
    setEditMode(true);
    activateObject('c_prod', 'Shop', { ...proc, name: 'customers', type: 'table' });
    expect(await opened()).toBe('object');
  });

  it('on: Ctrl+P Enter on a routine edits it', async () => {
    setEditMode(true);
    runObjectHit({ connectionId: 'c_prod', database: 'Shop', ref: proc, name: 'GetCustomer' } as Parameters<typeof runObjectHit>[0], 'open');
    expect(await opened()).toBe('edit');
  });

  it('explicit commands ignore the setting: Open DDL stays read-only when on, Edit (F4) edits when off', async () => {
    setEditMode(true);
    await runCommand('explorer.openDdl', target);
    expect(await opened()).toBe('object');

    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    setEditMode(false);
    await runCommand('designer.edit', target);
    expect(await opened()).toBe('edit');
  });

  it('explorer double-click follows the setting', async () => {
    useExplorer.setState({ expanded: new Set(), collapsedFolders: new Set(), filter: '', selected: null });
    useCatalog.setState({ conns: {}, dbs: {} });
    setEditMode(true);
    render(<Explorer />);
    const row = (label: string) => screen.getAllByRole('treeitem').find((el) => el.querySelector('.tree-label')?.textContent === label);
    const expand = async (label: string) => fireEvent.click((await waitFor(() => row(label) ?? Promise.reject(new Error(label))))!.querySelector('.tree-twisty')!);
    await expand('Prod SQL');
    await expand('Shop');
    await expand('dbo');
    await expand('Procedures');
    const r = await waitFor(() => row('GetCustomer') ?? Promise.reject(new Error('GetCustomer')));
    fireEvent.doubleClick(r);
    expect(await opened()).toBe('edit');
  });
});

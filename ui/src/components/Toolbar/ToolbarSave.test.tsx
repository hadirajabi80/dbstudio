// The console toolbar's Save button for F4 "Edit:" consoles (Ctrl+S saves the object to the database): shown only in
// edit consoles, a dot when the editor text differs from what is saved, runs file.save, dimmed while a save runs.
// In an "Edit:" console of a procedure or function, Run becomes "Execute…" with a menu (Run script, Save).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommands } from '../../commands';
import { getCommand } from '../../commands/registry';
import { useDesignerUi } from '../../designer/store';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution } from '../../store/resultsReducer';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import { displayShortcut } from '../../commands/keys';
import { MenuHost } from '../common/Menu';
import { Toolbar } from './Toolbar';

installMockEngine({ frameDelay: 0 });
beforeAll(() => initCommands(), 60_000);

const SCRIPT = 'CREATE OR ALTER PROCEDURE dbo.GetCustomer @Id int AS SELECT 1';
const ref = { database: null, schema: 'dbo', name: 'GetCustomer', type: 'proc' as const };
const base: ConsoleTab = {
  kind: 'console', id: 't1', title: 'Console 1', connectionId: 'c_prod', database: null, text: 'SELECT 1', savedText: '', filePath: null, txMode: 'auto', maxRows: null,
};

function show(tab: ConsoleTab, edit: boolean, type: 'proc' | 'view' = 'proc') {
  useTabs.setState({ tabs: [tab], activeId: tab.id, mru: [], closed: [] });
  useDesignerUi.setState({ edits: edit ? { [tab.id]: { connectionId: 'c_prod', database: null, ref: { ...ref, type }, serverDdl: SCRIPT, dialect: 'tsql', savedText: SCRIPT } } : {}, editRunInFlight: {} });
  return render(<Toolbar tab={tab} />);
}

const saveBtn = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-command="file.save"]');

describe('toolbar Save button', () => {
  beforeEach(async () => {
    await useConnections.getState().load();
    useResults.setState({ executions: {}, byTab: {} });
  });

  it('is not shown in an ordinary console', () => {
    const { container } = show(base, false);
    expect(saveBtn(container)).toBeNull();
    expect(container.querySelector('[data-command="run.statement"]')).not.toBeNull();
  });

  it('is shown in an edit console, says what it saves with the platform shortcut, and runs file.save', () => {
    const tab = { ...base, title: 'Edit: GetCustomer', text: SCRIPT };
    const { container } = show(tab, true);
    const b = saveBtn(container)!;
    expect(b).not.toBeNull();
    expect(b.title).toBe(`Save procedure GetCustomer to the database (${displayShortcut('Mod+S')})`);
    expect(b).not.toHaveAttribute('data-dirty');
    const cmd = getCommand('file.save')!;
    const run = cmd.run;
    const spy = vi.fn();
    cmd.run = spy;
    try {
      fireEvent.click(b);
    } finally {
      cmd.run = run;
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows an unsaved-changes dot while the text differs from what is saved, and clears it after a save', () => {
    const tab = { ...base, title: 'Edit: GetCustomer', text: `${SCRIPT}\n-- changed` };
    const { container, rerender } = show(tab, true);
    expect(saveBtn(container)).toHaveAttribute('data-dirty', 'true');
    expect(saveBtn(container)!.querySelector('.tb-dirty-dot')).not.toBeNull();
    expect(saveBtn(container)).toHaveAccessibleName('Save, unsaved changes');
    // a successful save refreshes the session's baseline
    act(() => useDesignerUi.getState().registerEdit(tab.id, { ...useDesignerUi.getState().edits[tab.id], savedText: tab.text }));
    rerender(<Toolbar tab={tab} />);
    expect(saveBtn(container)).not.toHaveAttribute('data-dirty');
  });

  it('is disabled while a save (or any run) is running in the console', () => {
    const tab = { ...base, title: 'Edit: GetCustomer', text: SCRIPT };
    const e = createExecution({ localId: 'l1', tabId: tab.id, connectionId: 'c_prod', sessionId: null, label: 'script', batches: [], maxRows: 500 });
    useResults.setState({ executions: { l1: { ...e, status: 'running' } }, byTab: { [tab.id]: 'l1' } });
    const { container } = show(tab, true);
    expect(saveBtn(container)).toBeDisabled();
  });

  it('a routine edit console turns Run into Execute… with a menu; a view edit console keeps Run', () => {
    const tab = { ...base, title: 'Edit: GetCustomer', text: SCRIPT };
    const { container, unmount } = show(tab, true);
    const exec = container.querySelector<HTMLButtonElement>('[data-command="routine.execute"]')!;
    expect(exec.textContent).toContain('Execute…');
    expect(exec.title).toBe(`Execute procedure GetCustomer with parameters (${displayShortcut('Mod+Enter')} or ${displayShortcut('F5')}) — production connection`);
    expect(container.querySelector('[data-command="run.statement"]')).toBeNull();
    render(<MenuHost />);
    fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
    expect(screen.getByRole('menuitem', { name: /Execute procedure GetCustomer…/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Run the edit script as SQL/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Save procedure to the database/ })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    unmount();

    const { container: c2 } = show({ ...tab, title: 'Edit: v' }, true, 'view');
    expect(c2.querySelector('[data-command="run.statement"]')).not.toBeNull();
    expect(saveBtn(c2)!.title).toMatch(/^Save view GetCustomer to the database/);
  });
});

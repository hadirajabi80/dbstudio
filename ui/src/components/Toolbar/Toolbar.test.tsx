// features-r1-06: while an "Edit:" console applies its change in one transaction (designer/editRun.ts) the run cannot
// be cancelled, so the toolbar's Stop button is dimmed (aria-disabled, not red) and its tooltip says why.
import { act, render } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../../commands';
import { EDIT_RUN_STOP_REASON, useDesignerUi } from '../../designer/store';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution } from '../../store/resultsReducer';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { installMockEngine } from '../../test/mockServer';
import { Toolbar } from './Toolbar';

installMockEngine({ frameDelay: 0 });
beforeAll(() => initCommands(), 60_000);

const tab: ConsoleTab = {
  kind: 'console', id: 't_edit', title: 'Edit: TR_OrderLines_Insert', connectionId: 'c_shop', database: null, text: 'CREATE TRIGGER …',
  savedText: '', filePath: null, txMode: 'auto', maxRows: null,
};

describe('Stop during an atomic edit-run (features-r1-06)', () => {
  beforeEach(async () => {
    await useConnections.getState().load();
    useTabs.setState({ tabs: [tab], activeId: tab.id, mru: [], closed: [] });
    const e = createExecution({ localId: 'l1', tabId: tab.id, connectionId: 'c_shop', sessionId: null, label: 'script', batches: [], maxRows: 500 });
    useResults.setState({ executions: { l1: { ...e, status: 'running' } }, byTab: { [tab.id]: 'l1' } });
    useDesignerUi.getState().setEditRunInFlight(tab.id, false);
  });

  it('a normal run shows the red Stop button; an edit-run dims it and explains why', () => {
    const { container } = render(<Toolbar tab={tab} />);
    const stop = () => container.querySelector<HTMLButtonElement>('[data-command="run.cancel"]')!;
    expect(stop()).toHaveClass('danger');
    expect(stop()).not.toHaveAttribute('aria-disabled');

    act(() => useDesignerUi.getState().setEditRunInFlight(tab.id, true));
    expect(stop()).not.toHaveClass('danger');
    expect(stop()).toHaveAttribute('aria-disabled', 'true');
    expect(stop().title).toBe(`Cancel running query: ${EDIT_RUN_STOP_REASON}`);

    act(() => useDesignerUi.getState().setEditRunInFlight(tab.id, false));
    expect(stop()).toHaveClass('danger');
    expect(stop()).not.toHaveAttribute('aria-disabled');
  });
});

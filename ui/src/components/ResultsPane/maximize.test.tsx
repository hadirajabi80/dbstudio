// The results-tab strip of a console has a visible Maximize / Restore toggle (view.maximizeResults, Mod+Shift+R).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../../commands';
import { useResults } from '../../store/results';
import { createExecution } from '../../store/resultsReducer';
import { useUi } from '../../store/ui';
import { ResultsPane } from './ResultsPane';

beforeAll(async () => {
  await initCommands();
});

beforeEach(() => {
  useUi.setState({ resultsMaximized: false, resultsVisible: true });
  act(() => {
    useResults.getState().clearTab('t-max');
    useResults.getState().begin(createExecution({
      localId: 'lmax', tabId: 't-max', connectionId: 'c_shop', sessionId: null, label: 'statement', batches: [{ sql: 'SELECT 1', line: 1, col: 1 }], maxRows: 100,
    }));
  });
});

describe('results maximize toggle', () => {
  it('maximizes and restores the results of a console', () => {
    render(<ResultsPane tabId="t-max" dialect="sqlite" theme="light" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Maximize results' }));
    expect(useUi.getState().resultsMaximized).toBe(true);
    const restore = screen.getByRole('button', { name: 'Restore results' });
    expect(restore).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(restore);
    expect(useUi.getState().resultsMaximized).toBe(false);
  });

  it('is not shown where the pane cannot be hidden (multi-run, result pages)', () => {
    render(<ResultsPane tabId="t-max" dialect="sqlite" theme="light" />);
    expect(screen.queryByRole('button', { name: 'Maximize results' })).toBeNull();
  });
});

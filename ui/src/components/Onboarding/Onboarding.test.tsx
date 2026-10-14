// Onboarding (section 3): first launch with no connections, provider cards, "Try the sample database".
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useConnections } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { useMockEngine } from '../../test/mockServer';
import { Welcome } from './Welcome';

const mock = useMockEngine();

describe('onboarding', () => {
  beforeEach(async () => {
    mock.reset();
    mock.ctx.engine.connections = [];
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    useUi.setState({ connectionDialog: null });
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    await useConnections.getState().load();
  });

  it('shows the first-launch welcome with provider cards (no modal)', async () => {
    const user = userEvent.setup();
    render(<Welcome ready />);
    expect(screen.getByRole('heading', { name: 'Connect to a database' })).toBeInTheDocument();
    for (const p of ['SQL Server', 'Oracle', 'SQLite']) expect(screen.getByRole('button', { name: new RegExp(`^${p}`) })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Oracle/ }));
    expect(useUi.getState().connectionDialog).toEqual({ mode: 'new', providerId: 'oracle', connectAfter: true });
  });

  it('“Try the sample database” creates it (POST /sample-db) and opens a console with a runnable query', async () => {
    const user = userEvent.setup();
    render(<Welcome ready />);
    await user.click(screen.getByRole('button', { name: /Try the sample database/ }));
    await waitFor(() => expect(useTabs.getState().tabs).toHaveLength(1));
    expect(mock.hits('/sample-db', 'POST')).toHaveLength(1);
    const tab = useTabs.getState().tabs[0];
    expect(tab.kind).toBe('console');
    expect(tab.title).toBe('Sample: Shop');
    expect(tab.connectionId).toBe(useConnections.getState().connections.find((c) => c.name === 'Sample: Shop')?.id);
    expect(tab.kind === 'console' && /SELECT[\s\S]+FROM Customers/i.test(tab.text)).toBe(true);
  });
});

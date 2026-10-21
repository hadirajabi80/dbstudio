// M2-L: the Connections panel offers "Activity" per connection (the Logs & activity tab on its Activity view).
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile, SourceClientInfo } from '../../api/types';
import { getCommand, registerCommand } from '../../commands/registry';
import { useConnections } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useSourceClients } from '../../store/sourceClients';
import { ConnectionsPanel } from './ConnectionsPanel';

const profile = (id: string, name: string, providerId: string): ConnectionProfile =>
  ({ id, name, providerId, props: {}, color: null, folder: null, readOnly: false }) as unknown as ConnectionProfile;
const client = (connectionId: string): SourceClientInfo =>
  ({ connectionId, state: 'open', server: null, openedAt: '2026-10-20T10:00:00Z', lastUsed: '2026-10-20T10:00:00Z' });

describe('ConnectionsPanel Activity button', () => {
  const run = vi.fn();
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    run.mockReset();
    // The real view.logs (components/Logs/commands.ts) opens the tab; here only its arguments matter.
    if (!getCommand('view.logs')) dispose = registerCommand({ id: 'view.logs', title: 'Logs & activity', category: 'View', run });
    useSessions.setState({ sessions: {}, byTab: {}, refreshAll: async () => {} } as never);
    useConnections.setState({ connections: [profile('c_redis', 'Cache', 'redis'), profile('c_lite', 'Local file', 'sqlite')] } as never);
    useSourceClients.setState({ clients: { c_redis: client('c_redis'), c_lite: client('c_lite') }, loaded: true, refresh: async () => {} } as never);
  });
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('opens the Activity view of the connection; SQLite (no activity) has none', () => {
    render(<ConnectionsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Activity of Cache' }));
    expect(run).toHaveBeenCalledWith({ connectionId: 'c_redis', sub: 'activity' });
    expect(screen.queryByRole('button', { name: 'Activity of Local file' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect Local file' })).toBeInTheDocument();
  });
});

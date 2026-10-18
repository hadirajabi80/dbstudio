// logic-r1-02: deleting a connection forwards `force` to the engine (DELETE /connections/{id}?force=true), so the user
// who confirmed "Roll back and delete" never gets a 409 TX_OPEN from a session the UI could not close first.
import { beforeEach, describe, expect, it } from 'vitest';
import { installMockEngine } from '../test/mockServer';
import { useConnections } from './connections';

const mock = installMockEngine();

describe('connections store: remove()', () => {
  beforeEach(async () => {
    mock.reset();
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    await useConnections.getState().load();
  });

  it('sends force=true when asked and drops the connection from the list', async () => {
    const [victim] = useConnections.getState().connections;
    expect(victim).toBeDefined();
    await useConnections.getState().remove(victim.id, { force: true });
    const [req] = mock.hits(`/connections/${encodeURIComponent(victim.id)}`, 'DELETE');
    expect(req, 'DELETE request sent').toBeDefined();
    expect(req.url.searchParams.get('force')).toBe('true');
    expect(useConnections.getState().connections.some((c) => c.id === victim.id)).toBe(false);
  });

  it('sends no force flag by default', async () => {
    const [victim] = useConnections.getState().connections;
    await useConnections.getState().remove(victim.id);
    const [req] = mock.hits(`/connections/${encodeURIComponent(victim.id)}`, 'DELETE');
    expect(req).toBeDefined();
    expect(req.url.searchParams.has('force')).toBe(false);
  });
});

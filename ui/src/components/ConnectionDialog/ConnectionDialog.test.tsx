import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnections } from '../../store/connections';
import { useMockEngine } from '../../test/mockServer';
import { CONNECTION_PALETTE } from '../../theme/connColors';
import { ConnectionDialog } from './ConnectionDialog';

const mock = useMockEngine();

async function loadStores() {
  useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
  await useConnections.getState().load();
}

describe('ConnectionDialog', () => {
  beforeEach(async () => {
    mock.reset();
    await loadStores();
  });

  it('renders the provider form spec and honours visibleWhen', async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlserver' }} onClose={() => {}} />);
    expect(screen.getByLabelText(/^Server/)).toBeInTheDocument();
    expect(screen.getByLabelText('User')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Authentication'), 'windows');
    expect(screen.queryByLabelText('User')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    // bool field rendered as a checkbox with its label, default from the spec
    expect(screen.getByRole('checkbox', { name: 'Trust server certificate' })).toBeChecked();
  });

  it('switches provider and shows that provider’s fields', async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlserver' }} onClose={() => {}} />);
    await user.click(screen.getByRole('option', { name: /SQLite/ }));
    expect(screen.getByLabelText(/Database file/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Server/)).not.toBeInTheDocument();
  });

  it('tests the connection and shows server info', async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlserver' }} onClose={() => {}} />);
    await user.type(screen.getByLabelText(/^Server/), 'sql-dev-02');
    await user.type(screen.getByLabelText('User'), 'sa');
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    const status = await screen.findByRole('status');
    expect(within(status).getByText(/Connected in \d+ ms/)).toBeInTheDocument();
    expect(within(status).getByText(/Microsoft SQL Server 2022/)).toBeInTheDocument();
    expect(within(status).getByText('sql-dev-02')).toBeInTheDocument();
    expect(mock.hits('/connections/test', 'POST')).toHaveLength(1);
  });

  it('shows the provider error when the test fails', async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlserver' }} onClose={() => {}} />);
    await user.type(screen.getByLabelText(/^Server/), 'nowhere');
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Connection failed.*host not found/);
  });

  it('validates required fields and saves a new connection with color, folder and read-only', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlite' }} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Database file is required')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Database file/), 'C:\\data\\inventory.db');
    // name is suggested from the file name
    expect(screen.getByLabelText('Name')).toHaveValue('inventory');
    await user.click(screen.getByRole('radio', { name: 'Blue' }));
    await user.type(screen.getByLabelText('Folder'), 'Local');
    await user.click(screen.getByRole('checkbox', { name: /Read-only/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = mock.ctx.engine.connections.find((c) => c.name === 'inventory');
    expect(saved).toMatchObject({ providerId: 'sqlite', color: CONNECTION_PALETTE.find((p) => p.id === 'blue')!.hex, folder: 'Local', readOnly: true, props: { path: 'C:\\data\\inventory.db' } });
    expect(useConnections.getState().connections.some((c) => c.name === 'inventory')).toBe(true);
  });

  it('edits an existing connection keeping the stored password', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ConnectionDialog state={{ mode: 'edit', id: 'c_prod' }} onClose={onClose} />);
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Prod SQL');
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', expect.stringMatching(/stored/));
    await user.clear(name);
    await user.type(name, 'Production');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const c = mock.ctx.engine.connections.find((x) => x.id === 'c_prod')!;
    expect(c.name).toBe('Production');
    expect(c.hasPassword).toBe(true);
  });
});

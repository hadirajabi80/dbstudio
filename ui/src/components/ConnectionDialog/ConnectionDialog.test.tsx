import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnections } from '../../store/connections';
import { installMockEngine } from '../../test/mockServer';
import { CONNECTION_PALETTE } from '../../theme/connColors';
import { ConnectionDialog } from './ConnectionDialog';

const mock = installMockEngine();

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

    // the styled Select (user-04): open it, then pick the option like a user does
    await user.click(screen.getByLabelText('Authentication'));
    await user.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'windows')!);
    expect(screen.getByLabelText('Authentication')).toHaveAttribute('data-value', 'windows');
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
    await user.click(screen.getByRole('checkbox', { name: /^Read-only \(DbStudio blocks statements that change data\)$/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const saved = mock.ctx.engine.connections.find((c) => c.name === 'inventory');
    expect(saved).toMatchObject({ providerId: 'sqlite', color: CONNECTION_PALETTE.find((p) => p.id === 'blue')!.hex, folder: 'Local', readOnly: true, props: { path: 'C:\\data\\inventory.db' } });
    expect(useConnections.getState().connections.some((c) => c.name === 'inventory')).toBe(true);
  });

  it('validates required fields before Test (no engine call) and marks them for assistive tech', async () => {
    const user = userEvent.setup();
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlite' }} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    const field = screen.getByLabelText(/Database file/);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Database file is required');
    expect(mock.hits('/connections/test', 'POST')).toHaveLength(0);
    await waitFor(() => expect(field).toHaveFocus());
  });

  it('uses one provider naming set and keeps the two SQLite read-only options apart', () => {
    render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlite' }} onClose={() => {}} />);
    expect(screen.getByRole('option', { name: 'SQL Server' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Oracle' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Open file read-only' })).toBeInTheDocument();
    // design-r1-05: the engine guard has the one "Read-only" label every provider shows; the SQLite file mode is its own field
    expect(screen.getByRole('checkbox', { name: /^Read-only \(DbStudio blocks statements that change data\)$/ })).toBeInTheDocument();
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

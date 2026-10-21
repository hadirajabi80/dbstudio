// Regression: Settings › Snippets rendered the plain SnippetsSettings without its `snippets`/`onChange` props, so the
// render threw and the whole window went white. The section must load the store-connected editor, and its edits must
// reach Settings.snippets and the engine (PUT /settings).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { Snippet } from '../../api/types';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { SettingsDialog } from './settings/SettingsDialog';

/** The section is a lazy chunk: its first load can take a while on a busy machine. */
const LAZY = { timeout: 10000 };

describe('Settings › Snippets', () => {
  let put: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    useSettings.setState((s) => ({ settings: { ...s.settings, snippets: [] } }));
    useUi.setState({ settingsOpen: true });
    put = vi.spyOn(api, 'putSettings').mockImplementation(async (p) => p as never);
  });
  afterEach(() => {
    put.mockRestore();
    useUi.setState({ settingsOpen: false });
  });

  it('renders the snippet editor (no crash) and persists a new snippet', { timeout: 30000 }, async () => {
    const errors = vi.spyOn(console, 'error');
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole('tab', { name: 'Snippets' }));
    expect(await screen.findByRole('listbox', { name: 'Snippets' }, LAZY)).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.getAllByRole('option').some((o) => o.textContent?.startsWith('sel'))).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: /New snippet/ })[0]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Top customers' } });
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: 'topc' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'SELECT TOP (${1:10}) * FROM Customers$0' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    const saved = (useSettings.getState().settings as { snippets: Snippet[] }).snippets;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Top customers', prefix: 'topc', body: 'SELECT TOP (${1:10}) * FROM Customers$0' });
    // the settings store sends a debounced partial update to the engine
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.objectContaining({ snippets: [expect.objectContaining({ prefix: 'topc' })] })), { timeout: 8000 });
    // the list shows it (and its body preview) under "Your snippets"
    expect(screen.getAllByRole('option')[0]).toHaveTextContent(/^topcTop customers/);
    // no render error reached a boundary (React logs "The above error occurred…", the boundary "Render error in…")
    const renderErrors = errors.mock.calls.filter((c) => /Render error|above error occurred/.test(String(c[0])));
    expect(renderErrors).toEqual([]);
    errors.mockRestore();
  });

  it('switching sections and back keeps the editor working', { timeout: 30000 }, async () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole('tab', { name: 'Snippets' }));
    await screen.findByRole('listbox', { name: 'Snippets' }, LAZY);
    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    expect(screen.queryByRole('listbox', { name: 'Snippets' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Snippets' }));
    expect(await screen.findByRole('listbox', { name: 'Snippets' }, LAZY)).toBeInTheDocument();
    await act(async () => {});
  });
});

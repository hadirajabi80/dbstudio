import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useUi } from '../../store/ui';
import { Toasts } from './Toasts';

describe('Toasts', () => {
  beforeEach(() => useUi.setState({ toasts: [] }));

  it('renders the action of a toast; clicking it runs the action and dismisses the toast', () => {
    const run = vi.fn();
    render(<Toasts />);
    act(() => toast('error', 'Could not save the changes to people', 'UNIQUE constraint failed', { label: 'Show SQL', run }));
    expect(screen.getByText('Could not save the changes to people')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show SQL' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Could not save the changes to people')).toBeNull();
  });

  it('a toast without an action has only the dismiss button', () => {
    render(<Toasts />);
    act(() => toast('success', 'Saved 1 change to people'));
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss']);
  });
});

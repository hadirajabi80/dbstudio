// user-01: toolbar buttons look enabled unless they truly cannot act, and then say why.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPlatformForTests } from '../../commands/keys';
import { registerCommand } from '../../commands/registry';
import { CommandButton } from './CommandButton';

describe('CommandButton', () => {
  const run = vi.fn();
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    run.mockReset();
    setPlatformForTests(null);
  });

  it('an available command is a normal button whose tooltip lists its advertised shortcuts', () => {
    setPlatformForTests(false);
    off = registerCommand({ id: 'test.format', title: 'Format SQL', category: 'Test', shortcut: 'Shift+Alt+F', altShortcuts: ['Mod+Alt+L'], showAltShortcuts: true, run });
    render(<CommandButton command="test.format" label="Format" variant="ghost" />);
    const b = screen.getByRole('button', { name: 'Format' });
    expect(b).toBeEnabled();
    expect(b).not.toHaveAttribute('aria-disabled');
    expect(b).toHaveAttribute('title', 'Format SQL (Shift+Alt+F or Ctrl+Alt+L)');
    fireEvent.click(b);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('with a disabledReason it is dimmed but focusable, explains why, and does not run', () => {
    off = registerCommand({ id: 'test.explain', title: 'Explain plan', category: 'Test', run });
    render(<CommandButton command="test.explain" label="Explain" variant="ghost" disabledReason="type a statement to explain" />);
    const b = screen.getByRole('button', { name: 'Explain' });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).not.toBeDisabled();
    expect(b).toHaveAttribute('title', 'Explain plan: type a statement to explain');
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(run).not.toHaveBeenCalled();
  });

  it('a command whose `when` is false is disabled', () => {
    off = registerCommand({ id: 'test.never', title: 'Never', category: 'Test', when: () => false, run });
    render(<CommandButton command="test.never" label="Never" />);
    expect(screen.getByRole('button', { name: 'Never' })).toBeDisabled();
  });
});

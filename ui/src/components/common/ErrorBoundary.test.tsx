// Error boundaries: a render error in one tab shows the error panel in that tab only; the other tabs and the shell keep
// rendering; "Try again" renders the children again; "Copy details" copies the message and the component stack.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewTab } from '../../store/tabs';
import { registerTabView, type TabViewProps } from '../layout/tabViews';
import { ViewTabHost } from '../layout/ViewTabHost';
import { ErrorBoundary } from './ErrorBoundary';

let crash = true;
function Broken({ tab }: TabViewProps): JSX.Element {
  if (crash) throw new Error(`Cannot read properties of undefined (reading 'columns')`);
  return <div data-testid={`ok-${tab.id}`}>recovered</div>;
}
function Fine({ tab }: TabViewProps) {
  return <div data-testid={`fine-${tab.id}`}>fine content</div>;
}

const tab = (id: string, view: string, title: string) => ({ id, kind: 'view', view, title, state: null }) as unknown as ViewTab;

/** A minimal shell: a status line plus two tab hosts, one of them active. */
function Shell({ active }: { active: string }) {
  return (
    <div>
      <div data-testid="statusbar">status bar</div>
      <ViewTabHost tab={tab('t1', 'broken', 'Broken view')} theme="light" visible={active === 't1'} />
      <ViewTabHost tab={tab('t2', 'fine', 'Fine view')} theme="light" visible={active === 't2'} />
    </div>
  );
}

let offs: (() => void)[] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;
// jsdom reports errors thrown during render as uncaught window errors: expected here, keep the output clean
const quiet = (e: ErrorEvent) => e.preventDefault();
beforeEach(() => {
  crash = true;
  offs = [registerTabView('broken', { component: Broken }), registerTabView('fine', { component: Fine })];
  // React and the boundary log the (expected) render errors
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  window.addEventListener('error', quiet);
});
afterEach(() => {
  offs.forEach((o) => o());
  errorSpy.mockRestore();
  window.removeEventListener('error', quiet);
});

describe('ErrorBoundary in the tab host', () => {
  it('shows the panel in the crashed tab; the shell and the other tabs still render', () => {
    const { rerender } = render(<Shell active="t1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in “Broken view”');
    expect(screen.getByRole('alert')).toHaveTextContent(`Cannot read properties of undefined (reading 'columns')`);
    expect(screen.getByTestId('statusbar')).toBeInTheDocument();
    expect(screen.getByTestId('fine-t2')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Render error in “Broken view”'), expect.any(Error), expect.any(String));

    // switching tabs: the healthy tab shows, the crashed one renders nothing while hidden
    rerender(<Shell active="t2" />);
    expect(screen.getByTestId('fine-t2')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<Shell active="t1" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('"Try again" renders the view again', () => {
    render(<Shell active="t1" />);
    crash = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('ok-t1')).toHaveTextContent('recovered');
  });

  it('a view that keeps crashing shows the panel again', () => {
    render(<Shell active="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in “Broken view”');
  });
});

describe('ErrorBoundary panel', () => {
  function Thrower(): JSX.Element {
    throw new Error('boom');
  }

  it('"Copy details" copies the area, the message and the component stack', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ErrorBoundary area="the Explorer"><Thrower /></ErrorBoundary>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Copy details/ })));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('Area: the Explorer');
    expect(text).toContain('Error: boom');
    expect(text).toMatch(/Component stack:[\s\S]*Thrower/);
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('the root panel offers "Reload window"; in the browser there is no "Open engine log"', () => {
    render(<ErrorBoundary area="DbStudio" variant="root"><Thrower /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: /Reload window/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toHaveFocus();
    expect(screen.queryByRole('button', { name: /Open engine log/ })).toBeNull();
  });

  it('a crashed dialog can be closed, and reopening it renders it afresh (resetKey)', () => {
    let closed = 0;
    function Host() {
      const [open, setOpen] = useState(1);
      return (
        <>
          <button onClick={() => setOpen((n) => n + 1)}>reopen</button>
          <ErrorBoundary area="Settings" variant="dialog" resetKey={open} onClose={() => closed++}>
            {open === 1 ? <Thrower /> : <div>dialog content</div>}
          </ErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('dialog', { name: 'Something went wrong in Settings' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('alert'), { key: 'Escape' });
    expect(closed).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    expect(screen.getByText('dialog content')).toBeInTheDocument();
  });
});

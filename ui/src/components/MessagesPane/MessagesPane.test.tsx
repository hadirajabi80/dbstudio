// styles-r2-03 / logic-r2-04: the Messages header reads "Finished with errors in 18 ms · Ran script · 2 batches": the
// separator keeps its spacing (its own item, not a collapsible leading space) and the run is described in words
// instead of the internal run label.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createExecution, type ExecutionState } from '../../store/resultsReducer';
import { MessagesPane, runDetails } from './MessagesPane';

function exec(o: Partial<ExecutionState> = {}): ExecutionState {
  const e = createExecution({
    localId: 'l1', tabId: 't1', connectionId: 'c_shop', sessionId: 's1', label: 'script', maxRows: 500, now: 1_000,
    batches: [{ sql: 'SELECT * FROM Custmers', line: 1, col: 1 }, { sql: 'SELECT Nme FROM Products', line: 2, col: 1 }],
  });
  return { ...e, ...o };
}

describe('Messages header (styles-r2-03, logic-r2-04)', () => {
  it('describes the run in words, in the tense of its state', () => {
    expect(runDetails(exec({ status: 'error' }))).toBe('Ran script · 2 batches');
    expect(runDetails(exec({ status: 'running' }))).toBe('Running script · 2 batches');
    expect(runDetails(exec({ status: 'ok', label: 'statement', batches: exec().batches.slice(0, 1) }))).toBe('Ran statement · 1 batch');
    expect(runDetails(exec({ status: 'ok', label: 'explain' as never }))).toBe('Ran explain plan · 2 batches');
    expect(runDetails(exec({ status: 'ok', label: 'data' as never }))).toBe('Ran data tab query · 2 batches');
    // an unknown label is left out rather than shown raw
    expect(runDetails(exec({ status: 'ok', label: 'mystery' as never }))).toBe('2 batches');
  });

  it('renders the separator as its own item after the summary, never as a leading space', () => {
    const e = exec({
      status: 'error',
      messages: [{ seq: 1, ts: 1_000, severity: 'error', text: 'Finished with errors in 18 ms', line: null, col: null, code: null, source: 'client', batchIndex: null }],
    });
    const { container } = render(<MessagesPane exec={e} />);
    const toolbar = container.querySelector('.messages-toolbar')!;
    const kids = [...toolbar.children];
    const summary = kids.findIndex((k) => k.classList.contains('messages-summary'));
    expect(summary).toBeGreaterThanOrEqual(0);
    const sep = kids[summary + 1] as HTMLElement;
    expect(sep.textContent).toBe('·');
    expect(sep).toHaveAttribute('aria-hidden', 'true');
    expect(sep.style.marginInline).toBe('var(--space-1)');
    expect(screen.getByText('Ran script · 2 batches')).toBeInTheDocument();
    // nothing after the summary starts with a space that flex layout would collapse
    for (const k of kids.slice(summary + 1)) expect(k.textContent?.startsWith(' ')).toBe(false);
    expect(toolbar.textContent).not.toMatch(/\bscript$|· script/);
  });

  it('without a summary (still running) shows only the run details', () => {
    const { container } = render(<MessagesPane exec={exec({ status: 'running' })} />);
    expect(container.querySelector('.messages-sep')).toBeNull();
    expect(screen.getByText('Running script · 2 batches')).toBeInTheDocument();
  });
});

// Plan view (A5): renders the fixture plans of all three dialects, highlights the expensive nodes, shows details,
// raw output and copies the plan.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ExecPlanPayload } from '../../api/types';
import { PlanView } from './PlanView';
import { planRows, planSummary, planToText, prettyXml, visibleRows } from './model';
import tsqlActual from './fixtures/tsql-actual.json';
import plsqlEstimated from './fixtures/plsql-estimated.json';
import sqliteEstimated from '../../mocks/fixtures/m15/plans/sqlite-estimated.json';

const TSQL = tsqlActual as unknown as ExecPlanPayload;
const PLSQL = plsqlEstimated as unknown as ExecPlanPayload;
const SQLITE = sqliteEstimated as unknown as ExecPlanPayload;

describe('plan model', () => {
  it('uses the engine cost % when present (SQL Server)', () => {
    const rows = planRows(TSQL.root);
    expect(rows).toHaveLength(5);
    const scan = rows.find((r) => r.node.id === 4)!;
    expect(scan.pct).toBeCloseTo(41.7);
    expect(scan.heat).toBe(3);
    expect(planSummary(rows, TSQL).hottest).toBe(scan.key);
    expect(rows.find((r) => r.node.id === 2)!.estimateOff).toBe(true);
  });

  it('derives own cost from subtree costs (Oracle)', () => {
    const rows = planRows(PLSQL.root);
    const byId = (id: number) => rows.find((r) => r.node.id === id)!;
    // TABLE ACCESS BY INDEX ROWID: 33 - 9 = 24 of 41
    expect(byId(5).pct).toBeCloseTo((24 / 41) * 100, 1);
    expect(byId(5).heat).toBe(3);
    // HASH JOIN: 39 - 5 - 33 = 1
    expect(byId(3).pct).toBeCloseTo((1 / 41) * 100, 1);
    const total = rows.reduce((s, r) => s + (r.pct ?? 0), 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it('SQLite has no costs: nothing is hot, summary says so', () => {
    const rows = planRows(SQLITE.root);
    expect(rows.every((r) => r.pct === null && r.heat === 0)).toBe(true);
    expect(planSummary(rows, SQLITE)).toMatchObject({ hasCost: false, hasActual: false, hottest: null, warnings: 1 });
  });

  it('collapsing hides descendants', () => {
    const rows = planRows(PLSQL.root);
    expect(visibleRows(rows, new Set(['0.0.0.0'])).map((r) => r.node.id)).toEqual([0, 1, 2, 3]);
  });

  it('text and xml helpers', () => {
    expect(planToText(PLSQL).split('\n')[0]).toBe('Oracle plan (estimated)');
    expect(planToText(PLSQL)).toContain('      HASH JOIN');
    expect(prettyXml('<a><b x="1"/><c>t</c></a>')).toBe('<a>\n  <b x="1"/>\n  <c>t</c>\n</a>');
  });
});

describe('PlanView', () => {
  it.each([['tsql', TSQL, 'SQL Server · Actual'], ['plsql', PLSQL, 'Oracle · Estimated'], ['sqlite', SQLITE, 'SQLite · Estimated']] as const)(
    'renders the %s fixture', (_d, plan, chip) => {
      render(<PlanView plan={plan} />);
      expect(screen.getByText(chip)).toBeInTheDocument();
      const grid = screen.getByRole('treegrid');
      expect(within(grid).getAllByRole('row').length).toBe(planRows(plan.root).length + 1);
    },
  );

  it('highlights the most expensive node and selects it with its details', () => {
    render(<PlanView plan={TSQL} />);
    const rows = document.querySelectorAll('tr.pv-heat-3');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const selected = document.querySelector('tr.selected')!;
    expect(selected.textContent).toContain('[dbo].[Orders].[PK_Orders] [o]');
    expect(screen.getByLabelText('Operator details').textContent).toContain('Missing index');
    expect(screen.getByText('Actual rows', { selector: 'th' })).toBeInTheDocument();
  });

  it('keyboard: arrows move, left collapses', () => {
    render(<PlanView plan={PLSQL} />);
    const first = document.querySelector<HTMLElement>('tr[data-key="0"]')!;
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(screen.getByRole('treegrid').querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('treegrid').querySelectorAll('tbody tr')).toHaveLength(7);
  });

  it('raw tab and copy', () => {
    const onCopy = vi.fn();
    render(<PlanView plan={PLSQL} onCopy={onCopy} />);
    fireEvent.click(screen.getByRole('tab', { name: /Raw/ }));
    expect(screen.getByLabelText('Raw plan').textContent).toContain('Plan hash value');
    fireEvent.click(screen.getByRole('button', { name: /Copy plan/ }));
    expect(onCopy).toHaveBeenCalledWith(PLSQL.raw);
  });

  it('running and error states', () => {
    const { rerender } = render(<PlanView plan={null} status="running" />);
    expect(screen.getByRole('status').textContent).toContain('Explaining');
    rerender(<PlanView plan={null} status="error" error="EXPLAIN failed: no such table" />);
    expect(screen.getByRole('alert').textContent).toContain('no such table');
  });
});

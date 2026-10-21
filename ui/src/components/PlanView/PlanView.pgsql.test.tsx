// PostgreSQL plans (EXPLAIN (FORMAT JSON), recorded from the engine by PG-A): label, tree, hottest node, buffers in the
// detail pane and the indented JSON in the Raw tab.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ExecPlanPayload } from '../../api/types';
import { PlanView } from './PlanView';
import { dialectLabel, planRows, planSummary, planToText, prettyJson, rawText } from './model';
import pgActual from '../../mocks/fixtures/m15/plans/pgsql-actual.json';
import pgEstimated from '../../mocks/fixtures/m15/plans/pgsql-estimated.json';

const ACTUAL = pgActual as unknown as ExecPlanPayload;
const ESTIMATED = pgEstimated as unknown as ExecPlanPayload;

describe('pgsql plan model', () => {
  it('label and text', () => {
    expect(dialectLabel('pgsql')).toBe('PostgreSQL');
    expect(planToText(ESTIMATED).split('\n')[0]).toBe('PostgreSQL plan (estimated)');
  });

  it('cost percentages from the engine; one hottest node', () => {
    for (const plan of [ESTIMATED, ACTUAL]) {
      const rows = planRows(plan.root);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const s = planSummary(rows, plan);
      expect(s.hasCost).toBe(true);
      expect(s.hottest).not.toBeNull();
      const total = rows.reduce((t, r) => t + (r.pct ?? 0), 0);
      expect(total).toBeGreaterThan(95);
      expect(total).toBeLessThan(105);
    }
    expect(planSummary(planRows(ACTUAL.root), ACTUAL).hasActual).toBe(true);
  });

  it('raw JSON is indented; other formats are left alone', () => {
    expect(prettyJson('[{"a":1}]')).toBe('[\n  {\n    "a": 1\n  }\n]');
    expect(prettyJson('not json')).toBe('not json');
    expect(rawText({ raw: '{"x":[1]}', rawFormat: 'json' })).toBe('{\n  "x": [\n    1\n  ]\n}');
    expect(rawText({ raw: 'a\nb', rawFormat: 'text' })).toBe('a\nb');
  });
});

describe('PlanView (pgsql)', () => {
  it('renders the estimated and actual fixtures', () => {
    const { unmount } = render(<PlanView plan={ESTIMATED} />);
    expect(screen.getByText('PostgreSQL · Estimated')).toBeInTheDocument();
    expect(within(screen.getByRole('treegrid')).getAllByRole('row').length).toBe(planRows(ESTIMATED.root).length + 1);
    unmount();
    render(<PlanView plan={ACTUAL} />);
    expect(screen.getByText('PostgreSQL · Actual')).toBeInTheDocument();
    expect(screen.getByText('Actual rows', { selector: 'th' })).toBeInTheDocument();
  });

  it('the hottest node is selected and its buffers / timings show in the details', () => {
    render(<PlanView plan={ACTUAL} />);
    expect(document.querySelectorAll('tr.pv-heat-3').length).toBeGreaterThanOrEqual(1);
    const details = screen.getByLabelText('Operator details').textContent ?? '';
    expect(details).toContain('Shared Hit Blocks');
    expect(details).toContain('Actual Total Time (ms)');
  });

  it('the raw tab shows the EXPLAIN JSON document', () => {
    render(<PlanView plan={ESTIMATED} />);
    fireEvent.click(screen.getByRole('tab', { name: /Raw/ }));
    const raw = screen.getByLabelText('Raw plan');
    expect(raw.getAttribute('data-format')).toBe('json');
    expect(raw.textContent).toContain('"Node Type"');
    expect(() => JSON.parse(raw.textContent ?? '')).not.toThrow();
  });
});

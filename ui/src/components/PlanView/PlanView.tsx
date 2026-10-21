// Explain plan viewer (PLAN-M1.5 A5): a tree table of the normalised plan (operation, object, estimated/actual rows,
// cost and the node's own share of it) with the expensive nodes highlighted, a details pane for the selected node,
// the raw provider output (ShowPlan XML / DBMS_XPLAN text / EXPLAIN QUERY PLAN) and "Copy plan". No graph layout.
import { AlertTriangle, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, FileText, Flame, ListTree, RotateCw } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ExecPlanPayload } from '../../api/types';
import { dialectLabel, formatCost, formatPct, formatRows, planRows, planSummary, planToText, rawText, visibleRows, type PlanRow } from './model';
import './PlanView.css';
import { pluralize } from '../common/text';

export interface PlanViewProps {
  plan: ExecPlanPayload | null;
  status?: 'running' | 'done' | 'error';
  error?: string | null;
  /** The explained statement (shown in the header tooltip). */
  sql?: string;
  onRerun?: () => void;
  /** Copy handler (default: the clipboard API). */
  onCopy?: (text: string) => void;
}

function defaultCopy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function PlanView({ plan, status = plan ? 'done' : 'running', error, sql, onRerun, onCopy = defaultCopy }: PlanViewProps) {
  const [tab, setTab] = useState<'tree' | 'raw'>('tree');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => (plan ? planRows(plan.root) : []), [plan]);
  const summary = useMemo(() => planSummary(rows, plan), [rows, plan]);
  const [selected, setSelected] = useState<string | null>(() => summary.hottest ?? rows[0]?.key ?? null);
  const [shownPlan, setShownPlan] = useState(plan);
  if (shownPlan !== plan) {
    // a new plan arrived: expand everything and select its most expensive node
    setShownPlan(plan);
    setCollapsed(new Set());
    setSelected(summary.hottest ?? rows[0]?.key ?? null);
  }
  const shown = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  const sel = rows.find((r) => r.key === selected) ?? null;
  const toggle = (key: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  const focusRow = (key: string) => {
    setSelected(key);
    requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus());
  };

  const onKey = (e: KeyboardEvent, r: PlanRow) => {
    const i = shown.findIndex((x) => x.key === r.key);
    const parentKey = r.key.includes('.') ? r.key.slice(0, r.key.lastIndexOf('.')) : null;
    switch (e.key) {
      case 'ArrowDown': if (i < shown.length - 1) focusRow(shown[i + 1].key); break;
      case 'ArrowUp': if (i > 0) focusRow(shown[i - 1].key); break;
      case 'Home': focusRow(shown[0].key); break;
      case 'End': focusRow(shown[shown.length - 1].key); break;
      case 'ArrowRight':
        if (r.hasChildren && collapsed.has(r.key)) toggle(r.key);
        else if (r.hasChildren) focusRow(`${r.key}.0`);
        break;
      case 'ArrowLeft':
        if (r.hasChildren && !collapsed.has(r.key)) toggle(r.key);
        else if (parentKey) focusRow(parentKey);
        break;
      case 'Enter': case ' ':
        if (r.hasChildren) toggle(r.key);
        break;
      default: return;
    }
    e.preventDefault();
  };

  const maxPct = Math.max(1, ...rows.map((r) => r.pct ?? 0));
  const raw = plan ? rawText(plan) : '';

  return (
    <div className="pv" data-command-scope="plan">
      <div className="pv-toolbar" role="toolbar" aria-label="Plan">
        <ListTree size={16} strokeWidth={1.5} className="pv-icon" aria-hidden />
        <span className="pv-title" title={sql}>Explain plan</span>
        {plan && <span className="pv-chip">{dialectLabel(plan.dialect)} · {plan.mode === 'actual' ? 'Actual' : 'Estimated'}</span>}
        {plan && <span className="pv-meta">{pluralize(summary.nodes, 'node')}</span>}
        {plan && summary.warnings > 0 && (
          <span className="pv-meta pv-warn-count" title="Nodes with warnings">
            <AlertTriangle size={14} strokeWidth={1.5} aria-hidden /> {pluralize(summary.warnings, 'warning')}
          </span>
        )}
        <span className="flex-1" />
        <div className="pv-seg" role="tablist" aria-label="Plan view">
          <button role="tab" aria-selected={tab === 'tree'} className={tab === 'tree' ? 'active' : ''} onClick={() => setTab('tree')}>
            <ListTree size={14} strokeWidth={1.5} aria-hidden /> Tree
          </button>
          <button role="tab" aria-selected={tab === 'raw'} className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')} disabled={!plan}>
            <FileText size={14} strokeWidth={1.5} aria-hidden /> Raw
          </button>
        </div>
        {tab === 'tree' && plan && (
          <>
            <button className="icon-btn" title="Expand all" aria-label="Expand all" onClick={() => setCollapsed(new Set())}><ChevronsUpDown size={16} strokeWidth={1.5} /></button>
            <button className="icon-btn" title="Collapse all" aria-label="Collapse all" onClick={() => setCollapsed(new Set(rows.filter((r) => r.hasChildren && r.depth > 0).map((r) => r.key)))}>
              <ChevronsDownUp size={16} strokeWidth={1.5} />
            </button>
          </>
        )}
        <button className="btn btn-xs" disabled={!plan} onClick={() => plan && onCopy(tab === 'raw' ? plan.raw : planToText(plan))} title={tab === 'raw' ? 'Copy the raw plan' : 'Copy the plan as text'}>
          <Copy size={14} strokeWidth={1.5} aria-hidden /> Copy plan
        </button>
        {onRerun && (
          <button className="btn btn-xs" onClick={onRerun} disabled={status === 'running'} title="Explain again">
            <RotateCw size={14} strokeWidth={1.5} aria-hidden /> Re-run
          </button>
        )}
      </div>

      {status === 'running' && !plan && <div className="pv-empty" role="status">Explaining the statement…</div>}
      {status === 'error' && (
        <div className="pv-empty pv-error" role="alert">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden /> {error || 'The plan could not be produced.'}
        </div>
      )}
      {plan && plan.warnings.length > 0 && tab === 'tree' && (
        <ul className="pv-plan-warnings">{plan.warnings.map((w, i) => <li key={i}><AlertTriangle size={14} strokeWidth={1.5} aria-hidden /> {w}</li>)}</ul>
      )}

      {plan && tab === 'tree' && (
        <div className="pv-body">
          <div className="pv-scroll">
            <table className="pv-table" role="treegrid" aria-label="Plan operators" aria-rowcount={shown.length}>
              <thead>
                <tr>
                  <th className="pv-col-op">Operation</th>
                  <th className="pv-col-obj">Object</th>
                  <th className="pv-num">Est. rows</th>
                  {summary.hasActual && <th className="pv-num">Actual rows</th>}
                  {summary.hasCost && <th className="pv-num">Cost</th>}
                  {summary.hasCost && <th className="pv-col-pct">Cost %</th>}
                </tr>
              </thead>
              <tbody ref={tableRef}>
                {shown.map((r) => {
                  const n = r.node;
                  const open = r.hasChildren && !collapsed.has(r.key);
                  return (
                    <tr
                      key={r.key}
                      data-key={r.key}
                      role="row"
                      aria-level={r.depth + 1}
                      aria-expanded={r.hasChildren ? open : undefined}
                      aria-selected={selected === r.key}
                      tabIndex={selected === r.key || (!selected && r.key === '0') ? 0 : -1}
                      className={`pv-row pv-heat-${r.heat}${selected === r.key ? ' selected' : ''}`}
                      onClick={() => setSelected(r.key)}
                      onKeyDown={(e) => onKey(e, r)}
                    >
                      <td className="pv-col-op" style={{ paddingLeft: `calc(${r.depth} * 16px + 6px)` }}>
                        {r.hasChildren ? (
                          <button className="pv-twisty" tabIndex={-1} aria-label={open ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); toggle(r.key); }}>
                            {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
                          </button>
                        ) : <span className="pv-twisty-space" />}
                        {r.heat === 3 && <Flame size={14} strokeWidth={1.5} className="pv-flame" aria-label="Most expensive" />}
                        <span className="pv-op">{n.op}</span>
                        {n.logicalOp && n.logicalOp !== n.op && <span className="pv-logical">{n.logicalOp}</span>}
                        {n.warnings.length > 0 && <AlertTriangle size={14} strokeWidth={1.5} className="pv-warn" aria-label={n.warnings.join('\n')} />}
                      </td>
                      <td className="pv-col-obj" title={n.object ?? undefined}>{n.object}</td>
                      <td className="pv-num">{formatRows(n.estRows)}</td>
                      {summary.hasActual && (
                        <td className={`pv-num${r.estimateOff ? ' pv-off' : ''}`} title={r.estimateOff ? 'Actual rows differ from the estimate by 10× or more' : undefined}>
                          {formatRows(n.actualRows)}{r.estimateOff && <span className="pv-off-mark" aria-hidden> ≠</span>}
                        </td>
                      )}
                      {summary.hasCost && <td className="pv-num">{formatCost(n.cost)}</td>}
                      {summary.hasCost && (
                        <td className="pv-col-pct">
                          <span className="pv-bar" aria-hidden><span style={{ width: `${((r.pct ?? 0) / maxPct) * 100}%` }} /></span>
                          <span className="pv-pct">{formatPct(r.pct)}</span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sel && <PlanDetails row={sel} />}
        </div>
      )}

      {plan && tab === 'raw' && <pre className="pv-raw" tabIndex={0} aria-label="Raw plan" data-format={plan.rawFormat}>{raw}</pre>}
    </div>
  );
}

function PlanDetails({ row }: { row: PlanRow }) {
  const n = row.node;
  const props: [string, string][] = [
    ['Operation', n.op],
    ...(n.logicalOp ? [['Logical operation', n.logicalOp] as [string, string]] : []),
    ...(n.object ? [['Object', n.object] as [string, string]] : []),
    ...(n.estRows !== null ? [['Estimated rows', formatRows(n.estRows)] as [string, string]] : []),
    ...(n.actualRows !== null ? [['Actual rows', formatRows(n.actualRows)] as [string, string]] : []),
    ...(n.cost !== null ? [['Subtree cost', formatCost(n.cost)] as [string, string]] : []),
    ...(row.pct !== null ? [['Own cost', formatPct(row.pct)] as [string, string]] : []),
    ...Object.entries(n.props ?? {}),
  ];
  return (
    <aside className="pv-details" aria-label="Operator details">
      <dl>
        {props.map(([k, v]) => (
          <div key={k} className="pv-prop"><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      {n.predicate && (
        <>
          <div className="pv-details-h">Predicate</div>
          <pre className="pv-predicate">{n.predicate}</pre>
        </>
      )}
      {n.warnings.length > 0 && (
        <>
          <div className="pv-details-h">Warnings</div>
          <ul className="pv-node-warnings">{n.warnings.map((w, i) => <li key={i}><AlertTriangle size={14} strokeWidth={1.5} aria-hidden /> {w}</li>)}</ul>
        </>
      )}
    </aside>
  );
}

export default PlanView;

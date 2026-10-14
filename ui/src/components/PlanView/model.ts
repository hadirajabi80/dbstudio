// Plan view model (PLAN-M1.5 A5): flattens the normalised PlanNode tree into visible rows, derives each node's own
// share of the cost when the engine did not send `costPct`, and classifies the expensive nodes. Pure TypeScript.
import type { ExecPlanPayload, PlanNode } from '../../api/types';

export type Heat = 0 | 1 | 2 | 3;

export interface PlanRow {
  node: PlanNode;
  /** Stable key: path of child indexes ("0", "0.1", ...). */
  key: string;
  depth: number;
  hasChildren: boolean;
  /** Share of the total cost spent in this node alone (0–100), or null when unknown. */
  pct: number | null;
  /** 3 = most expensive / ≥ 50 %, 2 = ≥ 25 %, 1 = ≥ 10 %. */
  heat: Heat;
  /** Actual rows differ from the estimate by 10× or more. */
  estimateOff: boolean;
}

export interface PlanSummary {
  nodes: number;
  warnings: number;
  /** Key of the single most expensive node (null when costs are unknown). */
  hottest: string | null;
  totalCost: number | null;
  hasActual: boolean;
  hasCost: boolean;
}

function selfPct(node: PlanNode, total: number | null): number | null {
  if (node.costPct !== null && node.costPct !== undefined && Number.isFinite(node.costPct)) return Math.max(0, Math.min(100, node.costPct));
  if (node.cost === null || total === null || total <= 0) return null;
  const childCost = node.children.reduce((s, c) => s + (c.cost ?? 0), 0);
  return Math.max(0, Math.min(100, ((node.cost - childCost) / total) * 100));
}

function heatOf(pct: number | null): Heat {
  if (pct === null) return 0;
  return pct >= 50 ? 3 : pct >= 25 ? 2 : pct >= 10 ? 1 : 0;
}

/** All rows of the tree (depth-first) with derived values. */
export function planRows(root: PlanNode): PlanRow[] {
  const total = root.cost !== null && root.cost > 0 ? root.cost : null;
  const out: PlanRow[] = [];
  const walk = (n: PlanNode, key: string, depth: number) => {
    const pct = selfPct(n, total);
    const off = n.actualRows !== null && n.estRows !== null && n.estRows >= 0
      && (n.actualRows > Math.max(1, n.estRows) * 10 || (n.estRows >= 10 && n.actualRows * 10 < n.estRows));
    out.push({ node: n, key, depth, hasChildren: n.children.length > 0, pct, heat: heatOf(pct), estimateOff: off });
    n.children.forEach((c, i) => walk(c, `${key}.${i}`, depth + 1));
  };
  walk(root, '0', 0);
  // the single most expensive node is always "hot"
  let best: PlanRow | null = null;
  for (const r of out) if (r.pct !== null && r.pct > 0 && (!best || r.pct > best.pct!)) best = r;
  if (best && best.heat < 3) best.heat = 3;
  return out;
}

export function planSummary(rows: PlanRow[], plan?: Pick<ExecPlanPayload, 'warnings'> | null): PlanSummary {
  let hottest: PlanRow | null = null;
  let warnings = plan?.warnings.length ?? 0;
  for (const r of rows) {
    warnings += r.node.warnings.length;
    if (r.pct !== null && (!hottest || r.pct > hottest.pct!)) hottest = r;
  }
  return {
    nodes: rows.length,
    warnings,
    hottest: hottest && hottest.pct! > 0 ? hottest.key : null,
    totalCost: rows[0]?.node.cost ?? null,
    hasActual: rows.some((r) => r.node.actualRows !== null),
    hasCost: rows.some((r) => r.pct !== null),
  };
}

/** Rows visible with the given collapsed keys. */
export function visibleRows(rows: PlanRow[], collapsed: ReadonlySet<string>): PlanRow[] {
  const out: PlanRow[] = [];
  let hideUnder: string | null = null;
  for (const r of rows) {
    if (hideUnder && r.key.startsWith(hideUnder + '.')) continue;
    hideUnder = null;
    out.push(r);
    if (r.hasChildren && collapsed.has(r.key)) hideUnder = r.key;
  }
  return out;
}

export function formatRows(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '';
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export function formatCost(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '';
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return Number(n.toPrecision(3)).toString();
}

export function formatPct(p: number | null): string {
  if (p === null) return '';
  return p >= 10 || p === 0 ? `${Math.round(p)} %` : `${p.toFixed(1)} %`;
}

/** Plain-text rendering of the tree (Copy plan). */
export function planToText(plan: ExecPlanPayload): string {
  const rows = planRows(plan.root);
  const head = `${dialectLabel(plan.dialect)} plan (${plan.mode})`;
  const lines = rows.map((r) => {
    const parts = [`${'  '.repeat(r.depth)}${r.node.op}`];
    if (r.node.object) parts.push(`[${r.node.object}]`);
    if (r.node.estRows !== null) parts.push(`est ${formatRows(r.node.estRows)}`);
    if (r.node.actualRows !== null) parts.push(`actual ${formatRows(r.node.actualRows)}`);
    if (r.pct !== null) parts.push(formatPct(r.pct));
    if (r.node.predicate) parts.push(`{${r.node.predicate}}`);
    for (const w of r.node.warnings) parts.push(`! ${w}`);
    return parts.join('  ');
  });
  return [head, ...plan.warnings.map((w) => `! ${w}`), ...lines].join('\n');
}

export function dialectLabel(d: ExecPlanPayload['dialect']): string {
  return d === 'tsql' ? 'SQL Server' : d === 'plsql' ? 'Oracle' : 'SQLite';
}

/** Indents ShowPlan XML for the Raw tab (one element per line). */
export function prettyXml(xml: string): string {
  if (xml.indexOf('\n') >= 0 && xml.indexOf('\n') < xml.length - 1) return xml;
  const parts = xml.replace(/>\s*</g, '>\n<').split('\n');
  let depth = 0;
  return parts.map((p) => {
    if (/^<\//.test(p)) depth = Math.max(0, depth - 1);
    const line = '  '.repeat(depth) + p;
    if (/^<[^!?/][^>]*>$/.test(p) && !p.endsWith('/>')) depth++;
    return line;
  }).join('\n');
}

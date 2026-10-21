// Auto layout (docs/PLAN-M2.md section 3, D6): dagre (rankdir LR/TB, ranksep 80, nodesep 30) per connected component,
// components and unconnected tables tiled; more than 300 tables are first clustered per schema and each cluster laid
// out on its own. Runs in layout.worker.ts; deterministic for the same input (nodes and edges are fed sorted).
import dagre from '@dagrejs/dagre';
import type { DiagramAutoLayout } from '../../api/types';
import { gridBlock, tileBlocks, type Block, type Box } from './place';

export interface LayoutNode { key: string; w: number; h: number; schema: string }
export interface LayoutEdge { from: string; to: string }
export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  mode: DiagramAutoLayout;
  /** Cards that keep their position (pinned). */
  pinned?: Record<string, [number, number]>;
}
export interface LayoutResult {
  positions: Record<string, [number, number]>;
  ms: number;
  /** Laid-out clusters (schemas) and components (diagnostics, status text). */
  clusters: number;
  components: number;
}
export type LayoutProgress = (message: string) => void;

export const CLUSTER_THRESHOLD = 300;
const RANKSEP = 80;
const NODESEP = 30;
const COMPONENT_GAP = 96;
const CLUSTER_GAP = 200;
/** Above this many nodes in one component the faster longest-path ranker replaces network simplex. */
const FAST_RANKER = 120;

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Connected components (union-find), each sorted by key; components in order of their first key. */
export function components(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): LayoutNode[][] {
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map<number, LayoutNode[]>();
  nodes.forEach((n, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), n]);
  });
  return [...groups.values()].map((g) => g.sort(byKey)).sort((a, b) => byKey(a[0], b[0]));
}

function dagreBlock(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], rankdir: 'LR' | 'TB'): Block {
  const g = new dagre.graphlib.Graph({ directed: true, multigraph: false, compound: false });
  g.setGraph({ rankdir, ranksep: RANKSEP, nodesep: NODESEP, edgesep: 12, marginx: 0, marginy: 0, ranker: nodes.length > FAST_RANKER ? 'longest-path' : 'network-simplex' });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.key, { width: n.w, height: n.h });
  const keys = new Set(nodes.map((n) => n.key));
  const seen = new Set<string>();
  const sorted = [...edges].sort((a, b) => (a.to + a.from < b.to + b.from ? -1 : 1));
  for (const e of sorted) {
    if (e.from === e.to || !keys.has(e.from) || !keys.has(e.to)) continue;
    // referenced (parent) tables rank first: lookups on the left (LR) / top (TB), facts after them
    const id = `${e.to}\u0001${e.from}`;
    if (seen.has(id) || seen.has(`${e.from}\u0001${e.to}`)) continue;
    seen.add(id);
    g.setEdge(e.to, e.from);
  }
  dagre.layout(g);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw: Record<string, [number, number]> = {};
  for (const n of nodes) {
    const p = g.node(n.key) as { x: number; y: number };
    const x = p.x - n.w / 2;
    const y = p.y - n.h / 2;
    raw[n.key] = [x, y];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + n.w);
    maxY = Math.max(maxY, y + n.h);
  }
  const positions: Record<string, [number, number]> = {};
  for (const [k, [x, y]] of Object.entries(raw)) positions[k] = [Math.round(x - minX), Math.round(y - minY)];
  return { w: maxX - minX, h: maxY - minY, positions };
}

/**
 * Large components give dagre very long ranks (hundreds of tables referencing a few hubs): a 10 000 × 110 000 px
 * column nobody can read. Ranks longer than a 16:10 target are folded into several sub-columns (LR) / sub-rows (TB),
 * keeping dagre's crossing-minimised order, and the ranks are packed again with the rank separation.
 */
export function wrapRanks(block: Block, nodes: readonly LayoutNode[], rankdir: 'LR' | 'TB'): Block {
  const lr = rankdir === 'LR';
  const area = nodes.reduce((a, n) => a + (n.w + NODESEP) * (n.h + NODESEP), 0) * 1.15;
  const target = Math.sqrt(lr ? area / 1.6 : area * 1.6); // LR: max column height; TB: max row width
  const extent = lr ? block.h : block.w;
  if (extent <= target * 1.3) return block;
  const ranks = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const p = block.positions[n.key];
    const c = Math.round(lr ? p[0] + n.w / 2 : p[1] + n.h / 2);
    ranks.set(c, [...(ranks.get(c) ?? []), n]);
  }
  const positions: Record<string, [number, number]> = {};
  let main = 0;
  let cross = 0;
  for (const coord of [...ranks.keys()].sort((a, b) => a - b)) {
    const list = ranks.get(coord)!.sort((a, b) => (lr ? block.positions[a.key][1] - block.positions[b.key][1] : block.positions[a.key][0] - block.positions[b.key][0]));
    let off = 0;
    let along = 0;
    let thick = 0;
    for (const n of list) {
      const len = lr ? n.h : n.w;
      if (along > 0 && along + len > target) {
        off += thick + NODESEP * 2;
        along = 0;
        thick = 0;
      }
      positions[n.key] = lr ? [main + off, along] : [along, main + off];
      along += len + NODESEP;
      thick = Math.max(thick, lr ? n.w : n.h);
      cross = Math.max(cross, along - NODESEP);
    }
    main += off + thick + RANKSEP;
  }
  const mainExtent = Math.max(0, main - RANKSEP);
  return { w: lr ? mainExtent : cross, h: lr ? cross : mainExtent, positions };
}

/** Grid layout: tables ordered by component (related tables stay close), then by key. */
function gridLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Block {
  const ordered = components(nodes, edges).sort((a, b) => b.length - a.length || byKey(a[0], b[0])).flat();
  return gridBlock(ordered as Box[]);
}

function layoutCluster(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], mode: DiagramAutoLayout, counts: { components: number }): Block {
  if (mode === 'grid') {
    counts.components += 1;
    return gridLayout(nodes, edges);
  }
  const rankdir = mode === 'layered-tb' ? 'TB' : 'LR';
  const comps = components(nodes, edges);
  const blocks: Block[] = [];
  const singles: LayoutNode[] = [];
  for (const c of comps) {
    if (c.length === 1) singles.push(c[0]);
    else {
      blocks.push(wrapRanks(dagreBlock(c, edges, rankdir), c, rankdir));
      counts.components += 1;
    }
  }
  if (singles.length) {
    blocks.push(gridBlock(singles, 40, 32));
    counts.components += 1;
  }
  return tileBlocks(blocks, COMPONENT_GAP);
}

export function computeLayout(input: LayoutInput, progress?: LayoutProgress): LayoutResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pinned = input.pinned ?? {};
  const free = input.nodes.filter((n) => !pinned[n.key]).sort(byKey);
  const counts = { components: 0 };
  let clusters: LayoutNode[][];
  if (free.length > CLUSTER_THRESHOLD) {
    const bySchema = new Map<string, LayoutNode[]>();
    for (const n of free) bySchema.set(n.schema, [...(bySchema.get(n.schema) ?? []), n]);
    clusters = [...bySchema.keys()].sort().map((s) => bySchema.get(s)!);
  } else clusters = free.length ? [free] : [];
  const blocks: Block[] = [];
  clusters.forEach((c, i) => {
    if (clusters.length > 1) progress?.(`Laying out ${c.length} tables of ${c[0].schema} (${i + 1}/${clusters.length})…`);
    else progress?.(`Laying out ${c.length} tables…`);
    blocks.push(layoutCluster(c, input.edges, input.mode, counts));
  });
  const all = blocks.length > 1 ? tileBlocks(blocks, CLUSTER_GAP) : blocks[0] ?? { w: 0, h: 0, positions: {} };
  const positions: Record<string, [number, number]> = { ...all.positions };
  // pinned cards keep their place; the rest is shifted below them when both exist
  const pinnedKeys = Object.keys(pinned).filter((k) => input.nodes.some((n) => n.key === k));
  if (pinnedKeys.length && free.length) {
    let maxY = -Infinity;
    let minX = Infinity;
    for (const k of pinnedKeys) {
      const n = input.nodes.find((x) => x.key === k)!;
      maxY = Math.max(maxY, pinned[k][1] + n.h);
      minX = Math.min(minX, pinned[k][0]);
    }
    for (const k of Object.keys(positions)) positions[k] = [positions[k][0] + minX, positions[k][1] + maxY + COMPONENT_GAP];
  }
  for (const k of pinnedKeys) positions[k] = [pinned[k][0], pinned[k][1]];
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { positions, ms: Math.round(t1 - t0), clusters: clusters.length, components: counts.components };
}

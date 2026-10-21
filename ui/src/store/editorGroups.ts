// Editor groups (split editor): the workspace shows up to MAX_GROUPS groups side by side or stacked, each with its own
// tab strip and active tab. This module is pure (no stores, no React): the state lives in `useTabs` (store/tabs.ts),
// which calls these reducers, and the layout is persisted in the workspace as the optional `groups` field (a workspace
// without it loads as one group holding every tab).
//
// Invariants kept by `normalizeGroups` (applied after every change of the tabs store):
//  - every tab is in exactly one group; a group's `tabIds` follow the order of `useTabs.tabs`;
//  - there is always at least one group; empty groups are removed while another group exists;
//  - the globally active tab (`useTabs.activeId`) is the active tab of the focused group;
//  - the layout tree names every group exactly once, splits have >= 2 children and sizes that sum to 1.

export const MAX_GROUPS = 3;
/** Smallest share of its split a group can be resized to. */
export const MIN_GROUP_FRACTION = 0.12;

export interface EditorGroup {
  id: string;
  /** Tabs of the group, in tab-strip order. */
  tabIds: string[];
  /** Tab shown in the group (null only for an empty group). */
  activeId: string | null;
}

export type SplitDirection = 'row' | 'column';

/** `row`: children side by side (left to right); `column`: stacked (top to bottom). */
export type GroupLayoutNode =
  | { kind: 'group'; id: string }
  | { kind: 'split'; dir: SplitDirection; children: GroupLayoutNode[]; sizes: number[] };

export interface GroupsState {
  groups: EditorGroup[];
  layout: GroupLayoutNode;
  focusedGroup: string;
}

/** Persisted form (WorkspaceData.groups). */
export type SerializedGroups = GroupsState;

export type SplitSide = 'left' | 'right' | 'up' | 'down';
export type DropZone = SplitSide | 'center';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A draggable boundary between children `index` and `index + 1` of the split at `path`. */
export interface SplitterInfo {
  path: number[];
  index: number;
  dir: SplitDirection;
  /** Rect of the whole split (fractions of the workspace), for converting pixels to size fractions. */
  splitRect: Rect;
  /** Position of the boundary: x for a row split, y for a column split (fractions). */
  at: number;
}

let groupSeq = 0;
export function newGroupId(): string {
  groupSeq++;
  return `g_${Date.now().toString(36)}${groupSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const sideAxis = (side: SplitSide): SplitDirection => (side === 'left' || side === 'right' ? 'row' : 'column');
const sideBefore = (side: SplitSide) => side === 'left' || side === 'up';

// ---------- layout tree ----------

/** Group ids in visual order (left to right, top to bottom). */
export function layoutGroupIds(node: GroupLayoutNode): string[] {
  return node.kind === 'group' ? [node.id] : node.children.flatMap(layoutGroupIds);
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

function fixSizes(sizes: unknown, n: number): number[] {
  if (!Array.isArray(sizes) || sizes.length !== n || sizes.some((s) => typeof s !== 'number' || !Number.isFinite(s) || s <= 0)) return equalSizes(n);
  const sum = (sizes as number[]).reduce((a, b) => a + b, 0);
  return (sizes as number[]).map((s) => s / sum);
}

/** Collapses single-child splits, merges nested splits of the same direction and repairs the sizes. */
function tidy(node: GroupLayoutNode): GroupLayoutNode | null {
  if (node.kind === 'group') return node;
  const sizes = fixSizes(node.sizes, node.children.length);
  const children: GroupLayoutNode[] = [];
  const out: number[] = [];
  node.children.forEach((c, i) => {
    const t = tidy(c);
    if (!t) return;
    if (t.kind === 'split' && t.dir === node.dir) {
      t.children.forEach((cc, j) => {
        children.push(cc);
        out.push(sizes[i] * t.sizes[j]);
      });
    } else {
      children.push(t);
      out.push(sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { kind: 'split', dir: node.dir, children, sizes: fixSizes(out, children.length) };
}

/** The layout without the group; its space goes to its neighbours. */
export function removeFromLayout(node: GroupLayoutNode, gid: string): GroupLayoutNode | null {
  if (node.kind === 'group') return node.id === gid ? null : node;
  const children: GroupLayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removeFromLayout(c, gid);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i] ?? 1);
    }
  });
  return tidy({ kind: 'split', dir: node.dir, children, sizes });
}

/** Adds `newGid` next to the group `targetGid` on `side`, halving the target's space. */
export function insertInLayout(node: GroupLayoutNode, targetGid: string, newGid: string, side: SplitSide): GroupLayoutNode {
  const dir = sideAxis(side);
  const leaf: GroupLayoutNode = { kind: 'group', id: newGid };
  const pair = (target: GroupLayoutNode): GroupLayoutNode => ({
    kind: 'split', dir, children: sideBefore(side) ? [leaf, target] : [target, leaf], sizes: [0.5, 0.5],
  });
  const visit = (n: GroupLayoutNode): GroupLayoutNode => {
    if (n.kind === 'group') return n.id === targetGid ? pair(n) : n;
    const idx = n.children.findIndex((c) => c.kind === 'group' && c.id === targetGid);
    if (idx >= 0 && n.dir === dir) {
      const children = [...n.children];
      const sizes = [...n.sizes];
      const half = sizes[idx] / 2;
      sizes[idx] = half;
      const at = sideBefore(side) ? idx : idx + 1;
      children.splice(at, 0, leaf);
      sizes.splice(at, 0, half);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(visit) };
  };
  return tidy(visit(node)) ?? leaf;
}

/** A layout naming exactly `ids` (unknown leaves dropped, missing groups appended side by side). */
export function normalizeLayout(node: unknown, ids: string[]): GroupLayoutNode {
  const want = new Set(ids);
  const seen = new Set<string>();
  const parse = (n: unknown, depth: number): GroupLayoutNode | null => {
    if (!n || typeof n !== 'object' || depth > 8) return null;
    const o = n as Record<string, unknown>;
    if (o.kind === 'group') {
      if (typeof o.id !== 'string' || !want.has(o.id) || seen.has(o.id)) return null;
      seen.add(o.id);
      return { kind: 'group', id: o.id };
    }
    if (o.kind === 'split' && (o.dir === 'row' || o.dir === 'column') && Array.isArray(o.children)) {
      const kids: GroupLayoutNode[] = [];
      const sizes: number[] = [];
      const raw = fixSizes(o.sizes, o.children.length);
      o.children.forEach((c, i) => {
        const p = parse(c, depth + 1);
        if (p) {
          kids.push(p);
          sizes.push(raw[i]);
        }
      });
      return tidy({ kind: 'split', dir: o.dir, children: kids, sizes });
    }
    return null;
  };
  let root = parse(node, 0);
  for (const id of ids) {
    if (seen.has(id)) continue;
    const leaf: GroupLayoutNode = { kind: 'group', id };
    if (!root) root = leaf;
    else if (root.kind === 'split' && root.dir === 'row') {
      const n = root.children.length + 1;
      root = { ...root, children: [...root.children, leaf], sizes: [...root.sizes.map((s) => (s * (n - 1)) / n), 1 / n] };
    } else root = { kind: 'split', dir: 'row', children: [root, leaf], sizes: [0.5, 0.5] };
  }
  return root ?? { kind: 'group', id: ids[0] ?? '' };
}

/** Rects of every group (fractions of the workspace) and the splitters between them. */
export function computeLayout(node: GroupLayoutNode): { rects: Record<string, Rect>; splitters: SplitterInfo[] } {
  const rects: Record<string, Rect> = {};
  const splitters: SplitterInfo[] = [];
  const visit = (n: GroupLayoutNode, r: Rect, path: number[]) => {
    if (n.kind === 'group') {
      rects[n.id] = r;
      return;
    }
    let offset = 0;
    n.children.forEach((c, i) => {
      const s = n.sizes[i];
      const cr: Rect = n.dir === 'row' ? { x: r.x + offset * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: s * r.h };
      offset += s;
      visit(c, cr, [...path, i]);
      if (i < n.children.length - 1) {
        splitters.push({ path, index: i, dir: n.dir, splitRect: r, at: n.dir === 'row' ? r.x + offset * r.w : r.y + offset * r.h });
      }
    });
  };
  visit(node, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { rects, splitters };
}

function nodeAt(node: GroupLayoutNode, path: number[]): GroupLayoutNode | null {
  let n: GroupLayoutNode = node;
  for (const i of path) {
    if (n.kind !== 'split' || !n.children[i]) return null;
    n = n.children[i];
  }
  return n;
}

function replaceAt(node: GroupLayoutNode, path: number[], fn: (n: GroupLayoutNode) => GroupLayoutNode): GroupLayoutNode {
  if (path.length === 0) return fn(node);
  if (node.kind !== 'split') return node;
  const [i, ...rest] = path;
  return { ...node, children: node.children.map((c, j) => (j === i ? replaceAt(c, rest, fn) : c)) };
}

/**
 * Sizes of the split at `path` with the boundary after child `index` moved by `delta` (a fraction of that split),
 * keeping both neighbours at least MIN_GROUP_FRACTION. `base` are the sizes when the drag started.
 */
export function resizeSizes(base: number[], index: number, delta: number): number[] {
  const sizes = [...base];
  const pairTotal = sizes[index] + sizes[index + 1];
  const min = Math.min(MIN_GROUP_FRACTION, pairTotal / 2);
  const a = Math.max(min, Math.min(pairTotal - min, sizes[index] + delta));
  sizes[index] = a;
  sizes[index + 1] = pairTotal - a;
  return sizes;
}

export function setSplitSizes(node: GroupLayoutNode, path: number[], sizes: number[]): GroupLayoutNode {
  const target = nodeAt(node, path);
  if (!target || target.kind !== 'split' || sizes.length !== target.children.length) return node;
  return replaceAt(node, path, (n) => (n.kind === 'split' ? { ...n, sizes: fixSizes(sizes, n.children.length) } : n));
}

export function splitSizesAt(node: GroupLayoutNode, path: number[]): number[] | null {
  const n = nodeAt(node, path);
  return n && n.kind === 'split' ? n.sizes : null;
}

/** The group next to `gid` in a direction (closest by centre), or null at the edge. */
export function groupInDirection(layout: GroupLayoutNode, gid: string, side: SplitSide): string | null {
  const { rects } = computeLayout(layout);
  const r = rects[gid];
  if (!r) return null;
  const eps = 1e-6;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, o] of Object.entries(rects)) {
    if (id === gid) continue;
    const overlapsY = o.y < r.y + r.h - eps && o.y + o.h > r.y + eps;
    const overlapsX = o.x < r.x + r.w - eps && o.x + o.w > r.x + eps;
    const ok =
      side === 'right' ? o.x >= r.x + r.w - eps && overlapsY
        : side === 'left' ? o.x + o.w <= r.x + eps && overlapsY
          : side === 'down' ? o.y >= r.y + r.h - eps && overlapsX
            : o.y + o.h <= r.y + eps && overlapsX;
    if (!ok) continue;
    const d = Math.hypot(o.x + o.w / 2 - cx, o.y + o.h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

// ---------- groups ----------

export interface NormalizeInput {
  tabIds: string[];
  activeId: string | null;
  groups?: EditorGroup[] | null;
  layout?: GroupLayoutNode | null;
  focusedGroup?: string | null;
  /** Most recently used tabs first: picks the active tab of a group that lost its active tab. */
  mru?: string[];
}

/** Repairs the groups for the current tabs (see the invariants at the top). */
export function normalizeGroups(input: NormalizeInput): GroupsState {
  const pos = new Map(input.tabIds.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const groupIds = new Set<string>();
  let groups: EditorGroup[] = [];
  for (const g of input.groups ?? []) {
    if (!g || typeof g.id !== 'string' || !g.id || groupIds.has(g.id) || !Array.isArray(g.tabIds)) continue;
    groupIds.add(g.id);
    const tabIds = g.tabIds.filter((id) => typeof id === 'string' && pos.has(id) && !seen.has(id) && (seen.add(id), true));
    groups.push({ id: g.id, tabIds, activeId: typeof g.activeId === 'string' ? g.activeId : null });
  }
  if (groups.length === 0) groups.push({ id: input.focusedGroup || newGroupId(), tabIds: [], activeId: null });

  // Tabs no group claims (new tabs, a workspace without groups) join the focused group.
  const unassigned = input.tabIds.filter((id) => !seen.has(id));
  if (unassigned.length) {
    const active = input.activeId && pos.has(input.activeId) ? input.activeId : null;
    const owner = active ? groups.find((g) => g.tabIds.includes(active)) : undefined;
    const target = owner ?? groups.find((g) => g.id === input.focusedGroup) ?? groups[0];
    target.tabIds = [...target.tabIds, ...unassigned];
  }
  for (const g of groups) g.tabIds.sort((a, b) => pos.get(a)! - pos.get(b)!);

  // Empty groups close (one group always remains).
  if (groups.length > 1) {
    const kept = groups.filter((g) => g.tabIds.length > 0);
    groups = kept.length ? kept : [groups[0]];
  }
  if (groups.length > MAX_GROUPS) {
    // More groups than allowed (a hand-edited workspace): the extra ones merge into the last kept group.
    const extra = groups.slice(MAX_GROUPS);
    groups = groups.slice(0, MAX_GROUPS);
    const last = groups[groups.length - 1];
    last.tabIds = [...last.tabIds, ...extra.flatMap((g) => g.tabIds)].sort((a, b) => pos.get(a)! - pos.get(b)!);
  }

  const mru = input.mru ?? [];
  for (const g of groups) {
    if (g.activeId && g.tabIds.includes(g.activeId)) continue;
    g.activeId = mru.find((id) => g.tabIds.includes(id)) ?? g.tabIds[0] ?? null;
  }

  let focusedGroup = groups.some((g) => g.id === input.focusedGroup) ? input.focusedGroup! : groups[0].id;
  const activeOwner = input.activeId ? groups.find((g) => g.tabIds.includes(input.activeId!)) : undefined;
  if (activeOwner) {
    focusedGroup = activeOwner.id;
    activeOwner.activeId = input.activeId;
  }

  const ids = groups.map((g) => g.id);
  const layout = normalizeLayout(input.layout ?? null, ids);
  // Visual order (left to right, top to bottom) is the order of "next group".
  const order = layoutGroupIds(layout);
  groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { groups, layout, focusedGroup };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameLayout(a: GroupLayoutNode, b: GroupLayoutNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'group') return a.id === (b as { id: string }).id;
  const s = b as Extract<GroupLayoutNode, { kind: 'split' }>;
  return a.dir === s.dir && a.children.length === s.children.length && a.sizes.every((x, i) => Math.abs(x - s.sizes[i]) < 1e-9)
    && a.children.every((c, i) => sameLayout(c, s.children[i]));
}

/** True when both describe the same groups (normalization would change nothing). */
export function sameGroups(a: GroupsState, b: GroupsState): boolean {
  return a.focusedGroup === b.focusedGroup && a.groups.length === b.groups.length
    && a.groups.every((g, i) => g.id === b.groups[i].id && g.activeId === b.groups[i].activeId && sameIds(g.tabIds, b.groups[i].tabIds))
    && sameLayout(a.layout, b.layout);
}

export function groupOf(groups: EditorGroup[], tabId: string): EditorGroup | undefined {
  return groups.find((g) => g.tabIds.includes(tabId));
}

/** Parses a persisted `groups` value defensively (anything unusable becomes "one group"). */
export function parseSerializedGroups(v: unknown): Partial<GroupsState> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const groups = Array.isArray(o.groups)
    ? o.groups
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
      .map((g) => ({
        id: typeof g.id === 'string' ? g.id : '',
        tabIds: Array.isArray(g.tabIds) ? g.tabIds.filter((x): x is string => typeof x === 'string') : [],
        activeId: typeof g.activeId === 'string' ? g.activeId : null,
      }))
      .filter((g) => g.id)
    : [];
  return {
    groups,
    layout: (o.layout as GroupLayoutNode | undefined) ?? undefined,
    focusedGroup: typeof o.focusedGroup === 'string' ? o.focusedGroup : undefined,
  };
}

// ---------- drag and drop ----------

/**
 * The drop zone under a pointer at (x, y), as fractions of a group's body: the outer third of an edge splits towards
 * that edge, the middle moves the tab into the group. Corners go to the nearer edge.
 */
export function dropZoneAt(x: number, y: number, allowSplit: boolean): DropZone {
  if (!allowSplit) return 'center';
  const edge = 0.3;
  const dl = x;
  const dr = 1 - x;
  const dt = y;
  const db = 1 - y;
  const m = Math.min(dl, dr, dt, db);
  if (m > edge) return 'center';
  if (m === dl) return 'left';
  if (m === dr) return 'right';
  if (m === dt) return 'up';
  return 'down';
}

/** Rect of the highlight for a zone (fractions of the group body). */
export function zoneRect(zone: DropZone): Rect {
  switch (zone) {
    case 'left': return { x: 0, y: 0, w: 0.5, h: 1 };
    case 'right': return { x: 0.5, y: 0, w: 0.5, h: 1 };
    case 'up': return { x: 0, y: 0, w: 1, h: 0.5 };
    case 'down': return { x: 0, y: 0.5, w: 1, h: 0.5 };
    default: return { x: 0, y: 0, w: 1, h: 1 };
  }
}

/**
 * A tab drag that ended outside the window with no drop target opens the tab in a new window. Chromium reports (0, 0)
 * when it does not know the position (some Linux drag backends): never treated as outside.
 */
export function isDragOutsideWindow(e: { clientX: number; clientY: number; dropEffect: string }, width: number, height: number): boolean {
  if (e.dropEffect !== 'none') return false;
  if (e.clientX === 0 && e.clientY === 0) return false;
  const margin = 4;
  return e.clientX < -margin || e.clientY < -margin || e.clientX > width + margin || e.clientY > height + margin;
}

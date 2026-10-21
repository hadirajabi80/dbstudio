// Export scene (docs/PLAN-M2.md section 3, "Export"): the whole diagram (not the viewport) as a flat display list of
// rectangles, text, paths and rings in diagram coordinates, built from the model — never from the DOM — so the PNG
// painter (exportPng.ts) and the SVG serialiser (exportSvg.ts) draw the same picture. Colours come from the theme
// tokens of the current theme (resolved once per export).
import { CARD, type CardGeom, type DiagramModel } from './model';
import type { EdgeGeom, Rect } from './edges';
import { diagramBounds } from './edges';

export type Role =
  | 'bg' | 'card' | 'cardGhost' | 'header' | 'stripTable' | 'stripView' | 'stripGhost' | 'title' | 'titleMuted'
  | 'col' | 'type' | 'badgePk' | 'badgeFk' | 'badgeText' | 'more' | 'sep' | 'edge' | 'edgeOptional' | 'edgeGhost' | 'edgeDisabled' | 'mark' | 'ring';

export type SceneItem =
  | { kind: 'rect'; role: Role; x: number; y: number; w: number; h: number; r?: number }
  | { kind: 'text'; role: Role; x: number; y: number; text: string; anchor?: 'start' | 'end' | 'middle' }
  | { kind: 'path'; role: Role; d: string }
  | { kind: 'circle'; role: Role; cx: number; cy: number; r: number };

export interface Scene {
  bounds: Rect;
  items: SceneItem[];
}

export interface SceneInput {
  model: DiagramModel;
  geom: ReadonlyMap<string, CardGeom>;
  positions: Readonly<Record<string, readonly [number, number]>>;
  edges: ReadonlyMap<string, EdgeGeom>;
  showTypes: boolean;
}

export const SCENE_PAD = 32;
const NAME_CHAR = 7;
const TYPE_CHAR = 6.2;
const TITLE_CHAR = 7.6;

/** Cuts text to roughly `maxW` px (estimated advance widths), adding an ellipsis. */
export function fit(text: string, maxW: number, charW: number): string {
  const max = Math.max(1, Math.floor(maxW / charW));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function buildScene(input: SceneInput): Scene {
  const { model, geom, positions, edges } = input;
  const b = diagramBounds(positions, geom, model.nodes.map((n) => n.key)) ?? { x: 0, y: 0, w: 0, h: 0 };
  // room for self-reference loops on the right
  const bounds: Rect = { x: b.x - SCENE_PAD, y: b.y - SCENE_PAD, w: b.w + SCENE_PAD * 2 + 60, h: b.h + SCENE_PAD * 2 };
  const items: SceneItem[] = [{ kind: 'rect', role: 'bg', x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }];

  for (const e of model.edges) {
    const g = edges.get(e.id);
    if (!g) continue;
    items.push({ kind: 'path', role: e.disabled ? 'edgeDisabled' : e.ghost ? 'edgeGhost' : e.optional ? 'edgeOptional' : 'edge', d: g.d });
    items.push({ kind: 'path', role: 'mark', d: g.marks });
    for (const r of g.rings) items.push({ kind: 'circle', role: 'ring', cx: r.cx, cy: r.cy, r: r.r });
  }

  for (const n of model.nodes) {
    const p = positions[n.key];
    const g = geom.get(n.key);
    if (!p || !g) continue;
    const [x, y] = p;
    items.push({ kind: 'rect', role: n.ghost ? 'cardGhost' : 'card', x, y, w: g.w, h: g.h, r: 8 });
    items.push({ kind: 'rect', role: n.ghost ? 'stripGhost' : n.type === 'table' ? 'stripTable' : 'stripView', x: x + 1, y: y + 1, w: 3, h: CARD.headerH - 2, r: 1.5 });
    const prefix = n.label !== n.name ? `${n.schema}.` : '';
    const titleW = g.w - 28;
    if (prefix) {
      const pre = fit(prefix, titleW * 0.45, TITLE_CHAR);
      items.push({ kind: 'text', role: 'titleMuted', x: x + 14, y: y + CARD.headerH / 2 + 4.5, text: pre });
      items.push({ kind: 'text', role: 'title', x: x + 14 + pre.length * TITLE_CHAR, y: y + CARD.headerH / 2 + 4.5, text: fit(n.name, titleW - pre.length * TITLE_CHAR, TITLE_CHAR) });
    } else items.push({ kind: 'text', role: 'title', x: x + 14, y: y + CARD.headerH / 2 + 4.5, text: fit(n.name, titleW, TITLE_CHAR) });
    if (!g.rows.length && !g.moreRow) continue;
    items.push({ kind: 'path', role: 'sep', d: `M${x} ${y + CARD.headerH}H${x + g.w}` });
    g.rows.forEach((r, i) => {
      const ry = y + CARD.headerH + CARD.padY + i * CARD.rowH;
      const cy = ry + CARD.rowH / 2;
      if (r.col.pk || r.col.fk) {
        const role = r.col.pk ? 'badgePk' : 'badgeFk';
        items.push({ kind: 'rect', role, x: x + 10, y: cy - 6.5, w: 20, h: 13, r: 3 });
        items.push({ kind: 'text', role: 'badgeText', x: x + 20, y: cy + 3, text: r.col.pk ? 'PK' : 'FK', anchor: 'middle' });
      }
      const typeW = input.showTypes ? Math.min(g.w * 0.45, r.col.type.length * TYPE_CHAR + 4) : 0;
      const name = r.col.name + (r.col.nullable ? '?' : '');
      items.push({ kind: 'text', role: 'col', x: x + 38, y: cy + 4, text: fit(name, g.w - 50 - typeW - 8, NAME_CHAR) });
      if (input.showTypes) items.push({ kind: 'text', role: 'type', x: x + g.w - 12, y: cy + 4, text: fit(r.col.type, typeW, TYPE_CHAR), anchor: 'end' });
    });
    if (g.moreRow) {
      const cy = y + CARD.headerH + CARD.padY + g.rows.length * CARD.rowH + CARD.rowH / 2;
      items.push({ kind: 'text', role: 'more', x: x + 38, y: cy + 4, text: `+${g.more} more` });
    }
  }
  return { bounds, items };
}

/** Theme token values an export needs, read from the document (current theme). */
export interface SceneTheme {
  bg: string; panel: string; sunken: string; border: string; borderStrong: string; borderSubtle: string;
  fg: string; muted: string; accent: string; table: string; view: string; key: string; fk: string;
  fontUi: string; fontMono: string;
}

const TOKENS: Record<keyof SceneTheme, string> = {
  bg: '--bg-app', panel: '--bg-panel', sunken: '--bg-sunken', border: '--border', borderStrong: '--border-strong', borderSubtle: '--border-subtle',
  fg: '--fg', muted: '--fg-muted', accent: '--accent', table: '--obj-table', view: '--obj-view', key: '--obj-key', fk: '--obj-fk',
  fontUi: '--font-ui', fontMono: '--font-mono',
};

/** Resolves the tokens on <html> (falls back to plain named colours where a token is missing, e.g. in tests). */
export function readSceneTheme(root: Element | null = typeof document !== 'undefined' ? document.documentElement : null): SceneTheme {
  const cs = root && typeof getComputedStyle !== 'undefined' ? getComputedStyle(root) : null;
  const out = {} as SceneTheme;
  for (const [k, token] of Object.entries(TOKENS) as [keyof SceneTheme, string][]) {
    const v = cs?.getPropertyValue(token).trim();
    out[k] = v || (k === 'fontUi' ? 'sans-serif' : k === 'fontMono' ? 'monospace' : k === 'bg' || k === 'panel' || k === 'sunken' ? 'white' : k === 'accent' || k === 'table' ? 'royalblue' : 'gray');
  }
  return out;
}

export interface RoleStyle { fill?: string; stroke?: string; width?: number; dash?: number[]; font?: string; color?: string; weight?: number; size?: number; mono?: boolean }

export function roleStyles(t: SceneTheme): Record<Role, RoleStyle> {
  return {
    bg: { fill: t.bg },
    card: { fill: t.panel, stroke: t.border, width: 1 },
    cardGhost: { fill: t.sunken, stroke: t.borderStrong, width: 1, dash: [4, 3] },
    header: { fill: t.sunken },
    stripTable: { fill: t.table },
    stripView: { fill: t.view },
    stripGhost: { fill: t.borderStrong },
    title: { color: t.fg, weight: 600, size: 13 },
    titleMuted: { color: t.muted, weight: 400, size: 13 },
    col: { color: t.fg, weight: 400, size: 12 },
    type: { color: t.muted, weight: 400, size: 11, mono: true },
    badgePk: { fill: t.key },
    badgeFk: { fill: t.fk },
    badgeText: { color: t.panel, weight: 700, size: 8.5 },
    more: { color: t.muted, weight: 400, size: 11.5 },
    sep: { stroke: t.borderSubtle, width: 1 },
    edge: { stroke: t.muted, width: 1.4 },
    edgeOptional: { stroke: t.muted, width: 1.4, dash: [5, 4] },
    edgeGhost: { stroke: t.borderStrong, width: 1.2, dash: [3, 3] },
    edgeDisabled: { stroke: t.muted, width: 1.8, dash: [1, 4] },
    mark: { stroke: t.muted, width: 1.4 },
    ring: { fill: t.panel, stroke: t.muted, width: 1.4 },
  };
}

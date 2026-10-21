// All relationship lines in one SVG inside the transformed layer (diagram coordinates; strokes do not scale with the
// zoom). Each edge is memoised on its geometry and state, so moving a card re-renders only its own edges.
import { memo } from 'react';
import type { EdgeGeom } from './edges';
import type { ErEdge } from './model';

interface EdgeProps {
  edge: ErEdge;
  geom: EdgeGeom;
  hl: boolean;
  dim: boolean;
}

const Edge = memo(function Edge({ edge, geom, hl, dim }: EdgeProps) {
  const cls = `er-edge${edge.optional ? ' optional' : ''}${edge.ghost ? ' ghost' : ''}${edge.disabled ? ' disabled' : ''}${hl ? ' hl' : ''}${dim ? ' dim' : ''}`;
  return (
    <g className={cls} data-edge={edge.id}>
      <path className="er-edge-hit" d={geom.d} data-edge={edge.id} />
      <path className="er-edge-line" d={geom.d} vectorEffect="non-scaling-stroke" />
      <path className="er-edge-mark" d={geom.marks} vectorEffect="non-scaling-stroke" />
      {geom.rings.map((r, i) => <circle key={i} className="er-edge-ring" cx={r.cx} cy={r.cy} r={r.r} vectorEffect="non-scaling-stroke" />)}
    </g>
  );
});

export interface EdgeLayerProps {
  ids: readonly string[];
  edges: ReadonlyMap<string, EdgeGeom>;
  byId: ReadonlyMap<string, ErEdge>;
  /** Hovered card: its edges highlight, the others fade. */
  hoverKey: string | null;
  hoverEdge: string | null;
  selection: ReadonlySet<string>;
  /** FK drag preview line (diagram coordinates). */
  draft: { x1: number; y1: number; x2: number; y2: number } | null;
}

export function EdgeLayer({ ids, edges, byId, hoverKey, hoverEdge, selection, draft }: EdgeLayerProps) {
  return (
    <svg className="er-edges" width="1" height="1" aria-hidden="true">
      {ids.map((id) => {
        const e = byId.get(id);
        const g = edges.get(id);
        if (!e || !g) return null;
        const touches = (k: string | null) => !!k && (e.from === k || e.to === k);
        const hl = hoverEdge === id || touches(hoverKey) || (selection.size > 0 && (selection.has(e.from) || selection.has(e.to)));
        const dim = (!!hoverKey && !touches(hoverKey)) || (!!hoverEdge && hoverEdge !== id);
        return <Edge key={id} edge={e} geom={g} hl={hl} dim={dim} />;
      })}
      {draft && <line className="er-edge-draft" x1={draft.x1} y1={draft.y1} x2={draft.x2} y2={draft.y2} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

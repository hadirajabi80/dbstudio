// Minimap (bottom-right, 180 × 120): every card as a rectangle and the viewport as a frame; click or drag to move the
// viewport there. The frame is updated imperatively by the canvas while panning (no React render per frame).
import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { diagramBounds, type Rect } from './edges';
import type { CardGeom, ErNode } from './model';
import { worldViewport, type Transform } from './viewport';

export const MINIMAP_W = 180;
export const MINIMAP_H = 120;

export interface MinimapHandle {
  update(t: Transform, viewW: number, viewH: number): void;
}

interface Props {
  nodes: readonly ErNode[];
  positions: Readonly<Record<string, readonly [number, number]>>;
  geom: ReadonlyMap<string, CardGeom>;
  selection: ReadonlySet<string>;
  /** Centre the viewport on a diagram point. */
  onNavigate(wx: number, wy: number): void;
}

interface Frame { b: Rect; s: number; ox: number; oy: number }

function frameOf(bounds: Rect | null): Frame | null {
  if (!bounds) return null;
  const pad = 40;
  const b = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  const s = Math.min(MINIMAP_W / b.w, MINIMAP_H / b.h);
  return { b, s, ox: (MINIMAP_W - b.w * s) / 2, oy: (MINIMAP_H - b.h * s) / 2 };
}

export const Minimap = memo(forwardRef<MinimapHandle, Props>(function Minimap({ nodes, positions, geom, selection, onNavigate }, ref) {
  const viewRef = useRef<SVGRectElement>(null);
  const frame = useMemo(() => frameOf(diagramBounds(positions, geom, nodes.map((n) => n.key))), [nodes, positions, geom]);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const last = useRef<{ t: Transform; w: number; h: number } | null>(null);

  const paint = () => {
    const el = viewRef.current;
    const f = frameRef.current;
    const l = last.current;
    if (!el || !f || !l) return;
    const v = worldViewport(l.t, l.w, l.h);
    // clamp the frame to the minimap so a far-away viewport still shows where it is
    const x = Math.max(0, Math.min(MINIMAP_W - 4, f.ox + (v.x - f.b.x) * f.s));
    const y = Math.max(0, Math.min(MINIMAP_H - 4, f.oy + (v.y - f.b.y) * f.s));
    const w = Math.max(4, Math.min(MINIMAP_W - x, v.w * f.s));
    const h = Math.max(4, Math.min(MINIMAP_H - y, v.h * f.s));
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
  };

  useImperativeHandle(ref, () => ({
    update(t, w, h) {
      last.current = { t, w, h };
      paint();
    },
  }));
  // repaint the frame after the cards changed (new bounds)
  useLayoutEffect(paint);

  const navigate = (e: ReactPointerEvent<SVGSVGElement>) => {
    const f = frameRef.current;
    if (!f) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / Math.max(1, r.width)) * MINIMAP_W;
    const sy = ((e.clientY - r.top) / Math.max(1, r.height)) * MINIMAP_H;
    onNavigate(f.b.x + (sx - f.ox) / f.s, f.b.y + (sy - f.oy) / f.s);
  };

  if (!frame) return null;
  return (
    <svg
      className="er-minimap"
      width={MINIMAP_W}
      height={MINIMAP_H}
      viewBox={`0 0 ${MINIMAP_W} ${MINIMAP_H}`}
      role="img"
      aria-label="Minimap: click or drag to move the view"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        navigate(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) navigate(e);
      }}
    >
      {nodes.map((n) => {
        const p = positions[n.key];
        const g = geom.get(n.key);
        if (!p || !g) return null;
        return (
          <rect
            key={n.key}
            className={`er-mm-card${n.ghost ? ' ghost' : ''}${selection.has(n.key) ? ' sel' : ''}`}
            x={frame.ox + (p[0] - frame.b.x) * frame.s}
            y={frame.oy + (p[1] - frame.b.y) * frame.s}
            width={Math.max(1.5, g.w * frame.s)}
            height={Math.max(1.5, g.h * frame.s)}
          />
        );
      })}
      <rect ref={viewRef} className="er-mm-view" x={0} y={0} width={0} height={0} />
    </svg>
  );
}));

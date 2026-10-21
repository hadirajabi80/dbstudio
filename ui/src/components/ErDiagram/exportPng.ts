// PNG export (docs/PLAN-M2.md section 3): paints the export scene on an offscreen canvas at 2× (less for very large
// diagrams, so the bitmap stays within browser canvas limits), in the current theme's colours.
import { buildScene, readSceneTheme, roleStyles, type SceneInput, type SceneTheme } from './scene';

/** Browser canvas limits: 16 384 px per side, ~268 M pixels in Chromium. */
export const MAX_SIDE = 16_000;
export const MAX_PIXELS = 200_000_000;

/** Pixel ratio for a diagram of w × h (2× when it fits, else the largest that does). */
export function exportScale(w: number, h: number, preferred = 2): number {
  const bySide = MAX_SIDE / Math.max(1, w, h);
  const byArea = Math.sqrt(MAX_PIXELS / Math.max(1, w * h));
  return Math.max(0.1, Math.min(preferred, bySide, byArea));
}

export function paintScene(ctx: CanvasRenderingContext2D, input: SceneInput, theme: SceneTheme, scale: number): void {
  const scene = buildScene(input);
  const styles = roleStyles(theme);
  const b = scene.bounds;
  ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);
  ctx.textBaseline = 'alphabetic';
  for (const it of scene.items) {
    const s = styles[it.role];
    ctx.setLineDash(s.dash ?? []);
    ctx.lineWidth = s.width ?? 1;
    ctx.lineCap = 'round';
    if (it.kind === 'rect') {
      ctx.beginPath();
      if (it.r && 'roundRect' in ctx) ctx.roundRect(it.x, it.y, it.w, it.h, it.r);
      else ctx.rect(it.x, it.y, it.w, it.h);
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      if (s.stroke) {
        ctx.strokeStyle = s.stroke;
        ctx.stroke();
      }
    } else if (it.kind === 'text') {
      ctx.font = `${s.weight ?? 400} ${s.size ?? 12}px ${s.mono ? theme.fontMono : theme.fontUi}`;
      ctx.fillStyle = s.color ?? theme.fg;
      ctx.textAlign = it.anchor === 'end' ? 'right' : it.anchor === 'middle' ? 'center' : 'left';
      ctx.fillText(it.text, it.x, it.y);
    } else if (it.kind === 'path') {
      if (!it.d) continue;
      const p = new Path2D(it.d);
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fill(p);
      }
      if (s.stroke) {
        ctx.strokeStyle = s.stroke;
        ctx.stroke(p);
      }
    } else {
      ctx.beginPath();
      ctx.arc(it.cx, it.cy, it.r, 0, Math.PI * 2);
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      if (s.stroke) {
        ctx.strokeStyle = s.stroke;
        ctx.stroke();
      }
    }
  }
}

/** Renders the whole diagram to a PNG blob. */
export async function renderPng(input: SceneInput, theme: SceneTheme = readSceneTheme()): Promise<Blob> {
  const { bounds } = buildScene(input);
  const scale = exportScale(bounds.w, bounds.h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.w * scale);
  canvas.height = Math.ceil(bounds.h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  if (document.fonts?.ready) await document.fonts.ready;
  paintScene(ctx, input, theme, scale);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the PNG'))), 'image/png'));
}

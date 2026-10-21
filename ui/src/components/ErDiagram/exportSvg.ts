// SVG export (docs/PLAN-M2.md section 3): the export scene serialised as plain SVG (no foreignObject), with an embedded
// stylesheet built from the current theme's tokens, so the file looks like the diagram in either theme.
import { buildScene, readSceneTheme, roleStyles, type Role, type SceneInput, type SceneTheme } from './scene';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 10) / 10).toString();

function css(theme: SceneTheme): string {
  const styles = roleStyles(theme);
  const rules: string[] = [];
  for (const [role, s] of Object.entries(styles) as [Role, ReturnType<typeof roleStyles>[Role]][]) {
    const p: string[] = [];
    if (s.color) p.push(`fill:${s.color}`);
    else p.push(`fill:${s.fill ?? 'none'}`);
    if (s.stroke) p.push(`stroke:${s.stroke}`, `stroke-width:${s.width ?? 1}`);
    if (s.dash) p.push(`stroke-dasharray:${s.dash.join(' ')}`);
    if (s.size) p.push(`font-size:${s.size}px`, `font-weight:${s.weight ?? 400}`, `font-family:${s.mono ? theme.fontMono : theme.fontUi}`);
    if (role === 'mark' || role.startsWith('edge')) p.push('stroke-linecap:round', 'fill:none');
    rules.push(`.${role}{${p.join(';')}}`);
  }
  return rules.join('\n');
}

/** The whole diagram as an SVG document string. */
export function buildSvg(input: SceneInput, theme: SceneTheme = readSceneTheme()): string {
  const scene = buildScene(input);
  const { bounds: b } = scene;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(b.w)}" height="${Math.ceil(b.h)}" viewBox="${n(b.x)} ${n(b.y)} ${n(b.w)} ${n(b.h)}">`,
    `<style>\n${css(theme)}\n</style>`,
  ];
  for (const it of scene.items) {
    switch (it.kind) {
      case 'rect':
        out.push(`<rect class="${it.role}" x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}"${it.r ? ` rx="${it.r}"` : ''}/>`);
        break;
      case 'text':
        out.push(`<text class="${it.role}" x="${n(it.x)}" y="${n(it.y)}"${it.anchor && it.anchor !== 'start' ? ` text-anchor="${it.anchor}"` : ''}>${esc(it.text)}</text>`);
        break;
      case 'path':
        if (it.d) out.push(`<path class="${it.role}" d="${it.d}"/>`);
        break;
      case 'circle':
        out.push(`<circle class="${it.role}" cx="${n(it.cx)}" cy="${n(it.cy)}" r="${n(it.r)}"/>`);
        break;
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseTokenBlocks } from '../index';
import { RowlitMark } from './RowlitMark';

const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(p: string, enc: 'utf8'): string };
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const RAW = parseTokenBlocks(nodeFs.readFileSync(`${cwd}/src/theme/tokens.css`, 'utf8'));

describe('RowlitMark', () => {
  it('is decorative by default and an image with a name when titled', () => {
    const { container, rerender } = render(<RowlitMark size={18} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('18');
    rerender(<RowlitMark size={40} title="Rowlit" />);
    expect(screen.getByRole('img', { name: 'Rowlit' })).toBeInTheDocument();
  });

  it('draws three rows, the middle one lit, from the --brand-mark-* tokens only', () => {
    const { container } = render(<RowlitMark />);
    const rows = [...container.querySelectorAll('rect')].slice(1);
    expect(rows.map((r) => r.getAttribute('y'))).toEqual(['8', '20', '14']);
    expect(rows[2].getAttribute('fill')).toMatch(/^url\(#rowlit-lit-/);
    const stops = [...container.querySelectorAll('stop')].map((s) => s.getAttribute('style'));
    expect(stops.every((s) => /var\(--brand-mark-/.test(s ?? ''))).toBe(true);
  });

  it('gives every mark its own gradient ids (several marks on one page)', () => {
    const { container } = render(<><RowlitMark /><RowlitMark /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('uses the same colours as the app icon (desktop/build/make-icon.mjs) in both themes', () => {
    const src = nodeFs.readFileSync(`${cwd}/../desktop/build/make-icon.mjs`, 'utf8');
    const palette = (key: string) => new RegExp(`\\b${key}: '(#[0-9a-f]{6})'`).exec(src)?.[1];
    for (const theme of ['light', 'dark'] as const) {
      const t = RAW[theme];
      expect(t['--brand-mark-tile-top']).toBe(palette('bgTop'));
      expect(t['--brand-mark-tile-bottom']).toBe(palette('bgBottom'));
      expect(t['--brand-mark-row']).toBe(palette('rowSmall'));
      expect(t['--brand-mark-lit-start']).toBe(palette('litStart'));
      expect(t['--brand-mark-lit-end']).toBe(palette('litEnd'));
      expect(t['--brand-mark-rim']).toBeTruthy();
    }
  });
});

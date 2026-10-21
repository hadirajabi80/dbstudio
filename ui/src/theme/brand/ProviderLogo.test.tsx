import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '../../api/types';
import { PROVIDER_LABEL } from '../../components/common/icons';
import { contrast, parseTokenBlocks, resolveTokens } from '../index';
import { BRAND_LOGOS } from './logos';
import { ProviderLogo } from './ProviderLogo';

// Typed as a Record so a new ProviderId fails to compile until it is listed here (and then needs a logo below).
const ALL: Record<ProviderId, true> = { sqlserver: true, oracle: true, sqlite: true, postgresql: true, redis: true, mongodb: true, kafka: true };
const IDS = Object.keys(ALL) as ProviderId[];

const nodeFs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(p: string, enc: 'utf8'): string };
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const RAW = parseTokenBlocks(nodeFs.readFileSync(`${cwd}/src/theme/tokens.css`, 'utf8'));
const TOKENS = { light: resolveTokens(RAW.light), dark: resolveTokens(RAW.dark) };

describe('ProviderLogo', () => {
  it('has a logo with a label and a viewBox for every ProviderId', () => {
    expect(Object.keys(BRAND_LOGOS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const logo = BRAND_LOGOS[id];
      expect(logo.label, id).toBe(PROVIDER_LABEL[id]);
      expect(logo.viewBox, id).toMatch(/^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/);
      expect(logo.shape.length, id).toBeGreaterThan(0);
    }
  });

  it('renders each logo as filled artwork at the requested size, decorative by default', () => {
    for (const id of IDS) {
      const { container, unmount } = render(<ProviderLogo providerId={id} size={14} />);
      const box = container.firstElementChild as HTMLElement;
      expect(box, id).toHaveClass('provider-logo', `provider-logo-${id}`);
      expect(box, id).toHaveAttribute('aria-hidden', 'true');
      expect(box.style.width, id).toBe('14px');
      expect(box.style.height, id).toBe('14px');
      const svg = box.querySelector('svg')!;
      expect(svg, id).toHaveAttribute('viewBox', BRAND_LOGOS[id].viewBox);
      expect(svg, id).toHaveAttribute('width', '14');
      expect(svg.querySelectorAll('path').length, id).toBeGreaterThan(0);
      unmount();
    }
  });

  it('is an image named by `title` when it stands alone', () => {
    render(<ProviderLogo providerId="kafka" size={32} title="Kafka" />);
    expect(screen.getByRole('img', { name: 'Kafka' })).toHaveClass('provider-logo-kafka');
  });

  it('gives every instance its own gradient id (an id in a hidden tab must not break the others)', () => {
    const { container } = render(<><ProviderLogo providerId="sqlite" /><ProviderLogo providerId="sqlite" /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const g of container.querySelectorAll('linearGradient')) expect(container.querySelector(`[fill="url(#${g.id})"]`)).not.toBeNull();
  });

  it('falls back to a generic glyph for an unknown provider', () => {
    const { container } = render(<ProviderLogo providerId="" />);
    expect(container.querySelector('svg.lucide')).not.toBeNull();
  });

  it('keeps the colours that carry each silhouette at >= 3:1 on the panels in both themes', () => {
    const failures: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      const t = TOKENS[theme];
      for (const id of IDS) {
        for (const c of BRAND_LOGOS[id].shape) {
          const fg = c.startsWith('--') ? t[c] : c;
          expect(fg, `${c} (${theme})`).toBeTruthy();
          for (const bg of ['--bg-panel', '--bg-app', '--bg-elevated']) {
            const r = contrast(fg, t[bg], t['--bg-panel']);
            if (r < 3) failures.push(`${theme} ${id}: ${c} on ${bg} = ${r.toFixed(2)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

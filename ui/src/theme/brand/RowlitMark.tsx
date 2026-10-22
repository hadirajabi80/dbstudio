import { useId } from 'react';

/**
 * The Rowlit mark: three table rows on a navy tile, the middle row lit (amber to coral). The same artwork as the app
 * icon (desktop/build/make-icon.mjs, pixel-hinted 32 px grid), drawn from the --brand-mark-* design tokens so the
 * title bar, welcome screen and settings show exactly the icon the OS shows. Decorative unless `title` is given.
 */
export function RowlitMark({ size = 18, title, className }: { size?: number; title?: string; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const tile = `rowlit-tile-${uid}`;
  const lit = `rowlit-lit-${uid}`;
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };
  return (
    <svg className={`rowlit-mark${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 32 32" {...a11y}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--brand-mark-tile-top)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-mark-tile-bottom)' }} />
        </linearGradient>
        <linearGradient id={lit} gradientUnits="userSpaceOnUse" x1="6" y1="0" x2="26" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--brand-mark-lit-start)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-mark-lit-end)' }} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill={`url(#${tile})`} strokeWidth="1" className="rowlit-mark-tile" />
      <rect x="6" y="8" width="20" height="4" rx="2" className="rowlit-mark-row" />
      <rect x="6" y="20" width="20" height="4" rx="2" className="rowlit-mark-row" />
      <rect x="6" y="14" width="20" height="4" rx="2" fill={`url(#${lit})`} />
    </svg>
  );
}

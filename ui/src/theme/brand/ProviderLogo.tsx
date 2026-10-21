import { useId } from 'react';
import { Database } from 'lucide-react';
import type { ProviderId } from '../../api/types';
import { connColorCss } from '../connColors';
import { BRAND_LOGOS } from './logos';

/**
 * A connection type's product logo (theme/brand/logos.tsx), drawn in a `size` px square.
 *
 * Decorative by default (`aria-hidden`): every call site puts the connection or product name next to it. Pass `title`
 * when the logo stands alone; it then becomes an image with that accessible name. `color` (a stored connection
 * colour) draws the connection colour as a ring around the logo, as the connections panel does.
 * An unknown provider id falls back to a generic database glyph.
 */
export function ProviderLogo({ providerId, size = 16, title, color, className }: {
  providerId: ProviderId | string;
  size?: number;
  title?: string;
  color?: string | null;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const logo = BRAND_LOGOS[providerId as ProviderId] as (typeof BRAND_LOGOS)[ProviderId] | undefined;
  const ring = connColorCss(color);
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };
  return (
    <span
      className={`provider-logo${logo ? ` provider-logo-${providerId}` : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, boxShadow: ring ? `0 0 0 2px var(--bg-panel), 0 0 0 3.5px ${ring}` : undefined }}
      data-provider={providerId}
      title={title}
      {...a11y}
    >
      {logo ? (
        <svg viewBox={logo.viewBox} width={size} height={size} focusable="false" aria-hidden="true">
          {logo.bold && size <= 24 ? (
            <g style={{ stroke: logo.bold.stroke, strokeWidth: logo.bold.width, strokeLinejoin: 'round' }}>{logo.paint(uid)}</g>
          ) : (
            logo.paint(uid)
          )}
        </svg>
      ) : (
        <Database size={size} strokeWidth={1.5} aria-hidden="true" />
      )}
    </span>
  );
}

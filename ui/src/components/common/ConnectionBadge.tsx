import type { ConnectionProfile } from '../../api/types';
import { CONNECTION_PALETTE, connColorCss, connColorName } from '../../theme/connColors';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';

export function ColorDot({ color, size = 8 }: { color: string | null | undefined; size?: number }) {
  const css = connColorCss(color);
  return (
    <span
      className={`color-dot${css ? '' : ' empty'}`}
      style={{ width: size, height: size, background: css }}
      aria-hidden="true"
      title={connColorName(color) ?? undefined}
    />
  );
}

/** Connection colour tag + provider + name, used on tabs, the toolbar and the status bar. */
export function ConnectionBadge({ conn }: { conn: ConnectionProfile | undefined }) {
  if (!conn) return <span className="conn-badge muted">No connection</span>;
  return (
    <span className="conn-badge">
      <ProviderLogo providerId={conn.providerId} color={conn.color} size={14} />
      <span className="conn-badge-name">{conn.name}</span>
      {conn.readOnly && <span className="pill pill-muted">read-only</span>}
    </span>
  );
}

/** Stored values of the connection colour palette (theme/connColors.ts). */
export const CONNECTION_COLORS = CONNECTION_PALETTE.map((p) => p.hex);

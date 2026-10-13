import type { ConnectionProfile } from '../../api/types';
import { ProviderIcon } from './icons';

export function ColorDot({ color, size = 8 }: { color: string | null | undefined; size?: number }) {
  return <span className={`color-dot${color ? '' : ' empty'}`} style={{ width: size, height: size, background: color ?? undefined }} aria-hidden="true" />;
}

/** Connection colour tag + provider + name, used on tabs, the toolbar and the status bar. */
export function ConnectionBadge({ conn }: { conn: ConnectionProfile | undefined }) {
  if (!conn) return <span className="conn-badge muted">No connection</span>;
  return (
    <span className="conn-badge">
      <ProviderIcon providerId={conn.providerId} color={conn.color} size={14} />
      <span className="conn-badge-name">{conn.name}</span>
      {conn.readOnly && <span className="pill pill-muted">read-only</span>}
    </span>
  );
}

export const CONNECTION_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#8d8d8d'];

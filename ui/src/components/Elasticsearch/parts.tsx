// Small building blocks shared by the Elasticsearch views.
import { Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { isApiError } from '../../api/client';
import type { EsErrorDetail, EsHealth } from '../../api/types.es';
import { getConnection } from '../../store/connections';

export function ViewHeader({ title, subtitle, readOnly, badge, children }: { title: ReactNode; subtitle?: ReactNode; readOnly?: boolean; badge?: ReactNode; children?: ReactNode }) {
  return (
    <div className="es-header">
      <div className="es-title">
        <span className="es-title-text">{title}</span>
        {badge}
        {subtitle && <span className="es-subtitle">{subtitle}</span>}
        {readOnly && (
          <span className="pill pill-muted es-ro" title="Read-only connection: document writes, index changes, aliases, reindex and import are disabled">
            <Lock size={12} aria-hidden /> read-only
          </span>
        )}
      </div>
      <div className="es-actions">{children}</div>
    </div>
  );
}

export function RefreshButton({ onClick, busy, label = 'Refresh' }: { onClick(): void; busy?: boolean; label?: string }) {
  return (
    <button type="button" className="btn btn-xs" onClick={onClick} disabled={busy} title={label}>
      <RefreshCw size={13} className={busy ? 'spin' : undefined} aria-hidden /> {label}
    </button>
  );
}

export function Banner({ tone = 'error', children, actions }: { tone?: 'error' | 'warn' | 'info'; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`es-banner es-banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone !== 'info' && <TriangleAlert size={14} aria-hidden />}
      <span className="es-banner-text">{children}</span>
      {actions}
    </div>
  );
}

export function Tile({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' | 'ok'; sub?: ReactNode }) {
  return (
    <div className={`es-tile${tone ? ` es-tile-${tone}` : ''}`} role="listitem">
      <div className="es-tile-value">{value}</div>
      <div className="es-tile-label">{label}</div>
      {sub && <div className="es-tile-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="es-empty">{children}</div>;
}

export function HealthDot({ health, label }: { health: EsHealth | null | undefined; label?: boolean }) {
  const h = health ?? 'unknown';
  return (
    <span className={`es-health es-health-${h}`} title={`Health: ${h}`}>
      <span className="es-health-dot" aria-hidden />
      {label ? h : <span className="sr-only">{h}</span>}
    </span>
  );
}

/** A thin usage bar (heap, disk). */
export function Meter({ value, label }: { value: number | null; label?: string }) {
  if (value == null) return <span className="muted">—</span>;
  const tone = value >= 90 ? 'danger' : value >= 75 ? 'warn' : 'ok';
  return (
    <span className="es-meter" title={label ?? `${Math.round(value)}%`}>
      <span className={`es-meter-bar es-meter-${tone}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      <span className="es-meter-text">{Math.round(value)}%</span>
    </span>
  );
}

/** Error text with the Elasticsearch error type and root cause when the engine sent them. */
export function esErrorText(e: unknown): string {
  if (isApiError(e)) {
    const d = e.detail as Partial<EsErrorDetail> | undefined;
    if (d?.rootCause && !e.message.includes(d.rootCause)) return `${e.message} (root cause: ${d.rootCause})`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 409 version conflict of an optimistic-concurrency write. */
export function isVersionConflict(e: unknown): boolean {
  return isApiError(e) && (e.status === 409 || (e.detail as Partial<EsErrorDetail> | undefined)?.esType === 'version_conflict_engine_exception');
}

export function readOnlyReason(cid: string): string | null {
  const c = getConnection(cid);
  return c?.readOnly ? `“${c.name}” is read-only` : null;
}

export function FlavorBadge({ flavor, version }: { flavor: 'elasticsearch' | 'opensearch'; version?: string | null }) {
  return <span className={`es-flavor es-flavor-${flavor}`}>{flavor === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'}{version ? ` ${version}` : ''}</span>;
}

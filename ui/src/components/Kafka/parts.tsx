// Small building blocks shared by the Kafka views.
import { Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function ViewHeader({ title, subtitle, readOnly, children }: { title: ReactNode; subtitle?: ReactNode; readOnly?: boolean; children?: ReactNode }) {
  return (
    <div className="kafka-header">
      <div className="kafka-title">
        <span className="kafka-title-text">{title}</span>
        {subtitle && <span className="kafka-subtitle">{subtitle}</span>}
        {readOnly && (
          <span className="pill pill-muted kafka-ro" title="Read-only connection: produce, create, delete and offset reset are disabled">
            <Lock size={12} aria-hidden /> read-only
          </span>
        )}
      </div>
      <div className="kafka-actions">{children}</div>
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
    <div className={`kafka-banner kafka-banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone !== 'info' && <TriangleAlert size={14} aria-hidden />}
      <span className="kafka-banner-text">{children}</span>
      {actions}
    </div>
  );
}

export function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' | 'ok' }) {
  return (
    <div className={`kafka-tile${tone ? ` kafka-tile-${tone}` : ''}`}>
      <div className="kafka-tile-value">{value}</div>
      <div className="kafka-tile-label">{label}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="kafka-empty">{children}</div>;
}

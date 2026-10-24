// Small building blocks shared by the ClickHouse views.
import { Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function ViewHeader({ title, subtitle, readOnly, children }: { title: ReactNode; subtitle?: ReactNode; readOnly?: boolean; children?: ReactNode }) {
  return (
    <div className="ch-header">
      <div className="ch-title">
        <span className="ch-title-text">{title}</span>
        {subtitle && <span className="ch-subtitle">{subtitle}</span>}
        {readOnly && (
          <span className="pill pill-muted ch-ro" title="Read-only connection: OPTIMIZE, partition drops and KILL MUTATION are disabled">
            <Lock size={12} aria-hidden /> read-only
          </span>
        )}
      </div>
      <div className="ch-actions">{children}</div>
    </div>
  );
}

export function RefreshButton({ onClick, busy }: { onClick(): void; busy?: boolean }) {
  return (
    <button type="button" className="btn btn-xs" onClick={onClick} disabled={busy} title="Refresh">
      <RefreshCw size={13} className={busy ? 'spin' : undefined} aria-hidden /> Refresh
    </button>
  );
}

export function AutoRefresh({ on, onChange, seconds }: { on: boolean; onChange(v: boolean): void; seconds: number }) {
  return (
    <label className="ch-check" title={`Refresh every ${seconds} s while the tab is visible`}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> Auto-refresh
    </label>
  );
}

export function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="ch-banner" role="alert">
      <TriangleAlert size={14} aria-hidden />
      <span className="ch-banner-text">{children}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="ch-empty">{children}</div>;
}

export function Tile({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="ch-tile" title={title}>
      <div className="ch-tile-value">{value}</div>
      <div className="ch-tile-label">{label}</div>
    </div>
  );
}

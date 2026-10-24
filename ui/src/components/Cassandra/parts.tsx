// Building blocks shared by the Cassandra views.
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function ViewHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="cs-header">
      <div className="cs-title">
        <h2 className="cs-title-text">{title}</h2>
        {subtitle && <span className="cs-subtitle">{subtitle}</span>}
      </div>
      <div className="cs-actions">{children}</div>
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
    <div className={`cs-banner cs-banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone !== 'info' && <TriangleAlert size={14} aria-hidden />}
      <span className="cs-banner-text">{children}</span>
      {actions}
    </div>
  );
}

export function Tile({ label, value, tone, title }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' | 'ok'; title?: string }) {
  return (
    <div className={`cs-tile${tone ? ` cs-tile-${tone}` : ''}`} role="listitem" title={title}>
      <div className="cs-tile-value">{value}</div>
      <div className="cs-tile-label">{label}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="cs-empty">{children}</div>;
}

export function Dash() {
  return <span className="muted">—</span>;
}

/** Sub-tab strip (role tablist; arrow keys move between tabs). */
export function SubTabs<K extends string>({ tabs, value, onChange, label }: { tabs: { key: K; label: string }[]; value: K; onChange(k: K): void; label: string }) {
  return (
    <div className="cs-subtabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          data-tab-key={t.key}
          aria-selected={t.key === value}
          tabIndex={t.key === value ? 0 : -1}
          className={`cs-subtab${t.key === value ? ' on' : ''}`}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            onChange(next.key);
            (e.currentTarget.parentElement?.querySelector(`[data-tab-key="${next.key}"]`) as HTMLElement | null)?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

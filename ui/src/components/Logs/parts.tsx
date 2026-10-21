// Inline states shared by the logs and activity sub-views: missing privilege (with the exact GRANT and Copy GRANT),
// errors with Retry, and hint / warning banners.
import { CircleAlert, Info, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { CommandButton } from '../layout/CommandButton';

export function PrivilegeState({ what, reason, needs, onRetry }: { what: string; reason?: string | null; needs?: string | null; onRetry?: () => void }) {
  return (
    <div className="logs-center">
      <div className="empty-state compact logs-privilege" role="region" aria-label={`${what} needs a privilege`}>
        <div className="empty-state-icon" aria-hidden="true"><ShieldAlert size={22} /></div>
        <div className="empty-state-title">{what} needs a privilege you do not have</div>
        {reason && <div className="empty-state-hint">{reason}</div>}
        {needs && (
          <>
            <div className="empty-state-hint">Ask your DBA to run:</div>
            <pre className="logs-grant mono" data-testid="grant-text">{needs}</pre>
            <CommandButton command="logs.copyGrant" label="Copy GRANT" variant="primary" />
          </>
        )}
        {onRetry && (
          <button type="button" className="link-btn" onClick={onRetry}>
            Check again
          </button>
        )}
      </div>
    </div>
  );
}

export function InlineError({ title, message, onRetry, compact }: { title: string; message: string; onRetry?: () => void; compact?: boolean }) {
  if (compact) {
    return (
      <div className="logs-banner tone-danger" role="alert">
        <CircleAlert size={14} aria-hidden="true" />
        <span className="logs-banner-text"><strong>{title}:</strong> {message}</span>
        {onRetry && (
          <button type="button" className="btn btn-xs" onClick={onRetry}>
            <RefreshCw size={12} /> Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="logs-center">
      <div className="empty-state compact" role="alert">
        <div className="empty-state-icon" aria-hidden="true"><CircleAlert size={22} /></div>
        <div className="empty-state-title">{title}</div>
        <div className="empty-state-hint">{message}</div>
        {onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            <RefreshCw size={14} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}

export function Banner({ tone, children, actions }: { tone: 'info' | 'warn'; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`logs-banner tone-${tone}`} role={tone === 'warn' ? 'alert' : 'note'}>
      {tone === 'warn' ? <TriangleAlert size={14} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
      <span className="logs-banner-text">{children}</span>
      {actions}
    </div>
  );
}

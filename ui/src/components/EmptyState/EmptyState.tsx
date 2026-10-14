import type { ReactNode } from 'react';
import { commandView } from '../../commands/useCommands';
import { Kbd } from '../Shortcuts/Kbd';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  /** Optional one-line explanation. */
  hint?: ReactNode;
  /** Primary action: a command id (title + shortcut come from the registry) or a custom button. */
  action?: { command: string; label?: string; args?: unknown } | { label: string; onClick: () => void; shortcut?: string };
  /** Optional secondary link. */
  secondary?: { label: string; onClick: () => void } | { command: string; label?: string; args?: unknown };
  compact?: boolean;
  className?: string;
}

function resolve(a: NonNullable<EmptyStateProps['action']>) {
  if ('command' in a) {
    const v = commandView(a.command, a.args, a.label);
    return { label: v.title, onClick: v.run, shortcut: v.shortcut, disabled: !v.command };
  }
  return { label: a.label, onClick: a.onClick, shortcut: 'shortcut' in a ? a.shortcut : undefined, disabled: false };
}

/** Empty states (section 3): icon, one-line title, one action button, optional secondary link. */
export function EmptyState({ icon, title, hint, action, secondary, compact, className }: EmptyStateProps) {
  const primary = action ? resolve(action) : null;
  const second = secondary ? resolve(secondary) : null;
  return (
    <div className={`empty-state${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {primary && !primary.disabled && (
        <button className="btn btn-primary" onClick={primary.onClick}>
          {primary.label}
          {primary.shortcut && <Kbd shortcut={primary.shortcut} className="on-accent" />}
        </button>
      )}
      {second && !second.disabled && (
        <button className="link-btn" onClick={second.onClick}>
          {second.label}
        </button>
      )}
    </div>
  );
}

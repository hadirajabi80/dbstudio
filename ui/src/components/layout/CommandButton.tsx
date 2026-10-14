import type { CSSProperties, ReactNode } from 'react';
import { getCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import { commandIcon } from './commandMenu';

interface Props {
  command: string;
  args?: unknown;
  /** Show the title next to the icon (default: icon only, title in the tooltip). */
  label?: boolean | string;
  icon?: ReactNode;
  className?: string;
  /** Hide (instead of disabling) when the command is not registered (optional package commands). */
  optional?: boolean;
  /** Extra classes when enabled state matters for styling. */
  variant?: 'icon' | 'btn' | 'primary' | 'ghost';
  style?: CSSProperties;
}

/** A toolbar/header button that dispatches a registered command; tooltip shows the platform shortcut. */
export function CommandButton({ command, args, label, icon, className, optional, variant = 'icon', style }: Props) {
  const c = getCommand(command);
  if (!c && optional) return null;
  const v = commandView(command, args);
  const text = typeof label === 'string' ? label : label ? v.title.replace(/…$/, '') : null;
  const cls = variant === 'icon' ? 'icon-btn' : variant === 'primary' ? 'btn btn-primary' : variant === 'ghost' ? 'btn btn-ghost' : 'btn';
  return (
    <button
      type="button"
      className={`${cls}${className ? ` ${className}` : ''}`}
      title={v.tooltip}
      aria-label={text ? undefined : v.title}
      aria-keyshortcuts={c?.shortcut ? c.shortcut.replace(/Mod/g, 'Control') : undefined}
      disabled={!v.enabled}
      onClick={v.run}
      data-command={command}
      style={style}
    >
      {icon ?? commandIcon(c?.icon, 16)}
      {text && <span className="btn-text">{text}</span>}
    </button>
  );
}

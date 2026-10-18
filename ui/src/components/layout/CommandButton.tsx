import type { CSSProperties, ReactNode } from 'react';
import { ariaKeyShortcuts } from '../../commands/keys';
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
  /**
   * Why the action is unavailable right now (no connection, empty editor). The button is dimmed but stays focusable
   * (aria-disabled), and the reason is its tooltip and description, so users learn what to do instead of guessing.
   */
  disabledReason?: string | null;
  /** After running (e.g. give focus back to the editor for Run / Format). */
  onRan?: () => void;
}

/** A toolbar/header button that dispatches a registered command; tooltip shows the platform shortcut. */
export function CommandButton({ command, args, label, icon, className, optional, variant = 'icon', style, disabledReason, onRan }: Props) {
  const c = getCommand(command);
  if (!c && optional) return null;
  const v = commandView(command, args);
  const text = typeof label === 'string' ? label : label ? v.title.replace(/…$/, '') : null;
  const unavailable = !!disabledReason && !!c;
  const cls = variant === 'icon' ? 'icon-btn' : variant === 'primary' ? 'btn btn-primary' : variant === 'ghost' ? 'btn btn-ghost' : 'btn';
  return (
    <button
      type="button"
      className={`${cls}${className ? ` ${className}` : ''}${unavailable ? ' unavailable' : ''}`}
      /* the tooltip is also the accessible description: it says why the button does nothing right now */
      title={unavailable ? `${v.title}: ${disabledReason}` : v.tooltip}
      aria-label={text ? undefined : v.title}
      aria-keyshortcuts={ariaKeyShortcuts(c?.shortcut)}
      aria-disabled={unavailable || undefined}
      disabled={!v.enabled && !unavailable}
      onClick={() => {
        if (unavailable) return;
        v.run();
        onRan?.();
      }}
      data-command={command}
      style={style}
    >
      {icon ?? commandIcon(c?.icon, 16)}
      {text && <span className="btn-text">{text}</span>}
    </button>
  );
}

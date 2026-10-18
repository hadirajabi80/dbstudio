import { Fragment } from 'react';
import { displayShortcut, shortcutKeys, tooltipWithShortcut } from '../../commands/keys';

/** Key caps for a shortcut, platform-aware: Ctrl+Shift+P on Windows, ⇧⌘P on macOS. */
export function Kbd({ shortcut, className }: { shortcut: string | undefined | null; className?: string }) {
  if (!shortcut) return null;
  const keys = shortcutKeys(shortcut);
  return (
    <span className={`kbd-group${className ? ` ${className}` : ''}`} aria-label={displayShortcut(shortcut)}>
      {keys.map((k, i) =>
        k === null ? (
          <span key={i} className="kbd-chord-gap" aria-hidden="true" />
        ) : (
          <Fragment key={i}>
            <kbd aria-hidden="true">{k}</kbd>
          </Fragment>
        ),
      )}
    </span>
  );
}

/** "Title (Ctrl+Shift+P)" for tooltips ("Title (detail) · Ctrl+Shift+P" after a parenthetical). */
export function withShortcut(title: string, shortcut?: string | null): string {
  return tooltipWithShortcut(title, shortcut ? displayShortcut(shortcut) : null);
}

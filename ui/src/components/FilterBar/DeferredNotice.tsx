// "Not applied" notice of a data tab (design-r2-01): while the grid has unsaved edits, a filter / search / sort change
// that would reload the rows is kept as typed but not run (a reload would drop the edits). The notice offers both
// ways out; the host applies the deferred query itself as soon as nothing is pending (Ctrl+S, Ctrl+Z, discard).
import { Info } from 'lucide-react';
import './filterbar.css';

export interface DeferredNoticeProps {
  /** Number of unsaved changes holding the query back. */
  pending: number;
  /** A save is running: both actions wait for it. */
  busy?: boolean;
  /** Save the pending changes; the deferred query runs once they are saved. */
  onSave(): void;
  /** Discard the pending changes; the deferred query runs right after. */
  onDiscard(): void;
}

export function DeferredNotice({ pending, busy, onSave, onDiscard }: DeferredNoticeProps) {
  const changes = `${pending} unsaved change${pending === 1 ? '' : 's'}`;
  return (
    <div className="fb-deferred" role="status" aria-live="polite">
      <Info size={13} className="fb-deferred-icon" aria-hidden="true" />
      <span className="fb-deferred-text" title="The filter, search or sort reloads the rows, which would drop the unsaved changes. It runs as soon as nothing is pending.">
        Not applied: {changes}.
      </span>
      <button
        type="button"
        className="btn btn-xs btn-primary"
        disabled={busy}
        onClick={onSave}
        title="Save the changes to the database, then run the filter"
      >
        Save and filter
      </button>
      <button type="button" className="btn btn-xs" disabled={busy} onClick={onDiscard} title="Discard the unsaved changes, then run the filter">
        Discard and filter
      </button>
    </div>
  );
}

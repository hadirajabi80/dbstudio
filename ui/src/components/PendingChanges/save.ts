// Saving grid edits (user-02): Ctrl+S and the Save button apply the pending changes directly, in one transaction,
// without showing the generated SQL (as Navicat does). On any error or conflict submitChanges() rolls the transaction
// back and keeps the pending buffer with the failing row marked; the error is shown as a toast whose action offers
// the next step (overwrite a conflict, or look at the SQL). The SQL preview stays available on demand ("Preview SQL",
// "Copy SQL of pending changes") and as an opt-in before every save: Settings > Data editing > "Show SQL before saving"
// (settings.grid.showSqlBeforeSave, default off).
import { copyText } from '../../app/actions';
import { previewScript } from '../../data/sqlgen';
import { pendingCount, useEdits } from '../../store/edits';
import { useSettings } from '../../store/settings';
import { toast } from '../../store/ui';
import { buildStatements, submitChanges, type EditContext, type SubmitResult } from './submit';

/** "Verify unchanged values" default (settings.grid.verifyUnchanged). */
export function verifyDefault(): boolean {
  return !!useSettings.getState().settings.grid?.verifyUnchanged;
}

/** settings.grid.showSqlBeforeSave: open the SQL preview instead of saving directly (default off). */
export function showSqlBeforeSave(): boolean {
  return !!useSettings.getState().settings.grid?.showSqlBeforeSave;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface SaveOptions {
  /** Opens the SQL preview dialog (used when the setting asks for it, and by the error toast's "Show SQL"). */
  preview(): void;
  /** Skip the "Show SQL before saving" setting (the preview dialog's own Save button). */
  direct?: boolean;
  /** Overrides settings.grid.verifyUnchanged. */
  verifyUnchanged?: boolean;
}

/**
 * Save the pending edits of a grid. Returns null when nothing ran (nothing pending, a save already running, or the
 * preview opened instead).
 */
export async function savePendingChanges(ctx: EditContext, opts: SaveOptions): Promise<SubmitResult | null> {
  const buf = useEdits.getState().get(ctx.gridKey);
  if (buf.status === 'submitting' || pendingCount(buf.pending) === 0) return null;
  if (!opts.direct && showSqlBeforeSave()) {
    opts.preview();
    return null;
  }
  const verifyUnchanged = opts.verifyUnchanged ?? verifyDefault();
  const r = await submitChanges(ctx, { verifyUnchanged });
  if (r.ok) {
    if (r.executed > 0) {
      toast('success', `Saved ${plural(r.executed, 'change')} to ${ctx.target.name}`,
        r.leftOpen ? 'The transaction is still open: commit to keep the changes.' : undefined);
    }
    return r;
  }
  const conflict = r.issues.find((i) => i.kind === 'conflict');
  const rows = r.issues.filter((i) => /^\d+$/.test(i.ref)).map((i) => Number(i.ref) + 1);
  const where = rows.length ? ` (row ${rows.join(', ')})` : r.issues.length ? ' (new row)' : '';
  toast(
    'error',
    conflict ? `Not saved: the row was changed by someone else${where}` : `Could not save the changes to ${ctx.target.name}${where}`,
    `${r.error ?? 'The changes were rolled back.'} Your edits are kept: fix them and save again, or discard them.`,
    conflict
      ? { label: 'Overwrite', run: () => void savePendingChanges(ctx, { ...opts, direct: true, verifyUnchanged: false }) }
      : { label: 'Show SQL', run: () => opts.preview() },
  );
  return r;
}

/** Copies the statements the pending edits would run (literal values inlined, ready to paste into a console). */
export function copyPendingSql(ctx: EditContext): void {
  const buf = useEdits.getState().get(ctx.gridKey);
  const n = pendingCount(buf.pending);
  if (n === 0) {
    toast('info', 'There are no pending changes to copy');
    return;
  }
  const stmts = buildStatements(ctx, buf.pending, verifyDefault());
  void copyText(previewScript(stmts, ctx.dialect), `Copied the SQL of ${plural(n, 'pending change')}`);
}

/** Discards every pending edit at once, without a dialog; the toast's Undo brings them back. */
export function discardPendingChanges(gridKey: string): void {
  const s = useEdits.getState();
  const n = pendingCount(s.get(gridKey).pending);
  if (n === 0 || s.get(gridKey).status === 'submitting') return;
  s.revertAll(gridKey);
  toast('info', `Discarded ${plural(n, 'pending change')}`, undefined, { label: 'Undo', run: () => useEdits.getState().undo(gridKey) });
}

// Save / preview / copy / discard of a grid's pending edits for the views that own an edit context (console result
// sets, Data tabs). Save goes straight to the database (save.ts, user-02); the SQL preview dialog is only rendered
// when asked for.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GridController } from '../Grid/controller';
import { PendingChangesDialog } from './PendingChanges';
import { copyPendingSql, discardPendingChanges, savePendingChanges } from './save';
import type { EditContext } from './submit';

export interface PendingChangesActions {
  /** Ctrl+S / Save: direct save (or the preview when settings.grid.showSqlBeforeSave is on). */
  save(): void;
  /** "Preview SQL…": the generated statements, with Save / Copy SQL / Discard all. */
  preview(): void;
  /** "Copy SQL of pending changes". */
  copySql(): void;
  /** Discard every pending change at once (undoable from the toast). */
  discard(): void;
  /** Grid controller extras for the commands (grid.previewChanges, grid.copyChangesSql, grid.revertAll). */
  controller: Pick<GridController, 'previewChanges' | 'copyChangesSql' | 'revertAll'>;
  /** The preview dialog while it is open (render it once in the view). */
  dialog: ReactNode;
}

export function usePendingChanges(ctx: EditContext | null): PendingChangesActions {
  const [previewOpen, setPreviewOpen] = useState(false);
  // The context is rebuilt on every render (row accessors over the latest rows); actions always read the current one.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const preview = useCallback(() => {
    if (ctxRef.current) setPreviewOpen(true);
  }, []);
  const save = useCallback(() => {
    const c = ctxRef.current;
    if (c) void savePendingChanges(c, { preview });
  }, [preview]);
  const copySql = useCallback(() => {
    const c = ctxRef.current;
    if (c) copyPendingSql(c);
  }, []);
  const discard = useCallback(() => {
    const c = ctxRef.current;
    if (c) discardPendingChanges(c.gridKey);
  }, []);
  const controller = useMemo(() => ({ previewChanges: preview, copyChangesSql: copySql, revertAll: discard }), [preview, copySql, discard]);
  const dialog = previewOpen && ctx ? <PendingChangesDialog ctx={ctx} onClose={() => setPreviewOpen(false)} /> : null;
  return { save, preview, copySql, discard, controller, dialog };
}

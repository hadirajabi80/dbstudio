// Pending-changes SQL preview (PLAN-M1.5 A1): the generated statements for the dialect with parameter values,
// Copy SQL / Save / Discard, optional conflict detection, and the outcome of a failed save. Saving normally skips this
// dialog (save.ts, user-02); it opens from "Preview SQL…", the error toast's "Show SQL", or before every save when
// settings.grid.showSqlBeforeSave is on.
import { CircleAlert, Copy, LoaderCircle, PencilLine, Plus, RotateCcw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { copyText } from '../../app/actions';
import { previewScript } from '../../data/sqlgen';
import { inlineParams } from '../../filter/sql';
import { pendingCount, useEditBuffer, useEdits } from '../../store/edits';
import { toast } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { verifyDefault } from './save';
import { buildStatements, submitChanges, type EditContext } from './submit';
import './pendingchanges.css';

const DIALECT_NAME = { tsql: 'SQL Server', plsql: 'Oracle', sqlite: 'SQLite', pgsql: 'PostgreSQL' } as const;

export { verifyDefault } from './save';

export function PendingChangesDialog({ ctx, onClose, onSubmitted }: { ctx: EditContext; onClose(): void; onSubmitted?(): void }) {
  const buf = useEditBuffer(ctx.gridKey);
  const [verify, setVerify] = useState(verifyDefault);
  const [showParams, setShowParams] = useState(false);
  const stmts = useMemo(() => buildStatements(ctx, buf.pending, verify), [ctx, buf.pending, verify]);
  const n = pendingCount(buf.pending);
  const busy = buf.status === 'submitting';
  const counts = {
    update: stmts.filter((s) => s.kind === 'update').length,
    insert: stmts.filter((s) => s.kind === 'insert').length,
    delete: stmts.filter((s) => s.kind === 'delete').length,
  };

  const submit = async (opts = { verifyUnchanged: verify }) => {
    const r = await submitChanges(ctx, opts);
    if (r.ok) {
      toast('success', `Saved ${r.executed} change${r.executed === 1 ? '' : 's'} to ${ctx.target.name}`, r.leftOpen ? 'The transaction is still open: commit to keep the changes.' : undefined);
      onSubmitted?.();
      onClose();
    }
  };

  const conflicts = buf.issues.filter((i) => i.kind === 'conflict');

  return (
    <Dialog
      title={`Pending changes · ${ctx.target.name}`}
      onClose={() => !busy && onClose()}
      width={760}
      className="pc-dialog"
      footer={
        <>
          <label className="pc-verify" title="Adds the old value of every edited column to the WHERE clause; 0 rows affected is reported as a conflict">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
            <ShieldCheck size={13} /> Verify unchanged values
          </label>
          <div className="flex-1" />
          <button className="btn" disabled={busy || n === 0} onClick={() => (useEdits.getState().revertAll(ctx.gridKey), onClose())}>
            <RotateCcw size={13} /> Discard all
          </button>
          <button className="btn" disabled={n === 0} onClick={() => void copyText(previewScript(stmts, ctx.dialect), 'Copied SQL')}>
            <Copy size={13} /> Copy SQL
          </button>
          <button className="btn btn-primary" disabled={busy || n === 0} onClick={() => void submit()} data-autofocus>
            {busy ? <LoaderCircle size={13} className="spin" /> : null} Save {n > 0 ? `(${n})` : ''}
          </button>
        </>
      }
    >
      {n === 0 ? (
        <div className="pc-empty">
          <PencilLine size={22} />
          <div className="pc-empty-title">Edit a cell to start</div>
          <div className="muted">Changes you make in the grid are collected here before anything is written.</div>
        </div>
      ) : (
        <>
          <div className="pc-summary">
            {counts.update > 0 && <span className="pc-tag update"><PencilLine size={12} /> {counts.update} update{counts.update === 1 ? '' : 's'}</span>}
            {counts.insert > 0 && <span className="pc-tag insert"><Plus size={12} /> {counts.insert} insert{counts.insert === 1 ? '' : 's'}</span>}
            {counts.delete > 0 && <span className="pc-tag delete"><Trash2 size={12} /> {counts.delete} delete{counts.delete === 1 ? '' : 's'}</span>}
            <span className="muted">· {DIALECT_NAME[ctx.dialect]} · one transaction, rolled back on any error</span>
            <div className="flex-1" />
            <label className="pc-params-toggle">
              <input type="checkbox" checked={showParams} onChange={(e) => setShowParams(e.target.checked)} /> Show parameters
            </label>
          </div>
          {buf.error && (
            <div className={`pc-error${conflicts.length ? ' conflict' : ''}`} role="alert">
              {conflicts.length ? <TriangleAlert size={14} /> : <CircleAlert size={14} />}
              <div className="flex-1">
                <div>{buf.error}</div>
                {conflicts.length > 0 && (
                  <div className="pc-error-actions">
                    <button className="btn btn-xs" disabled={busy} onClick={() => void submit({ verifyUnchanged: false })}>
                      Overwrite (save without verification)
                    </button>
                    {conflicts.map((c) => /^\d+$/.test(c.ref) && (
                      <button key={c.ref} className="btn btn-xs" disabled={busy} onClick={() => useEdits.getState().revertRow(ctx.gridKey, Number(c.ref))}>
                        Discard my change to row {Number(c.ref) + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <ol className="pc-list" aria-label="Statements to run">
            {stmts.map((s, i) => {
              const issue = buf.issues.find((x) => x.ref === s.ref);
              return (
                <li key={`${s.ref}-${i}`} className={`pc-stmt ${s.kind}${issue ? ' issue' : ''}`}>
                  <span className={`pc-kind ${s.kind}`}>{s.kind.toUpperCase()}</span>
                  <div className="pc-sql">
                    <code>{showParams ? s.sql : inlineParams(s.sql, s.params.filter((x) => x.direction !== 'out'), ctx.dialect)}</code>
                    {showParams && s.params.length > 0 && (
                      <table className="pc-params">
                        <tbody>
                          {s.params.map((prm) => (
                            <tr key={prm.name}>
                              <td className="mono">{ctx.dialect === 'plsql' ? ':' : '@'}{prm.name}</td>
                              <td className="muted">{prm.kind}{prm.direction === 'out' ? ' out' : ''}</td>
                              <td className="mono">{prm.direction === 'out' ? '(returned)' : JSON.stringify(prm.value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {issue && <div className="pc-issue">{issue.message}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Dialog>
  );
}

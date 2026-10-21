// Typed confirmation for Kill / Cancel (danger): shows the exact statement the engine runs; the danger button is
// enabled only once the row id is typed.
import { Skull, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import type { ActivityRow } from '../../api/types';
import { Dialog } from '../common/Dialog';
import type { KillMode } from './model';

export interface KillDialogProps {
  row: ActivityRow;
  mode: KillMode;
  statement: string;
  connectionName: string;
  /** Resolves when the request finished; rejects with the message to show. */
  onConfirm(): Promise<void>;
  onClose(): void;
}

export function KillDialog({ row, mode, statement, connectionName, onConfirm, onClose }: KillDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const armed = typed.trim() === row.id && !busy;
  const what = mode === 'cancel' ? 'Cancel the running query' : row.kind === 'op' ? 'Kill operation' : row.kind === 'client' ? 'Kill client' : 'Kill session';
  const title = `${what} ${row.id}?`;

  const confirm = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={
        <span className="confirm-title">
          <TriangleAlert size={16} className="text-warning" />
          {title}
        </span>
      }
      ariaLabel={title}
      onClose={onClose}
      onSubmit={() => void confirm()}
      width={520}
      className="confirm-danger logs-kill-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className={armed ? 'btn btn-danger' : 'btn btn-danger-outline'} disabled={!armed} aria-disabled={!armed || undefined} onClick={() => void confirm()}>
            <Skull size={14} /> {mode === 'cancel' ? 'Cancel query' : 'Kill'}
          </button>
        </>
      }
    >
      <p className="confirm-message">
        {mode === 'cancel'
          ? `The statement of ${row.id} on ${connectionName} is interrupted; the session stays connected.`
          : `${row.id} on ${connectionName} is disconnected and its open transaction is rolled back.`}
        {row.user ? ` User: ${row.user}.` : ''}
        {row.app ? ` Application: ${row.app}.` : ''}
      </p>
      <ul className="confirm-items">
        <li>
          <code data-testid="kill-statement">{statement}</code>
        </li>
      </ul>
      {row.text && <pre className="logs-kill-text mono" title={row.text}>{row.text}</pre>}
      <label className="form-label" htmlFor={inputId}>
        Type <strong className="mono">{row.id}</strong> to confirm
      </label>
      <input
        id={inputId}
        className="input mono"
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        aria-describedby={error ? `${inputId}-err` : undefined}
      />
      {error && (
        <div id={`${inputId}-err`} className="form-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}

import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useUi, type ConfirmRequest } from '../../store/ui';
import { Dialog } from './Dialog';

/**
 * One bullet of a confirmation: a string or `{ kind: 'sql' }` is code (monospace, danger colour: what is about to
 * run); `{ kind: 'note' }` is an explanation shown as muted prose (e.g. a scripter's annotation of a statement).
 */
export type ConfirmItem = string | { text: string; kind: 'sql' | 'note' };

/**
 * `items` for askConfirm with notes. ConfirmRequest.items (store/ui.ts) is still typed string[]; this dialog renders
 * both shapes, so structured items pass through unchanged until that type is widened to ConfirmItem[].
 */
export function confirmItemList(items: ConfirmItem[]): string[] {
  return items as unknown as string[];
}

function ConfirmItemRow({ item }: { item: ConfirmItem }) {
  const it = typeof item === 'string' ? { text: item, kind: 'sql' as const } : item;
  if (it.kind === 'note') {
    return (
      <li className="confirm-note muted" style={{ listStyle: 'none' }}>
        {it.text}
      </li>
    );
  }
  return (
    <li>
      <code>{it.text}</code>
    </li>
  );
}

/**
 * Generic confirmation (destructive statements, closing a tab with an open transaction, ...).
 *
 * Danger confirmations never make the destructive action the default: Cancel has the initial focus (Enter = Cancel),
 * and a required acknowledgement checkbox (`ack.required`, e.g. writing to a read-only connection) keeps the danger
 * button disabled and visually secondary until it is ticked.
 */
export function ConfirmDialog() {
  const c = useUi((s) => s.confirm);
  if (!c) return null;
  // Re-mount per request so the checkbox state never leaks from one confirmation into the next.
  return <ConfirmBody key={c.seq ?? `${c.title}\u0001${c.message}`} c={c} />;
}

function ConfirmBody({ c }: { c: ConfirmRequest }) {
  const resolve = useUi((s) => s.resolveConfirm);
  const [ack, setAck] = useState(false);
  const armed = !c.ack?.required || ack;
  const confirmCls = c.danger ? (armed && c.ack?.required ? 'btn btn-danger' : c.ack?.required ? 'btn btn-danger-outline' : 'btn btn-danger') : 'btn btn-primary';
  return (
    <Dialog
      title={
        <span className="confirm-title">
          {c.danger && <TriangleAlert size={16} className="text-warning" />}
          {c.title}
        </span>
      }
      ariaLabel={c.title}
      onClose={() => resolve(false)}
      width={500}
      className={c.danger ? 'confirm-danger' : undefined}
      footer={
        <>
          <button className="btn" data-autofocus={c.danger ? true : undefined} onClick={() => resolve(false)}>
            {c.cancelLabel ?? 'Cancel'}
          </button>
          <button
            className={confirmCls}
            data-autofocus={c.danger ? undefined : true}
            disabled={!armed}
            aria-disabled={!armed || undefined}
            onClick={() => resolve(true, ack)}
          >
            {c.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <p className="confirm-message">{c.message}</p>
      {c.items && c.items.length > 0 && (
        <ul className="confirm-items">
          {(c.items as ConfirmItem[]).map((it, i) => (
            <ConfirmItemRow key={i} item={it} />
          ))}
        </ul>
      )}
      {c.ack && (
        <label className="check confirm-ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{c.ack.label}</span>
        </label>
      )}
    </Dialog>
  );
}

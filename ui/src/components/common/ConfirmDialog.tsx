import { TriangleAlert } from 'lucide-react';
import { useUi } from '../../store/ui';
import { Dialog } from './Dialog';

/** Generic confirmation (destructive statements, closing a tab with an open transaction, ...). */
export function ConfirmDialog() {
  const c = useUi((s) => s.confirm);
  const resolve = useUi((s) => s.resolveConfirm);
  if (!c) return null;
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
      footer={
        <>
          <button className="btn" onClick={() => resolve(false)}>
            {c.cancelLabel ?? 'Cancel'}
          </button>
          <button className={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} data-autofocus onClick={() => resolve(true)}>
            {c.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <p className="confirm-message">{c.message}</p>
      {c.items && c.items.length > 0 && (
        <ul className="confirm-items">
          {c.items.map((it, i) => (
            <li key={i}>
              <code>{it}</code>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

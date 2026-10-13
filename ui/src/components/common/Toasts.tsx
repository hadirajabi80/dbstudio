import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useUi } from '../../store/ui';

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon size={16} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-text">{t.text}</div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
            </div>
            <button className="icon-btn sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

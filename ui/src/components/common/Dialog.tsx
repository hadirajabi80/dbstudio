import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { focusFirst, useRestoreFocus } from './focus';

interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  /** Enter in a single-line field triggers this. */
  onSubmit?: () => void;
  ariaLabel?: string;
}

/**
 * The first form field of the body: one selector list, so querySelector returns whichever field comes first in
 * document order. The custom Select's trigger is a button[role=combobox] (styles-r1-04), so it counts as a field.
 */
const FIRST_FIELD = ['input', 'select', 'textarea', '[role="combobox"]'].map((f) => `.dialog-body ${f}:not([disabled])`).join(', ');

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: role=dialog + aria-modal, focus trapped, Esc closes, initial focus on the first input. */
export function Dialog({ title, onClose, children, footer, width = 520, className, onSubmit, ariaLabel }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useRestoreFocus(true, ref);
  useEffect(() => {
    // An explicit [data-autofocus] wins over document order (danger confirmations focus Cancel, not the checkbox).
    focusFirst(ref.current, ['[data-autofocus]', FIRST_FIELD, 'button.btn-primary']);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Tab') {
            const els = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
            if (!els.length) return;
            const first = els[0];
            const last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          } else if (
            e.key === 'Enter' && onSubmit && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)
            && !(e.target instanceof HTMLSelectElement)
          ) {
            e.preventDefault();
            onSubmit();
          }
        }}
      >
        <div className="dialog-header">
          <div className="dialog-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

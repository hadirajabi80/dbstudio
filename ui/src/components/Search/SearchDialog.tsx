// Find in database as a centred popup (Ctrl+Shift+F), like JetBrains' Find in Files: keyboard-first, results streamed
// in as you type, a preview of the selected match, and "Open in tab" to keep the results next to the other tabs.
// Closing keeps the query, scope and results (dialogStore / useSearchRuns): Ctrl+Shift+F brings them back.
import { PanelBottom, Pin, Search, X } from 'lucide-react';
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { eventStroke, normalizeShortcut } from '../../commands/keys';
import { getCommand } from '../../commands/registry';
import { useRestoreFocus } from '../common/focus';
import { Kbd } from '../Shortcuts/Kbd';
import { SEARCH_DIALOG_RUN, useSearchDialog } from './dialogStore';
import type { SearchTabState } from './model';
import { moveSearchToTab } from './open';
import { SearchPanel } from './SearchPanel';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SearchDialog() {
  const state = useSearchDialog((s) => s.state);
  const size = useSearchDialog((s) => s.size);
  const preview = useSearchDialog((s) => s.preview);
  const ref = useRef<HTMLDivElement>(null);
  useRestoreFocus(true, ref);

  const close = useCallback(() => {
    // A size the user dragged (CSS resize writes it inline) is kept for the next open.
    const el = ref.current;
    if (el?.style.width && el.style.height) useSearchDialog.getState().setSize({ width: parseInt(el.style.width, 10), height: parseInt(el.style.height, 10) });
    useSearchDialog.getState().close();
  }, []);
  const update = useCallback((p: Partial<SearchTabState>) => useSearchDialog.getState().update(p), []);

  if (!state) return null;

  const findKey = getCommand('search.findInDatabase')?.shortcut ?? 'Mod+Shift+F';
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // The panel handles Esc in the box and the results (cancel a running search first); anywhere else it closes.
      e.stopPropagation();
      close();
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
    } else if (eventStroke(e.nativeEvent) === normalizeShortcut(findKey)) {
      // Ctrl+Shift+F again (global keys stay out of modal dialogs): back to the search box, its text selected.
      e.preventDefault();
      const input = ref.current?.querySelector<HTMLInputElement>('input[data-primary-focus]');
      input?.focus();
      input?.select();
    }
  };

  return (
    <div className="overlay sx-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="dialog sx-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Find in database"
        style={size ? { width: size.width, height: size.height } : undefined}
        onKeyDown={onKeyDown}
      >
        <header className="sx-dialog-head">
          <Search size={15} className="sx-dialog-icon" aria-hidden="true" />
          <span className="sx-dialog-title">Find in database</span>
          <span className="flex-1" />
          <button
            type="button"
            className={`icon-btn sm sx-toggle-preview${preview ? ' on' : ''}`}
            aria-pressed={preview}
            aria-label="Preview"
            title={preview ? 'Hide the preview' : 'Show the preview of the selected match'}
            onClick={() => useSearchDialog.getState().setPreview(!preview)}
          >
            <PanelBottom size={15} />
          </button>
          <button type="button" className="btn btn-xs sx-pin" onClick={() => moveSearchToTab()} title="Move the query and its results into a Search tab">
            <Pin size={13} /> Open in tab
          </button>
          <button type="button" className="icon-btn sm" onClick={close} aria-label="Close" title="Close (Esc)">
            <X size={15} />
          </button>
        </header>
        <SearchPanel
          runId={SEARCH_DIALOG_RUN}
          state={state}
          update={update}
          visible
          variant="dialog"
          preview={preview}
          onOpenResult={(keepOpen) => { if (!keepOpen) close(); }}
          onEscape={close}
        />
        <footer className="sx-dialog-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><Kbd shortcut="Enter" /> open</span>
          <span><Kbd shortcut="Mod+Enter" /> open, keep this open</span>
          <span><Kbd shortcut="Escape" /> close</span>
          <span className="flex-1" />
          <span className="sx-foot-muted">Right-click a result for more</span>
        </footer>
      </div>
    </div>
  );
}

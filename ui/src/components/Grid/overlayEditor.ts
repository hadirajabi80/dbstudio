// glide-data-grid renders its in-place cell editor into the global `#portal` element (index.html), outside the
// grid's DOM. This module lets the app treat that editor like part of the grid (design-01, styles-19):
//
// - commitOpenEditor(): commits the open editor exactly like Enter does (Ctrl+S, Submit, theme switch, modals),
//   so a value that is still being typed is never lost or left floating above a dialog;
// - the portal carries `data-command-scope="gridEditor"`, so Mod+S inside the editor reaches the grid's submit
//   command (grid.submitFromEditor) while text keys (Ctrl+Z, Ctrl+A…) stay with the textarea;
// - when a modal dialog appears, the open editor is committed first (it would otherwise float above the dialog).

const PORTAL_SCOPE = 'gridEditor';

function portal(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('portal');
}

/** The open overlay editor (its clip region), or null. */
export function openEditorElement(): HTMLElement | null {
  return portal()?.querySelector<HTMLElement>('.gdg-clip-region') ?? null;
}

export function hasOpenEditor(): boolean {
  return !!openEditorElement();
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Commit the open overlay editor as if Enter was pressed (glide finishes the edit on the next tick and calls
 * onCellEdited). Resolves once the editor is gone (or after ~250 ms); a no-op when nothing is open.
 */
export async function commitOpenEditor(): Promise<boolean> {
  const region = openEditorElement();
  if (!region) return false;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const target = (active instanceof HTMLElement && region.contains(active) ? active : null)
    ?? region.querySelector<HTMLElement>('textarea, input')
    ?? region;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  for (let i = 0; i < 25 && region.isConnected && openEditorElement() === region; i++) await tick();
  // glide applies the value in its own setTimeout; give React one more turn to flush the store update.
  await tick();
  return true;
}

/** Discard the open editor (Escape). */
export function cancelOpenEditor(): void {
  const region = openEditorElement();
  if (!region) return;
  const target = region.querySelector<HTMLElement>('textarea, input') ?? region;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

const MODAL = '[role=dialog][aria-modal=true], .overlay';

let users = 0;
let observer: MutationObserver | null = null;

function isModal(n: Node): boolean {
  return n instanceof Element && (n.matches(MODAL) || !!n.querySelector?.(MODAL));
}

/** Grids call this while mounted (ref-counted): scope attribute on the portal + "commit before a modal" observer. */
export function attachOverlayEditorSupport(): () => void {
  users++;
  const p = portal();
  if (p && !p.hasAttribute('data-command-scope')) p.setAttribute('data-command-scope', PORTAL_SCOPE);
  if (!observer && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver((records) => {
      if (!hasOpenEditor()) return;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n !== p && !p?.contains(n) && isModal(n)) {
            void commitOpenEditor();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  return () => {
    users = Math.max(0, users - 1);
    if (users === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

// Host for the designer dialogs (procedure wizard, compare with server). App renders <DesignerHost/> once and imports
// designer.css itself, so opening a dialog only updates the designer UI store.
import { CompareDialog } from './CompareDialog';
import { ProcWizard } from './proc/ProcWizard';
import { useDesignerUi } from './store';

export function DesignerHost() {
  const wizard = useDesignerUi((s) => s.wizard);
  const compare = useDesignerUi((s) => s.compareTabId);
  return (
    <>
      {wizard && <ProcWizard key={`${wizard.connectionId}|${wizard.kind}`} req={wizard} />}
      {compare && <CompareDialog tabId={compare} />}
    </>
  );
}

/**
 * Kept for tests and older call sites: the dialogs used to mount their own React root when the shell did not render
 * DesignerHost. App always renders it now, so there is nothing to do.
 */
export function ensureDesignerHost(): void {
  /* no-op: App renders <DesignerHost/> */
}

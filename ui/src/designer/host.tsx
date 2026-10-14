// Host for the designer dialogs (procedure wizard, compare with server). The shell may render <DesignerHost/>
// itself; otherwise the first dialog mounts it in its own React root (so the package works without App edits).
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CompareDialog } from './CompareDialog';
import { ProcWizard } from './proc/ProcWizard';
import { useDesignerUi } from './store';
import './designer.css';

let mounted = 0;

export function DesignerHost() {
  const wizard = useDesignerUi((s) => s.wizard);
  const compare = useDesignerUi((s) => s.compareTabId);
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
    };
  }, []);
  return (
    <>
      {wizard && <ProcWizard key={`${wizard.connectionId}|${wizard.kind}`} req={wizard} />}
      {compare && <CompareDialog tabId={compare} />}
    </>
  );
}

let ownRoot = false;

export function ensureDesignerHost(): void {
  if (mounted > 0 || ownRoot || typeof document === 'undefined') return;
  ownRoot = true;
  const el = document.createElement('div');
  el.id = 'dbstudio-designer-host';
  document.body.appendChild(el);
  createRoot(el).render(<DesignerHost />);
}

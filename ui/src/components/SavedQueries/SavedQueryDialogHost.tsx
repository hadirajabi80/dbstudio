// Loads the saved-query dialog the first time it opens (the dialog is a lazy chunk).
import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useSavedQueryDialog } from './dialogStore';

const SavedQueryDialog = lazy(() => import('./SavedQueryDialog').then((m) => ({ default: m.SavedQueryDialog })));

export function SavedQueryDialogHost() {
  const request = useSavedQueryDialog((s) => s.request);
  if (!request) return null;
  return (
    <ErrorBoundary area="the saved query dialog" variant="dialog" onClose={() => useSavedQueryDialog.getState().close()}>
      <Suspense fallback={null}>
        <SavedQueryDialog request={request} />
      </Suspense>
    </ErrorBoundary>
  );
}

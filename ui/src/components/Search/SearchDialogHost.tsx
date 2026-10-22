// Loads the Find in database dialog the first time it opens (the dialog and its results tree are a lazy chunk).
import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useSearchDialog } from './dialogStore';

const SearchDialog = lazy(() => import('./SearchDialog').then((m) => ({ default: m.SearchDialog })));

export function SearchDialogHost() {
  const open = useSearchDialog((s) => s.open);
  if (!open) return null;
  return (
    <ErrorBoundary area="the search dialog" variant="dialog" onClose={() => useSearchDialog.getState().close()}>
      <Suspense fallback={null}>
        <SearchDialog />
      </Suspense>
    </ErrorBoundary>
  );
}

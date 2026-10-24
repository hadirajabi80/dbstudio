// Lazily loaded Elasticsearch tab views (overview, indices, index, search, console, SQL, tasks are one separate chunk).
import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { TabViewProps } from '../layout/tabViews';

const LazyEs = lazy(() => import('./EsView'));

export function EsTab(p: TabViewProps) {
  return (
    <Suspense
      fallback={
        p.visible ? (
          <div className="workspace-missing" role="status">
            <LoaderCircle size={16} className="spin" aria-label="Loading Elasticsearch" />
          </div>
        ) : null
      }
    >
      <LazyEs {...p} />
    </Suspense>
  );
}

// Lazily loaded ClickHouse tab views (parts & partitions, mutations, merges are one separate chunk).
import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { TabViewProps } from '../layout/tabViews';

const LazyClickHouse = lazy(() => import('./ClickHouseView'));

export function ClickHouseTab(p: TabViewProps) {
  return (
    <Suspense
      fallback={
        p.visible ? (
          <div className="workspace-missing" role="status">
            <LoaderCircle size={16} className="spin" aria-label="Loading ClickHouse view" />
          </div>
        ) : null
      }
    >
      <LazyClickHouse {...p} />
    </Suspense>
  );
}

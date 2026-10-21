// Lazily loaded logs tab view (the view, its list, the activity grid and the formatters are one separate chunk).
import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { TabViewProps } from '../layout/tabViews';

const LazyLogs = lazy(() => import('./LogsView').then((m) => ({ default: m.LogsView })));

export function LogsTab(p: TabViewProps) {
  return (
    <Suspense
      fallback={
        p.visible ? (
          <div className="workspace-missing" role="status">
            <LoaderCircle size={16} className="spin" aria-label="Loading logs" />
          </div>
        ) : null
      }
    >
      <LazyLogs {...p} />
    </Suspense>
  );
}

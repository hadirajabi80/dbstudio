// Lazily loaded tab views of the designer package (the designers pull in Monaco and are code-split).
import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { TabViewProps } from '../components/layout/tabViews';

const LazyTable = lazy(() => import('./table/TableDesigner').then((m) => ({ default: m.TableDesignerView })));
const LazyView = lazy(() => import('./view/ViewDesigner').then((m) => ({ default: m.ViewDesignerView })));

function Loading({ visible }: { visible: boolean }) {
  return visible ? (
    <div className="workspace-missing" role="status">
      <LoaderCircle size={16} className="spin" aria-label="Loading designer" />
    </div>
  ) : null;
}

export function TableDesignerTab(p: TabViewProps) {
  return (
    <Suspense fallback={<Loading visible={p.visible} />}>
      <LazyTable {...p} />
    </Suspense>
  );
}

export function ViewDesignerTab(p: TabViewProps) {
  return (
    <Suspense fallback={<Loading visible={p.visible} />}>
      <LazyView {...p} />
    </Suspense>
  );
}

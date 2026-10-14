// Lazily loaded codegen tab views (the generators and Monaco language tokenizers are code-split).
import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { TabViewProps } from '../layout/tabViews';

const LazyPanel = lazy(() => import('./CodegenPanel').then((m) => ({ default: m.CodegenTabView })));
const LazyFile = lazy(() => import('./CodegenPanel').then((m) => ({ default: m.GeneratedFileView })));

const fallback = (visible: boolean) =>
  visible ? (
    <div className="workspace-missing" role="status">
      <LoaderCircle size={16} className="spin" aria-label="Loading code generator" />
    </div>
  ) : null;

export function CodegenTab(p: TabViewProps) {
  return (
    <Suspense fallback={fallback(p.visible)}>
      <LazyPanel {...p} />
    </Suspense>
  );
}

export function GeneratedFileTab(p: TabViewProps) {
  return (
    <Suspense fallback={fallback(p.visible)}>
      <LazyFile {...p} />
    </Suspense>
  );
}

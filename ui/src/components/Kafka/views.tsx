// Lazily loaded Kafka tab views (overview, topics, topic + messages, groups, produce are one separate chunk).
import { LoaderCircle } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { TabViewProps } from '../layout/tabViews';

const LazyKafka = lazy(() => import('./KafkaView'));

export function KafkaTab(p: TabViewProps) {
  return (
    <Suspense
      fallback={
        p.visible ? (
          <div className="workspace-missing" role="status">
            <LoaderCircle size={16} className="spin" aria-label="Loading Kafka" />
          </div>
        ) : null
      }
    >
      <LazyKafka {...p} />
    </Suspense>
  );
}

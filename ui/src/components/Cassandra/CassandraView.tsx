// The Cassandra tab views (one lazy chunk): console settings, trace, cluster, table info.
import type { TabViewProps } from '../layout/tabViews';
import { ClusterView } from './ClusterView';
import { CASSANDRA_VIEWS } from './open';
import { SessionView } from './SessionView';
import { TableInfoView } from './TableInfoView';
import { TraceView } from './TraceView';
import './cassandra.css';

export default function CassandraView(p: TabViewProps) {
  switch (p.tab.view) {
    case CASSANDRA_VIEWS.session:
      return <SessionView {...p} />;
    case CASSANDRA_VIEWS.trace:
      return <TraceView {...p} />;
    case CASSANDRA_VIEWS.cluster:
      return <ClusterView {...p} />;
    case CASSANDRA_VIEWS.table:
      return <TableInfoView {...p} />;
    default:
      return <div className="workspace-missing"><p>Unknown Cassandra view {p.tab.view}.</p></div>;
  }
}

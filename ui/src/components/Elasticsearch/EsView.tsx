// The Elasticsearch workspace tab views (one lazy chunk): overview, indices, index, search, console, SQL, tasks.
import type { TabViewProps } from '../layout/tabViews';
import { ConsoleView } from './ConsoleView';
import { IndexView } from './IndexView';
import { IndicesView } from './IndicesView';
import { ES_VIEWS } from './open';
import { OverviewView } from './Overview';
import { SearchView } from './SearchView';
import { SqlView } from './SqlView';
import { TasksView } from './TasksView';
import './es.css';

export default function EsView(p: TabViewProps) {
  const cid = p.tab.connectionId;
  if (!cid) return <div className="workspace-missing"><p>This Elasticsearch tab has no connection.</p></div>;
  switch (p.tab.view) {
    case ES_VIEWS.overview:
      return <OverviewView cid={cid} />;
    case ES_VIEWS.indices:
      return <IndicesView cid={cid} />;
    case ES_VIEWS.index:
      return <IndexView {...p} cid={cid} />;
    case ES_VIEWS.search:
      return <SearchView {...p} cid={cid} />;
    case ES_VIEWS.console:
      return <ConsoleView {...p} cid={cid} />;
    case ES_VIEWS.sql:
      return <SqlView {...p} cid={cid} />;
    case ES_VIEWS.tasks:
      return <TasksView cid={cid} visible={p.visible} />;
    default:
      return <div className="workspace-missing"><p>Unknown Elasticsearch view {p.tab.view}.</p></div>;
  }
}

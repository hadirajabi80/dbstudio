// The Kafka workspace tab views (one lazy chunk): overview, topics, topic (with messages), groups, group, produce.
import type { TabViewProps } from '../layout/tabViews';
import { GroupsView, GroupView } from './Groups';
import { KAFKA_VIEWS, type GroupTabState } from './open';
import { OverviewView } from './Overview';
import { ProduceView } from './Produce';
import { TopicsView } from './Topics';
import { TopicView } from './TopicView';
import './kafka.css';

export default function KafkaView(p: TabViewProps) {
  const cid = p.tab.connectionId;
  if (!cid) return <div className="workspace-missing"><p>This Kafka tab has no connection.</p></div>;
  switch (p.tab.view) {
    case KAFKA_VIEWS.overview:
      return <OverviewView cid={cid} />;
    case KAFKA_VIEWS.topics:
      return <TopicsView cid={cid} />;
    case KAFKA_VIEWS.topic:
    case KAFKA_VIEWS.messages:
      return <TopicView {...p} />;
    case KAFKA_VIEWS.groups:
      return <GroupsView cid={cid} />;
    case KAFKA_VIEWS.group:
      return <GroupView cid={cid} groupId={(p.tab.state as GroupTabState | null)?.groupId ?? ''} visible={p.visible} />;
    case KAFKA_VIEWS.produce:
      return <ProduceView tab={p.tab} theme={p.theme} />;
    default:
      return <div className="workspace-missing"><p>Unknown Kafka view {p.tab.view}.</p></div>;
  }
}

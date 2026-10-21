// The Redis workspace chunk (lazy, docs/PLAN-M2.md D10): every redis.* tab view and the styles.
import type { TabViewProps } from '../layout/tabViews';
import { AnalysisView } from './AnalysisView';
import { BrowserView } from './BrowserView';
import { CliView } from './CliView';
import { InfoView } from './InfoView';
import { PubSubView } from './PubSubView';
import { SlowlogView } from './SlowlogView';
import { WorkbenchView } from './WorkbenchView';
import './redis.css';

export default function RedisView(p: TabViewProps) {
  switch (p.tab.view) {
    case 'redis.browser': return <BrowserView {...p} />;
    case 'redis.workbench': return <WorkbenchView {...p} />;
    case 'redis.cli': return <CliView {...p} />;
    case 'redis.pubsub': return <PubSubView {...p} />;
    case 'redis.slowlog': return <SlowlogView {...p} />;
    case 'redis.info': return <InfoView {...p} />;
    case 'redis.analysis': return <AnalysisView {...p} />;
    default: return <div className="workspace-missing">Unknown Redis view {p.tab.view}</div>;
  }
}

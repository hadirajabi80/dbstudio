// The ClickHouse tab views (one lazy chunk): dispatches on the tab's view id.
import type { TabViewProps } from '../layout/tabViews';
import { MergesView } from './MergesView';
import { MutationsView } from './MutationsView';
import { CH_VIEWS, type ChFilterState, type ChTableState } from './open';
import { PartsView } from './PartsView';
import './clickhouse.css';

export default function ClickHouseView({ tab, visible }: TabViewProps) {
  const cid = tab.connectionId;
  if (!cid) return <div className="ch-empty">This tab has no connection.</div>;
  if (tab.view === CH_VIEWS.parts) {
    const s = (tab.state ?? {}) as Partial<ChTableState>;
    return <PartsView cid={cid} database={s.database ?? 'default'} table={s.table ?? ''} />;
  }
  const f = (tab.state ?? {}) as Partial<ChFilterState>;
  if (tab.view === CH_VIEWS.mutations) return <MutationsView cid={cid} database={f.database ?? null} table={f.table ?? null} visible={visible} />;
  return <MergesView cid={cid} database={f.database ?? null} table={f.table ?? null} visible={visible} />;
}

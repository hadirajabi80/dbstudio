// The "Plan: <console>" tab (registered as tab view 'plan').
import type { TabViewProps } from '../layout/tabViews';
import { copyText } from '../../app/actions';
import { dialectOf } from '../../store/connections';
import { PlanView } from './PlanView';
import { explainInTab, type PlanTabState } from './explain';

export function PlanTabView({ tab }: TabViewProps) {
  const st = tab.state as PlanTabState | null;
  if (!st) return <PlanView plan={null} status="error" error="Nothing to show" />;
  return (
    <PlanView
      plan={st.plan ?? null}
      status={st.status}
      error={st.error}
      sql={st.sql}
      onCopy={(text) => void copyText(text, 'Plan copied')}
      onRerun={() => void explainInTab({
        tabId: st.sourceTabId, dialect: dialectOf(tab.connectionId), mode: st.mode, batch: { sql: st.sql, line: st.line, col: st.col },
      })}
    />
  );
}

export default PlanTabView;

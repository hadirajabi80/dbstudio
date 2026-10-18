import { CircleAlert, CircleCheck, CircleSlash, CircleStop, Layers, LoaderCircle, RotateCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cancelMulti, MULTIRUN_VIEW, rerunMulti, targetTabId, type MultiRunState } from '../../app/multiRun';
import { formatCount, formatDuration } from '../../lib/format';
import { useConnections, dialectOf } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning, type ExecutionState } from '../../store/resultsReducer';
import { useTabs } from '../../store/tabs';
import { connColorCss, connColorName } from '../../theme/connColors';
import { ProviderIcon } from '../common/icons';
import { pluralWord } from '../common/text';
import { ResultsPane } from '../ResultsPane/ResultsPane';
import type { TabViewProps } from '../layout/tabViews';

function summaryOf(e: ExecutionState | undefined): { status: 'running' | 'ok' | 'error' | 'cancelled' | 'idle'; text: string } {
  if (!e) return { status: 'idle', text: '—' };
  if (isRunning(e)) return { status: 'running', text: 'running' };
  if (e.status === 'error' || e.errorCount > 0) return { status: 'error', text: 'error' };
  if (e.status === 'cancelled') return { status: 'cancelled', text: 'cancelled' };
  const rows = e.resultSets.reduce((n, r) => n + r.rowCount, 0);
  const parts = [];
  if (e.resultSets.length) parts.push(`${formatCount(rows)} ${pluralWord(rows, 'row')}`);
  if (e.rowsAffected) parts.push(`${formatCount(e.rowsAffected)} affected`);
  if (e.elapsedMs !== null) parts.push(formatDuration(e.elapsedMs));
  return { status: 'ok', text: parts.join(' · ') || 'ok' };
}

const ICON = { running: LoaderCircle, ok: CircleCheck, error: CircleAlert, cancelled: CircleSlash, idle: CircleSlash };

/** Results of a multi-connection run, grouped by connection: strip `Dev · Test · Prod` + summary `3/3 ok · …`. */
export function MultiRunView({ tab, theme, visible }: TabViewProps) {
  const state = tab.state as MultiRunState;
  const connections = useConnections((s) => s.connections);
  const execs = useResults(useShallow((s) => state.targets.map((t) => s.executions[s.byTab[targetTabId(tab.id, t.connectionId)]])));
  const active = state.active ?? state.targets[0]?.connectionId ?? null;
  const summaries = execs.map(summaryOf);
  const done = summaries.filter((s) => s.status === 'ok').length;
  const running = summaries.some((s) => s.status === 'running');
  const setActive = (cid: string) => useTabs.getState().updateView(tab.id, { state: { ...state, active: cid } });

  return (
    <div className="multirun-view" style={{ display: visible ? undefined : 'none' }} data-command-scope="results">
      <div className="toolbar multirun-toolbar" role="toolbar" aria-label="Multi-run">
        <Layers size={16} strokeWidth={1.5} className="muted" />
        <span className="multirun-title">{state.title}</span>
        <span className="multirun-summary" role="status" aria-live="polite">
          <strong>{done}/{state.targets.length} ok</strong>
          {state.targets.map((t, i) => {
            const c = connections.find((x) => x.id === t.connectionId);
            const s = summaries[i];
            return (
              <span key={t.connectionId} className={`summary-item status-${s.status}`}>
                · {c?.name ?? t.connectionId}: {s.text}
              </span>
            );
          })}
        </span>
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={() => cancelMulti(tab)} disabled={!running}>
          <CircleStop size={13} /> Cancel
        </button>
        <button className="btn btn-xs" onClick={() => rerunMulti(tab)} disabled={running}>
          <RotateCw size={13} /> Run again
        </button>
      </div>
      <div className="multirun-strip" role="tablist" aria-label="Connections">
        {state.targets.map((t, i) => {
          const c = connections.find((x) => x.id === t.connectionId);
          const s = summaries[i];
          const I = ICON[s.status];
          return (
            <button
              key={t.connectionId}
              role="tab"
              aria-selected={active === t.connectionId}
              className={`multirun-tab${active === t.connectionId ? ' active' : ''}`}
              style={{ ['--conn-color' as string]: connColorCss(c?.color) }}
              title={`${c?.name ?? ''}${t.database ? ` · ${t.database}` : ''}${c?.color ? ` (${connColorName(c.color)})` : ''}`}
              onClick={() => setActive(t.connectionId)}
            >
              {c && <ProviderIcon providerId={c.providerId} color={null} size={14} />}
              <span>{c?.name ?? t.connectionId}</span>
              {t.database && <span className="muted">· {t.database}</span>}
              <I size={13} className={`status-${s.status}${s.status === 'running' ? ' spin' : ''}`} aria-label={s.status} />
            </button>
          );
        })}
      </div>
      <div className="multirun-body">
        {state.targets.map((t) => (
          <div key={t.connectionId} className="multirun-pane" style={{ display: active === t.connectionId ? undefined : 'none' }}>
            <ResultsPane tabId={targetTabId(tab.id, t.connectionId)} dialect={dialectOf(t.connectionId)} theme={theme} />
          </div>
        ))}
      </div>
    </div>
  );
}

export { MULTIRUN_VIEW };

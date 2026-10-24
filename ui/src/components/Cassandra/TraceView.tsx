// "Trace" (cassandra.trace): the tracing timeline of one request (GET /cassandra/{cid}/traces/{id}) — header,
// parameters, a waterfall of the events grouped by node, the event table — and the recent traces of the console's
// session (GET /cassandra/sessions/{sid}/traces) to switch between.
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { api } from '../../api/client';
import { engineSocket } from '../../api/ws';
import type { CqlTrace, CqlTraceSummary } from '../../api/types.cassandra';
import { getConnection } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import type { TabViewProps } from '../layout/tabViews';
import { axisTicks, buildTimeline, formatMicros, type Timeline } from './format';
import { onSettingsChanged, type TraceViewState } from './open';
import { Banner, Dash, Empty, RefreshButton, Tile, ViewHeader } from './parts';
import { useLoad } from './useLoad';

const NODE_COLORS = ['--conn-blue', '--conn-green', '--conn-orange', '--conn-purple', '--conn-red', '--conn-yellow'];
/** Re-fetch delays while the coordinator is still writing the trace (system_traces is written asynchronously). */
const INCOMPLETE_RETRY_MS = [400, 800, 1500, 3000, 5000];

const pct = (v: number, total: number) => `${Math.min(100, Math.max(0, (v / total) * 100))}%`;

function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour12: false }) + `.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function TraceView({ tab }: TabViewProps) {
  const st = (tab.state ?? { traceId: null }) as TraceViewState;
  const cid = tab.connectionId;
  const consoleSid = useSessions((s) => (st.consoleTabId ? s.byTab[st.consoleTabId] : undefined));
  const sid = consoleSid ?? st.sessionId ?? null;

  const list = useLoad(sid, () => api.cassandra.sessionTraces(sid!));
  const reloadList = list.reload;
  // new traced statements of the session
  useEffect(() => {
    if (!sid) return;
    const offExec = engineSocket.on('exec.done', (ev) => {
      if (ev.sessionId === sid) reloadList();
    });
    const offCmd = onSettingsChanged(sid, reloadList);
    return () => {
      offExec();
      offCmd();
    };
  }, [sid, reloadList]);

  const selected = st.traceId ?? list.data?.[0]?.traceId ?? null;
  const select = (traceId: string) => useTabs.getState().updateView(tab.id, { state: { ...st, traceId } });
  const trace = useLoad(cid && selected ? `${cid}:${selected}` : null, () => api.cassandra.trace(cid!, selected!));
  const reloadTrace = trace.reload;

  // an incomplete trace (no duration yet): fetch it again a few times
  const attempts = useRef(0);
  useEffect(() => {
    attempts.current = 0;
  }, [selected]);
  const incomplete = !!trace.data && trace.data.durationMicros === null;
  useEffect(() => {
    if (!incomplete || attempts.current >= INCOMPLETE_RETRY_MS.length) return;
    const t = setTimeout(reloadTrace, INCOMPLETE_RETRY_MS[attempts.current++]);
    return () => clearTimeout(t);
  }, [incomplete, trace.data, reloadTrace]);

  const refresh = () => {
    attempts.current = 0;
    reloadList();
    reloadTrace();
  };

  return (
    <div className="cs-view" data-testid="cassandra-trace">
      <ViewHeader title="Trace" subtitle={cid ? getConnection(cid)?.name : undefined}>
        <RefreshButton onClick={refresh} busy={trace.loading || list.loading} />
      </ViewHeader>
      <div className="cs-split">
        {sid && <TraceList idPrefix={tab.id} traces={list.data} error={list.error} selected={selected} onSelect={select} />}
        <div className="cs-split-main">
          {!cid && <Empty>This trace tab has no connection.</Empty>}
          {cid && !selected && (
            <Empty>{list.data && list.data.length === 0
              ? 'No traced statement yet. Turn tracing on (Cassandra: Toggle tracing, or TRACING ON in the console) and run a statement.'
              : list.error ?? 'Loading traces…'}</Empty>
          )}
          {trace.error && <Banner actions={<button type="button" className="btn btn-xs" onClick={reloadTrace}>Retry</button>}>{trace.error}</Banner>}
          {trace.data && <TraceDetail trace={trace.data} incomplete={incomplete} onRefresh={refresh} />}
        </div>
      </div>
    </div>
  );
}

function TraceList({ idPrefix, traces, error, selected, onSelect }: { idPrefix: string; traces: CqlTraceSummary[] | null; error: string | null; selected: string | null; onSelect(id: string): void }) {
  const move = (dir: 1 | -1) => {
    if (!traces?.length) return;
    const i = traces.findIndex((t) => t.traceId === selected);
    const next = traces[Math.min(traces.length - 1, Math.max(0, i + dir))];
    if (next) onSelect(next.traceId);
  };
  return (
    <nav className="cs-split-side" aria-label="Recent traces">
      <div className="cs-side-title">Recent traces</div>
      {error && <div className="cs-side-empty">{error}</div>}
      {traces && traces.length === 0 && <div className="cs-side-empty">None yet</div>}
      {traces && traces.length > 0 && (
        <ul
          className="cs-trace-list" role="listbox" aria-label="Recent traces" tabIndex={0} data-primary-focus
          aria-activedescendant={selected ? `${idPrefix}-tr-${selected}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(e.key === 'ArrowDown' ? 1 : -1);
            }
          }}
        >
          {traces.map((t) => (
            <li
              key={t.traceId} id={`${idPrefix}-tr-${t.traceId}`} role="option" aria-selected={t.traceId === selected}
              className={`cs-trace-item${t.traceId === selected ? ' on' : ''}`} onClick={() => onSelect(t.traceId)} title={t.statement}
            >
              <span className="cs-trace-stmt mono">{t.statement}</span>
              <span className="cs-trace-meta">
                <span>{timeOf(t.startedAt)}</span>
                <span>{t.consistency ?? ''}</span>
                <span className="num">{formatMicros(t.durationMicros)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function TraceDetail({ trace, incomplete, onRefresh }: { trace: CqlTrace; incomplete: boolean; onRefresh(): void }) {
  const timeline = useMemo(() => buildTimeline(trace), [trace]);
  const { query, ...params } = trace.parameters;
  return (
    <div className="cs-scroll" data-testid="cassandra-trace-detail">
      {incomplete && (
        <Banner tone="info" actions={<button type="button" className="btn btn-xs" onClick={onRefresh}>Refresh</button>}>
          The coordinator is still writing this trace (system_traces is written asynchronously): {trace.events.length} events so far.
        </Banner>
      )}
      <div className="cs-tiles" role="list" aria-label="Trace summary">
        <Tile label="Duration" value={incomplete ? '…' : formatMicros(trace.durationMicros)} />
        <Tile label="Coordinator" value={trace.coordinator ?? '—'} />
        <Tile label="Client" value={trace.client ?? '—'} />
        <Tile label="Started" value={timeOf(trace.startedAt) || '—'} title={trace.startedAt ?? undefined} />
        <Tile label="Events" value={trace.events.length} />
        <Tile label="Nodes" value={timeline.nodes.length} />
      </div>
      <dl className="cs-dl cs-dl-rows">
        <div><dt>Request</dt><dd>{trace.request ?? <Dash />}{trace.command && <span className="muted"> · {trace.command}</span>}</dd></div>
        <div><dt>Trace id</dt><dd><code className="mono">{trace.traceId}</code></dd></div>
        {Object.entries(params).map(([k, v]) => (
          <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd><code className="mono">{v}</code></dd></div>
        ))}
      </dl>
      {query && <pre className="cs-code" aria-label="Query">{query}</pre>}
      <h3 className="cs-section-title">Timeline</h3>
      {timeline.events.length === 0 ? <Empty>No events.</Empty> : <Waterfall timeline={timeline} />}
      {!timeline.aligned && timeline.nodes.length > 1 && (
        <p className="cs-note">The event ids are not time-based, so each node is drawn on its own clock (time since it received the request).</p>
      )}
      <h3 className="cs-section-title">Events</h3>
      <div className="cs-table-wrap">
        <table className="cs-table" aria-label="Trace events">
          <thead>
            <tr><th className="num">At</th><th className="num">+ step</th><th>Source</th><th className="num">Source elapsed</th><th>Thread</th><th>Activity</th></tr>
          </thead>
          <tbody>
            {timeline.events.map((e) => (
              <tr key={e.eventId}>
                <td className="num">{formatMicros(e.at)}</td>
                <td className="num muted">{formatMicros(e.step)}</td>
                <td className="mono">{e.source}</td>
                <td className="num">{e.sourceElapsedMicros.toLocaleString('en-US')} µs</td>
                <td className="mono muted">{e.thread ?? ''}</td>
                <td className="cs-activity">{e.activity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Waterfall({ timeline }: { timeline: Timeline }) {
  const { total } = timeline;
  const ticks = axisTicks(total);
  return (
    <div className="cs-wf" role="table" aria-label="Trace timeline" data-testid="cassandra-waterfall">
      <div className="cs-wf-row cs-wf-axis" role="row" aria-hidden="true">
        <div className="cs-wf-label" />
        <div className="cs-wf-track">
          {ticks.map((t) => (
            <span key={t} className="cs-wf-tick" style={{ left: pct(t, total) }}>{formatMicros(t)}</span>
          ))}
        </div>
        <div className="cs-wf-time">{formatMicros(total)}</div>
      </div>
      {timeline.nodes.map((n, i) => (
        <div key={n.source} className="cs-wf-node" role="rowgroup" style={{ '--cs-node': `var(${NODE_COLORS[i % NODE_COLORS.length]})` } as CSSProperties}>
          <div className="cs-wf-row cs-wf-head" role="row">
            <div className="cs-wf-label" role="rowheader">
              <span className="cs-swatch" aria-hidden="true" />
              <span className="mono">{n.source}</span>
              {n.coordinator && <span className="pill">coordinator</span>}
              <span className="muted"> {n.events.length} event{n.events.length === 1 ? '' : 's'}</span>
            </div>
            <div className="cs-wf-track" role="cell" aria-label={`${formatMicros(n.start)} to ${formatMicros(n.end)}`}>
              <div className="cs-wf-span" style={{ left: pct(n.start, total), width: pct(n.end - n.start, total) }} />
            </div>
            <div className="cs-wf-time" role="cell">{formatMicros(n.end - n.start)}</div>
          </div>
          {n.events.map((e) => (
            <div key={e.eventId} className="cs-wf-row" role="row">
              <div className="cs-wf-label cs-wf-activity" role="cell" title={e.activity}>{e.activity}</div>
              <div className="cs-wf-track" role="cell" title={`${formatMicros(e.at)} (+${formatMicros(e.step)}) · ${e.thread ?? ''}`}>
                <div className="cs-wf-bar" style={{ left: pct(e.at - e.step, total), width: pct(e.step, total) }} />
                <div className="cs-wf-dot" style={{ left: pct(e.at, total) }} />
              </div>
              <div className="cs-wf-time" role="cell">{formatMicros(e.at)}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

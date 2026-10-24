// Aggregations viewer (plan-batch3 WP-ES): bucket aggregations as tables with inline bars (doc_count) and the metrics
// of their sub-aggregations as columns; nested bucket aggregations expand under their bucket; metric aggregations as
// tiles; top_hits as lists.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { formatMetric, type AggView, type BucketsView } from '../../es/aggs';
import { JsonTree } from './JsonTree';

export function AggsViewer({ views }: { views: AggView[] }) {
  return <div className="es-aggs">{views.map((v) => <AggBlock key={v.name} view={v} />)}</div>;
}

function AggBlock({ view, nested }: { view: AggView; nested?: boolean }) {
  switch (view.kind) {
    case 'metric':
      return (
        <section className={`es-agg${nested ? ' nested' : ''}`} aria-label={`Aggregation ${view.name}`}>
          <h4 className="es-agg-title">{view.name}</h4>
          <div className="es-agg-metrics">
            {view.values.map((v) => (
              <div key={v.label} className="es-agg-metric">
                <div className="es-agg-metric-value">{formatMetric(v.value)}</div>
                <div className="es-agg-metric-label">{v.label}</div>
              </div>
            ))}
          </div>
        </section>
      );
    case 'buckets':
      return <BucketsTable view={view} nested={nested} />;
    case 'single':
      return (
        <section className={`es-agg${nested ? ' nested' : ''}`} aria-label={`Aggregation ${view.name}`}>
          <h4 className="es-agg-title">{view.name} <span className="muted">· {view.docCount.toLocaleString('en-US')} docs</span></h4>
          {view.children.map((c) => <AggBlock key={c.name} view={c} nested />)}
        </section>
      );
    case 'hits':
      return (
        <section className={`es-agg${nested ? ' nested' : ''}`} aria-label={`Aggregation ${view.name}`}>
          <h4 className="es-agg-title">{view.name} <span className="muted">· top {view.hits.length}{view.total != null ? ` of ${view.total.toLocaleString('en-US')}` : ''}</span></h4>
          {view.hits.map((h) => <div key={h.id} className="es-agg-hit"><span className="mono muted">{h.id}</span><JsonTree value={h.source} openDepth={0} /></div>)}
        </section>
      );
    default:
      return (
        <section className={`es-agg${nested ? ' nested' : ''}`} aria-label={`Aggregation ${view.name}`}>
          <h4 className="es-agg-title">{view.name}</h4>
          <JsonTree value={view.value} openDepth={2} />
        </section>
      );
  }
}

function BucketsTable({ view, nested }: { view: BucketsView; nested?: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const hasChildren = view.rows.some((r) => r.children.length > 0);
  return (
    <section className={`es-agg${nested ? ' nested' : ''}`} aria-label={`Aggregation ${view.name}`}>
      <h4 className="es-agg-title">{view.name} <span className="muted">· {view.rows.length} bucket{view.rows.length === 1 ? '' : 's'}{view.otherDocs ? ` · ${view.otherDocs.toLocaleString('en-US')} docs in other buckets` : ''}</span></h4>
      <table className="es-table es-agg-table">
        <thead>
          <tr>
            {hasChildren && <th className="es-agg-tw"><span className="sr-only">Expand</span></th>}
            <th>Key</th>
            <th className="num es-agg-count">Doc count</th>
            {view.metricNames.map((m) => <th key={m} className="num">{m}</th>)}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r, i) => {
            const isOpen = open.has(i);
            return (
              <Fragment key={i}>
                <tr>
                  {hasChildren && (
                    <td className="es-agg-tw">
                      {r.children.length > 0 && (
                        <button type="button" className="icon-btn xs" aria-label={isOpen ? `Collapse ${r.key}` : `Expand ${r.key}`} onClick={() => setOpen((s) => {
                          const n = new Set(s);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        })}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                      )}
                    </td>
                  )}
                  <td className="mono" dir="auto">{r.key}</td>
                  <td className="num es-agg-count">
                    <span className="es-agg-bar"><span style={{ width: `${view.maxCount ? Math.max(1, (r.docCount / view.maxCount) * 100) : 0}%` }} /></span>
                    {r.docCount.toLocaleString('en-US')}
                  </td>
                  {view.metricNames.map((m) => <td key={m} className="num">{formatMetric(r.metrics[m] ?? null)}</td>)}
                </tr>
                {isOpen && (
                  <tr className="es-agg-children">
                    <td colSpan={2 + view.metricNames.length + (hasChildren ? 1 : 0)}>{r.children.map((c) => <AggBlock key={c.name} view={c} nested />)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

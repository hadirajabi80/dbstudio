// Details pane (right): the selected table (columns, foreign keys, referencing tables, row estimate, Open data /
// Design) or, with nothing selected, a summary of the diagram and the notation legend.
import { ArrowRight, KeyRound, Link } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { api } from '../../api/client';
import { CommandButton } from '../layout/CommandButton';
import type { ErCardArgs } from './controllers';
import type { ErController } from './store';

function Legend() {
  return (
    <div className="er-legend" aria-label="Notation">
      <div className="er-legend-title">Notation</div>
      <svg width="200" height="78" viewBox="0 0 200 78" aria-hidden="true" className="er-legend-svg">
        <g className="er-edge"><path className="er-edge-line" d="M10 14H150" /><path className="er-edge-mark" d="M22 14L10 8M22 14L10 20M26 8V20M143 8V20M138 8V20" /></g>
        <g className="er-edge optional"><path className="er-edge-line" d="M10 44H150" /><path className="er-edge-mark" d="M22 44L10 38M22 44L10 50M143 38V50" /><circle className="er-edge-ring" cx="29.5" cy="44" r="3.5" /><circle className="er-edge-ring" cx="135" cy="44" r="3.5" /></g>
        <g className="er-edge ghost"><path className="er-edge-line" d="M10 70H150" /></g>
      </svg>
      <ul className="er-legend-list">
        <li><span>many ─ one</span> required foreign key (crow's foot on the referencing table)</li>
        <li><span>dashed</span> optional: the FK columns are nullable</li>
        <li><span>dotted</span> to a table outside the diagram (click it to add)</li>
      </ul>
    </div>
  );
}

export function DetailsPane({ c, tabId }: { c: ErController; tabId: string }) {
  const model = useStore(c.store, (s) => s.model);
  const focusKey = useStore(c.store, (s) => s.focusKey);
  const selection = useStore(c.store, (s) => s.selection);
  const connectionId = useStore(c.store, (s) => s.connectionId);
  const database = useStore(c.store, (s) => s.database);
  const synthetic = useStore(c.store, (s) => !!s.synthetic);
  const key = selection.length === 1 ? selection[0] : selection.length === 0 ? focusKey : null;
  const n = key ? model?.byKey.get(key) : undefined;
  const [rows, setRows] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!n || n.ghost || synthetic || n.key in rows) return;
    let cancelled = false;
    api.objectDetails(connectionId, database, { database, schema: n.schema || null, name: n.name, type: n.type })
      .then((d) => !cancelled && setRows((r) => ({ ...r, [n.key]: d.rowCountEstimate })))
      .catch(() => !cancelled && setRows((r) => ({ ...r, [n.key]: null })));
    return () => {
      cancelled = true;
    };
  }, [n, synthetic, connectionId, database, rows]);

  if (!model) return <aside className="er-details" aria-label="Diagram details" />;

  if (!n) {
    const schemas = new Set(model.nodes.filter((x) => !x.ghost).map((x) => x.schema));
    const ghosts = model.nodes.length - model.memberCount;
    return (
      <aside className="er-details" aria-label="Diagram details">
        <h2 className="er-details-title">Diagram</h2>
        <dl className="er-details-stats">
          <div><dt>Tables</dt><dd>{model.memberCount}</dd></div>
          <div><dt>Relationships</dt><dd>{model.edges.length}</dd></div>
          <div><dt>Schemas</dt><dd>{schemas.size}</dd></div>
          {ghosts > 0 && <div><dt>Outside the diagram</dt><dd>{ghosts}</dd></div>}
        </dl>
        {selection.length > 1 && <p className="er-details-hint">{selection.length} tables selected. Drag one to move them all, Delete removes them from the diagram.</p>}
        {selection.length === 0 && <p className="er-details-hint">Select a table to see its columns and keys.</p>}
        <Legend />
      </aside>
    );
  }

  const args: ErCardArgs = { kind: 'er-card', tabId, key: n.key };
  const outgoing = model.edges.filter((e) => e.from === n.key);
  const incoming = model.edges.filter((e) => e.to === n.key && e.from !== n.key);
  const label = (k: string) => model.byKey.get(k)?.label ?? k;
  const est = rows[n.key];
  return (
    <aside className="er-details" aria-label={`Details of ${n.label}`}>
      <h2 className="er-details-title" title={n.label}>{n.label}</h2>
      <div className="er-details-sub">
        {n.ghost ? 'Outside the diagram' : n.type === 'table' ? 'Table' : 'View'} · {n.columns.length} columns · {n.fks.length} FK{n.fks.length === 1 ? '' : 's'}
        {est != null && <> · ~{est.toLocaleString()} rows</>}
      </div>
      {n.comment && <p className="er-details-comment">{n.comment}</p>}
      <div className="er-details-actions">
        {n.ghost ? (
          <CommandButton command="er.addGhost" args={args} variant="btn" label="Add to diagram" />
        ) : (
          <>
            <CommandButton command="er.openData" args={args} variant="btn" label="Open data" />
            <CommandButton command="er.design" args={args} variant="btn" label="Design" />
          </>
        )}
      </div>
      {outgoing.length > 0 && (
        <section className="er-details-section">
          <h3>References</h3>
          <ul>
            {outgoing.map((e) => (
              <li key={e.id}>
                <button type="button" className="er-details-link" onClick={() => model.byKey.get(e.to) && c.focusCard(e.to)}>
                  <span className="er-details-fk">{e.name}</span>
                  <span className="er-details-pair">{e.cols.join(', ')} <ArrowRight size={11} aria-hidden="true" /> {label(e.to)}{e.rcols.length ? ` (${e.rcols.join(', ')})` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {incoming.length > 0 && (
        <section className="er-details-section">
          <h3>Referenced by</h3>
          <ul>
            {incoming.map((e) => (
              <li key={e.id}>
                <button type="button" className="er-details-link" onClick={() => c.focusCard(e.from)}>
                  <span className="er-details-fk">{label(e.from)}</span>
                  <span className="er-details-pair">{e.cols.join(', ')} · {e.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {n.columns.length > 0 && (
        <section className="er-details-section">
          <h3>Columns</h3>
          <ul className="er-details-cols">
            {n.columns.map((col) => (
              <li key={col.name}>
                <span className="er-details-colkey" aria-hidden="true">{col.pk ? <KeyRound size={11} className="obj-pk" /> : col.fk ? <Link size={11} className="obj-fk" /> : null}</span>
                <span className="er-details-colname">{col.name}{col.pk && <span className="sr-only"> (primary key)</span>}{col.fk && <span className="sr-only"> (foreign key)</span>}</span>
                <span className="er-details-coltype">{col.type}{col.nullable ? ' null' : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

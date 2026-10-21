// One table card (docs/PLAN-M2.md section 3): header (icon, schema-qualified name outside the main schema, column
// count, pin), fixed-height column rows (PK key / FK link badges, nullable "?", type text), truncated at 25 columns
// with an expandable "+N more" row. Level of detail: < 45 % zoom header + row stripes, < 20 % a coloured box.
import { Eye, KeyRound, Link, Pin, Plus, Table2 } from 'lucide-react';
import { memo } from 'react';
import { CARD, type CardGeom, type ErNode } from './model';
import type { Lod } from './viewport';

export interface TableCardProps {
  node: ErNode;
  geom: CardGeom;
  x: number;
  y: number;
  lod: Lod;
  selected: boolean;
  focused: boolean;
  /** Another card is hovered and this one is not its neighbour. */
  dim: boolean;
  /** Neighbour of the hovered card. */
  related: boolean;
  match: boolean;
  /** Pulse animation key (search hit); changes restart the animation. */
  pulse: number | null;
  pinned: boolean;
  showTypes: boolean;
  /** FK drag: column handles are offered (false: read-only connection / SQLite, `fkDisabledReason` explains). */
  fkHandles: boolean;
  fkDisabledReason: string | null;
  /** Row under the pointer during an FK drag (`drop target`). */
  dropColumn: string | null;
  fkCount: number;
}

function ariaLabel(n: ErNode, fkCount: number): string {
  const kind = n.ghost ? 'Referenced table outside the diagram' : n.type === 'table' ? 'Table' : 'View';
  const cols = n.columns.length ? `, ${n.columns.length} columns` : '';
  const fks = fkCount ? `, ${fkCount} foreign key${fkCount === 1 ? '' : 's'}` : '';
  return `${kind} ${n.label}${cols}${fks}${n.ghost ? '. Click to add it to the diagram' : ''}`;
}

export const TableCard = memo(function TableCard(p: TableCardProps) {
  const { node: n, geom: g, lod } = p;
  const cls = [
    'er-card', n.ghost ? 'ghost' : n.type, `lod-${lod}`, p.selected && 'sel', p.focused && 'focus', p.dim && 'dim', p.related && 'related',
    p.match && 'match', p.pulse !== null && 'pulse',
  ].filter(Boolean).join(' ');
  const prefix = n.label !== n.name ? `${n.schema}.` : '';
  return (
    <div
      className={cls}
      key={p.pulse ?? undefined}
      data-key={n.key}
      role="button"
      tabIndex={p.focused ? 0 : -1}
      aria-label={ariaLabel(n, p.fkCount)}
      aria-pressed={n.ghost ? undefined : p.selected}
      title={lod === 'box' ? n.label : undefined}
      style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: g.w, height: g.h }}
    >
      {lod === 'box' ? (
        <span className="er-box-name" aria-hidden="true">{n.name}</span>
      ) : (
        <>
          <div className="er-card-head" style={{ height: CARD.headerH }}>
            {n.ghost ? <Plus size={14} className="er-card-icon" aria-hidden="true" /> : n.type === 'table'
              ? <Table2 size={14} strokeWidth={1.75} className="er-card-icon obj-table" aria-hidden="true" />
              : <Eye size={14} strokeWidth={1.75} className="er-card-icon obj-view" aria-hidden="true" />}
            <span className="er-card-title">
              {prefix && <span className="er-card-schema">{prefix}</span>}
              <span className="er-card-name">{n.name}</span>
            </span>
            {p.pinned && <Pin size={12} className="er-card-pin" aria-label="Pinned" />}
            {!n.ghost && lod === 'full' && <span className="er-card-count" aria-hidden="true">{n.columns.length}</span>}
          </div>
          {lod === 'full' ? (
            g.rows.length > 0 || g.moreRow ? (
              <div className="er-card-rows" style={{ paddingTop: CARD.padY, paddingBottom: CARD.padY }}>
                {g.rows.map((r) => (
                  <div
                    key={r.col.name}
                    className={`er-row${r.col.pk ? ' pk' : ''}${r.col.fk ? ' fk' : ''}${p.dropColumn === r.col.name ? ' drop' : ''}`}
                    data-col={r.col.name}
                    style={{ height: CARD.rowH }}
                  >
                    <span className="er-row-key" aria-hidden="true">
                      {r.col.pk ? <KeyRound size={12} strokeWidth={2} /> : r.col.fk ? <Link size={12} strokeWidth={2} /> : null}
                    </span>
                    <span className="er-row-name">{r.col.name}</span>
                    {r.col.nullable && <span className="er-row-null" title="Nullable">?</span>}
                    {p.showTypes && <span className="er-row-type">{r.col.type}</span>}
                    {!n.ghost && (
                      <span
                        className={`er-row-handle${p.fkHandles ? '' : ' off'}`}
                        data-handle={r.col.name}
                        title={p.fkHandles ? 'Drag to a column of another table to create a foreign key' : p.fkDisabledReason ?? undefined}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                ))}
                {g.moreRow && (
                  <button type="button" className="er-row er-row-more" data-more="1" style={{ height: CARD.rowH }} tabIndex={-1}>
                    {g.more > 0 ? `+${g.more} more` : 'Show fewer'}
                  </button>
                )}
              </div>
            ) : null
          ) : g.rows.length > 0 ? (
            <div className="er-card-lod" aria-hidden="true" style={{ top: CARD.headerH + CARD.padY, backgroundSize: `100% ${CARD.rowH}px` }} />
          ) : null}
        </>
      )}
    </div>
  );
});

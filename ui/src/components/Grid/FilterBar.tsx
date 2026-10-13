import { Funnel, Plus, Search, X } from 'lucide-react';
import type { ColumnInfo } from '../../api/types';
import {
  countConditions, newCondition, newGroup, OPERATORS, removeNode, updateNode, type FilterCondition, type FilterGroup,
  type FilterNode, type GridViewModel,
} from '../../lib/filter';
import { isNumericKind } from '../../lib/format';

interface Props {
  columns: ColumnInfo[];
  view: GridViewModel;
  onChange: (v: Partial<GridViewModel>) => void;
  showBuilder: boolean;
  onToggleBuilder: () => void;
}

/** Quick search + structured filter builder over the GridViewModel filter tree. */
export function FilterBar({ columns, view, onChange, showBuilder, onToggleBuilder }: Props) {
  const n = countConditions(view.filter);
  return (
    <div className="filter-bar">
      <div className="filter-quick">
        <Search size={13} />
        <input
          className="input xs borderless"
          placeholder="Search in results"
          aria-label="Search in results"
          value={view.quickFilter}
          spellCheck={false}
          onChange={(e) => onChange({ quickFilter: e.target.value })}
          onKeyDown={(e) => e.key === 'Escape' && onChange({ quickFilter: '' })}
        />
        {view.quickFilter && (
          <button className="icon-btn xs" aria-label="Clear search" onClick={() => onChange({ quickFilter: '' })}>
            <X size={12} />
          </button>
        )}
      </div>
      <button className={`btn btn-xs${showBuilder || n ? ' on' : ''}`} onClick={onToggleBuilder} title="Filter rows">
        <Funnel size={12} /> Filter{n ? ` (${n})` : ''}
      </button>
      {view.sort.length > 0 && (
        <button className="btn btn-xs" onClick={() => onChange({ sort: [] })} title="Clear sorting">
          Sorted by {view.sort.map((s) => `${columns[s.column]?.name} ${s.dir}`).join(', ')} <X size={11} />
        </button>
      )}
      {showBuilder && (
        <div className="filter-builder">
          <GroupEditor
            group={view.filter ?? newGroup('and')}
            columns={columns}
            root
            onChange={(g) => onChange({ filter: g.items.length ? g : null })}
          />
        </div>
      )}
    </div>
  );
}

function GroupEditor({ group, columns, root, onChange, onRemove }: {
  group: FilterGroup; columns: ColumnInfo[]; root?: boolean; onChange: (g: FilterGroup) => void; onRemove?: () => void;
}) {
  const setItem = (id: string, fn: (n: FilterNode) => FilterNode) => onChange(updateNode(group, id, fn));
  const addCondition = () => {
    const col = 0;
    onChange({ ...group, items: [...group.items, newCondition(col, columns[col] && isNumericKind(columns[col].kind) ? 'eq' : 'contains')] });
  };
  return (
    <div className={`filter-group${root ? ' root' : ''}`}>
      {group.items.map((it, i) => (
        <div className="filter-item" key={it.id}>
          {i > 0 ? (
            <button
              className="logic-toggle"
              title="Switch AND / OR"
              onClick={() => onChange({ ...group, logic: group.logic === 'and' ? 'or' : 'and' })}
            >
              {group.logic.toUpperCase()}
            </button>
          ) : (
            <span className="logic-toggle placeholder">{root ? 'WHERE' : '('}</span>
          )}
          {it.kind === 'condition' ? (
            <ConditionEditor
              c={it}
              columns={columns}
              onChange={(c) => setItem(it.id, () => c)}
              onRemove={() => onChange(removeNode(group, it.id))}
            />
          ) : (
            <GroupEditor group={it} columns={columns} onChange={(g) => setItem(it.id, () => g)} onRemove={() => onChange(removeNode(group, it.id))} />
          )}
        </div>
      ))}
      <div className="filter-actions">
        <button className="btn btn-xs" onClick={addCondition}>
          <Plus size={12} /> Condition
        </button>
        <button className="btn btn-xs" onClick={() => onChange({ ...group, items: [...group.items, newGroup(group.logic === 'and' ? 'or' : 'and', [newCondition(0)])] })}>
          <Plus size={12} /> Group
        </button>
        {root && group.items.length > 0 && (
          <button className="btn btn-xs" onClick={() => onChange({ ...group, items: [] })}>
            Clear
          </button>
        )}
        {!root && onRemove && (
          <button className="icon-btn xs" title="Remove group" onClick={onRemove}>
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function ConditionEditor({ c, columns, onChange, onRemove }: {
  c: FilterCondition; columns: ColumnInfo[]; onChange: (c: FilterCondition) => void; onRemove: () => void;
}) {
  const unary = OPERATORS.find((o) => o.op === c.op)?.unary;
  return (
    <div className={`filter-cond${c.enabled === false ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        checked={c.enabled !== false}
        title="Enable condition"
        aria-label="Enable condition"
        onChange={(e) => onChange({ ...c, enabled: e.target.checked })}
      />
      <select className="input xs" aria-label="Column" value={c.column} onChange={(e) => onChange({ ...c, column: Number(e.target.value) })}>
        {columns.map((col, i) => (
          <option key={i} value={i}>
            {col.name || `column${i + 1}`}
          </option>
        ))}
      </select>
      <select className="input xs" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as FilterCondition['op'] })}>
        {OPERATORS.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {!unary && (
        <input
          className="input xs"
          aria-label="Value"
          value={c.value}
          placeholder={c.op === 'in' ? 'a, b, c' : 'value'}
          spellCheck={false}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      <button className="icon-btn xs" title="Remove condition" aria-label="Remove condition" onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

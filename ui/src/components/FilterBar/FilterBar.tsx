// Filter bar docked above a grid (PLAN-M1.5 1.1.1): AND/OR condition builder with type-aware operators,
// saved / recent filters, and "Apply on server".
import { Bookmark, ChevronDown, CloudUpload, Funnel, ListFilter, LoaderCircle, Plus, Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ColumnInfo, Dialect } from '../../api/types';
import { errorMessage } from '../../api/client';
import {
  cloneWithNewIds, countConditions, newCondition, newGroup, normalizeModel, removeNode, toFilterModel, updateNode,
  type FilterGroup, type FilterNode,
} from '../../filter/model';
import { defaultOperator } from '../../filter/operators';
import { recentKey, savedFor, useFilters } from '../../store/filters';
import { toast } from '../../store/ui';
import { showMenuBelow, type MenuItem } from '../common/Menu';
import { ConditionRow } from './ConditionRow';
import { ManageFiltersDialog } from './ManageFiltersDialog';
import { describeModel } from './describe';
import './filterbar.css';

export interface ServerFilterControl {
  /** Can the filter be pushed (single SELECT, …)? */
  available: boolean;
  /** Tooltip when not available. */
  reason?: string | null;
  /** The current result already comes from a server filter. */
  active: boolean;
  busy?: boolean;
  /** Generated SQL (tooltip). */
  previewSql?: string | null;
  onApply(): void;
  onClear?(): void;
}

export interface FilterBarProps {
  columns: ColumnInfo[];
  filter: FilterGroup | null;
  quick: string;
  onChange(filter: FilterGroup | null): void;
  onQuickChange?(q: string): void;
  onClose(): void;
  dialect: Dialect;
  /** Server filtering (console: button; data tab: always on). */
  server?: ServerFilterControl | null;
  /** Data tab: every change is applied on the server (no separate Apply step). */
  serverAlways?: boolean;
  /** Saved-filter scope; null hides Save / saved list. */
  saved?: { connectionId: string; signature: string } | null;
  /** Focus a new condition on this column (header "Filter column…"). */
  focusRequest?: { column: string | null; nonce: number } | null;
  /** Status text ("Filtered 312 of 10,000"). */
  status?: string | null;
}

export function FilterBar(p: FilterBarProps) {
  const { columns, filter, onChange, saved } = p;
  const root = filter ?? newGroup('and');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const savedState = useFilters((s) => (saved ? s.saved[saved.connectionId] : undefined));
  const savedStatus = useFilters((s) => (saved ? s.status[saved.connectionId] : undefined));
  const recent = useFilters((s) => (saved ? s.recent[recentKey(saved.connectionId, saved.signature)] : undefined));
  const matching = useMemo(() => (saved ? savedFor(savedState, saved.signature) : []), [savedState, saved]);
  const n = countConditions(filter);

  useEffect(() => {
    if (saved) void useFilters.getState().load(saved.connectionId);
  }, [saved?.connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Header "Filter column…": add a condition on that column and focus it.
  useEffect(() => {
    const req = p.focusRequest;
    if (!req) return;
    if (!req.column) {
      if (root.items.length === 0) addCondition();
      return;
    }
    const idx = columns.findIndex((c) => c.name === req.column);
    if (idx < 0) return;
    const c = newCondition(columns[idx].name, defaultOperator(columns[idx].kind), [], idx);
    onChange({ ...root, items: [...root.items, c] });
    setFocusId(c.id);
  }, [p.focusRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (g: FilterGroup) => onChange(g.items.length ? g : null);

  function addCondition(group: FilterGroup = root) {
    const used = new Set<string>();
    group.items.forEach((i) => i.kind === 'condition' && used.add(i.column));
    const idx = Math.max(0, columns.findIndex((c) => !used.has(c.name)));
    const c = newCondition(columns[idx]?.name ?? '', defaultOperator(columns[idx]?.kind), [], idx);
    if (group === root) commit({ ...root, items: [...root.items, c] });
    else commit(updateNode(root, group.id, (g) => ({ ...(g as FilterGroup), items: [...(g as FilterGroup).items, c] })));
    setFocusId(c.id);
  }

  const addGroup = () => {
    const idx = 0;
    const c = newCondition(columns[idx]?.name ?? '', defaultOperator(columns[idx]?.kind), [], idx);
    commit({ ...root, items: [...root.items, newGroup(root.logic === 'and' ? 'or' : 'and', [c])] });
    setFocusId(c.id);
  };

  const applyModel = (m: unknown, savedId?: string) => {
    const model = normalizeModel(m, columns);
    onChange(model.root.items.length ? cloneWithNewIds(model.root) : null);
    if (model.quick !== undefined) p.onQuickChange?.(model.quick);
    if (savedId) useFilters.getState().touch(savedId);
  };

  const filterMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [];
    if (!saved) items.push({ label: 'Saved filters need a connection', disabled: true });
    else if (savedStatus === 'error') items.push({ label: 'Saved filters are unavailable (engine)', disabled: true });
    else if (matching.length === 0) items.push({ label: 'No saved filters for these columns', disabled: true });
    for (const f of matching) items.push({ label: f.name, icon: <Bookmark size={13} />, onClick: () => applyModel(f.model, f.id) });
    items.push({ separator: true });
    items.push({
      label: `Recent (${recent?.length ?? 0})`,
      disabled: !recent?.length,
      submenu: (recent ?? []).map((m) => ({ label: describeModel(normalizeModel(m)), onClick: () => applyModel(m) })),
    });
    items.push({ label: 'Manage…', disabled: !saved, onClick: () => setManage(true) });
    showMenuBelow(el, items);
  };

  const doSave = async (name: string) => {
    if (!saved || !name.trim()) return;
    try {
      const f = await useFilters.getState().save(saved.connectionId, saved.signature, name.trim(), toFilterModel({ filter, quickFilter: p.quick }));
      toast('success', `Saved filter “${f.name}”`);
      setSaving(null);
    } catch (e) {
      toast('error', 'Could not save the filter', errorMessage(e));
    }
  };

  const saveMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [{ label: 'Save as…', onClick: () => setSaving('') }];
    for (const f of matching.slice(0, 8)) {
      items.push({
        label: `Update “${f.name}”`,
        onClick: () => void doSave(f.name),
      });
    }
    showMenuBelow(el, items);
  };

  // Recent list follows every applied filter.
  useEffect(() => {
    if (!saved || (!filter && !p.quick)) return;
    const t = setTimeout(() => useFilters.getState().pushRecent(saved.connectionId, saved.signature, toFilterModel({ filter, quickFilter: p.quick })), 1500);
    return () => clearTimeout(t);
  }, [filter, p.quick, saved?.connectionId, saved?.signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const server = p.server;
  return (
    <div
      className="fb"
      role="search"
      aria-label="Filter rows"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          p.onClose();
        } else if (e.key === 'Enter' && e.ctrlKey && e.shiftKey && server?.available) {
          e.preventDefault();
          server.onApply();
        }
      }}
    >
      <div className="fb-actions">
        <button className="btn btn-xs fb-menu" onClick={(e) => filterMenu(e.currentTarget)} title="Saved and recent filters" aria-haspopup="menu">
          <ListFilter size={13} /> Filter <ChevronDown size={11} />
        </button>
        <button className="btn btn-xs" onClick={() => addCondition()} title="Add a condition (AND)">
          <Plus size={12} /> Add condition
        </button>
        <button className="btn btn-xs" onClick={addGroup} title="Add a nested group with the opposite logic">
          <span className="fb-paren">( )</span> Group
        </button>
        {server && !p.serverAlways && (
          <button
            className={`btn btn-xs${server.active ? ' on' : ''}`}
            disabled={!server.available || server.busy}
            onClick={server.onApply}
            title={server.available ? `Run the statement again with this filter as a WHERE clause (Ctrl+Shift+Enter)${server.previewSql ? `\n\n${server.previewSql}` : ''}` : server.reason ?? 'Server filtering needs a single SELECT'}
          >
            {server.busy ? <LoaderCircle size={12} className="spin" /> : <CloudUpload size={12} />} Apply on server
          </button>
        )}
        {server?.active && !p.serverAlways && server.onClear && (
          <button className="btn btn-xs" onClick={server.onClear} title="Run the original statement again">
            Remove server filter
          </button>
        )}
        {saved && (
          saving !== null ? (
            <form
              className="fb-save"
              onSubmit={(e) => {
                e.preventDefault();
                void doSave(saving);
              }}
            >
              <input
                className="input xs"
                autoFocus
                placeholder="Filter name"
                aria-label="Filter name"
                value={saving}
                onChange={(e) => setSaving(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSaving(null))}
              />
              <button className="btn btn-xs btn-primary" type="submit" disabled={!saving.trim() || (!filter && !p.quick)}>
                Save
              </button>
              <button className="btn btn-xs" type="button" onClick={() => setSaving(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <button className="btn btn-xs" disabled={!filter && !p.quick} onClick={(e) => saveMenu(e.currentTarget)} title="Save this filter for results with the same columns" aria-haspopup="menu">
              <Save size={12} /> Save <ChevronDown size={11} />
            </button>
          )
        )}
        <button className="btn btn-xs" disabled={n === 0 && !filter} onClick={() => onChange(null)}>
          Clear
        </button>
        <div className="flex-1" />
        {p.status && (
          <span className="fb-status">
            <Funnel size={11} /> {p.status}
          </span>
        )}
        <button className="icon-btn sm fb-close" title="Close filter bar (Esc) — the filter stays active" aria-label="Close filter bar" onClick={p.onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="fb-tree">
        {root.items.length === 0 ? (
          <div className="fb-empty">
            <span className="muted">No conditions.</span>
            <button className="link-btn" onClick={() => addCondition()}>
              Add a condition
            </button>
            <span className="muted">or right-click a cell → Filter.</span>
          </div>
        ) : (
          <GroupView
            group={root}
            root
            columns={columns}
            focusId={focusId}
            serverMode={!!server}
            onChange={(g) => commit(g)}
            onRootChange={(fn) => commit(fn(root))}
            onAddCondition={(g) => addCondition(g)}
            onSubmit={() => server && p.serverAlways ? server.onApply() : undefined}
          />
        )}
      </div>
      {manage && saved && <ManageFiltersDialog connectionId={saved.connectionId} signature={saved.signature} onApply={(f) => applyModel(f.model, f.id)} onClose={() => setManage(false)} />}
    </div>
  );
}

function GroupView({ group, root, columns, focusId, serverMode, onChange, onRootChange, onAddCondition, onSubmit }: {
  group: FilterGroup;
  root?: boolean;
  columns: ColumnInfo[];
  focusId: string | null;
  serverMode: boolean;
  onChange(g: FilterGroup): void;
  onRootChange(fn: (root: FilterGroup) => FilterGroup): void;
  onAddCondition(g: FilterGroup): void;
  onSubmit(): void;
}) {
  const set = (id: string, fn: (n: FilterNode) => FilterNode) => onRootChange((r) => updateNode(r, id, fn));
  const remove = (id: string) => onRootChange((r) => removeNode(r, id));
  return (
    <div className={`fb-group${root ? ' root' : ''}`} role={root ? undefined : 'group'} aria-label={root ? undefined : `${group.logic.toUpperCase()} group`}>
      {group.items.map((it, i) => (
        <div className="fb-item" key={it.id}>
          {i > 0 ? (
            <button
              className={`fb-logic ${group.logic}`}
              title="Switch AND / OR for this group"
              onClick={() => set(group.id, (g) => ({ ...(g as FilterGroup), logic: (g as FilterGroup).logic === 'and' ? 'or' : 'and' }))}
            >
              {group.logic.toUpperCase()}
            </button>
          ) : (
            <span className="fb-logic placeholder">{root ? 'Where' : '('}</span>
          )}
          {it.kind === 'condition' ? (
            <ConditionRow
              cond={it}
              columns={columns}
              autoFocus={it.id === focusId}
              serverMode={serverMode}
              onChange={(c) => set(it.id, () => c)}
              onRemove={() => remove(it.id)}
              onSubmit={onSubmit}
            />
          ) : (
            <div className="fb-sub">
              <GroupView group={it} columns={columns} focusId={focusId} serverMode={serverMode} onChange={onChange} onRootChange={onRootChange} onAddCondition={onAddCondition} onSubmit={onSubmit} />
              <div className="fb-sub-actions">
                <button className="link-btn" onClick={() => onAddCondition(it)}>
                  <Plus size={11} /> condition
                </button>
                <button className="link-btn" onClick={() => remove(it.id)}>
                  <X size={11} /> group
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

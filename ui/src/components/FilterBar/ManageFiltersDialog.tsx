import { Bookmark, Check, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import type { SavedFilter } from '../../filter/wire';
import { useFilters } from '../../store/filters';
import { toast } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { describeModel } from './describe';
import { normalizeModel } from '../../filter/model';

/** Saved filters of a connection: apply, rename, delete. Filters for other column sets are listed too. */
export function ManageFiltersDialog({ connectionId, signature, onApply, onClose }: {
  connectionId: string;
  signature: string;
  onApply(f: SavedFilter): void;
  onClose(): void;
}) {
  const list = useFilters((s) => s.saved[connectionId]) ?? [];
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const sorted = [...list].sort((a, b) => Number(b.signature === signature) - Number(a.signature === signature) || a.name.localeCompare(b.name));

  const rename = async () => {
    if (!editing?.name.trim()) return;
    try {
      await useFilters.getState().rename(editing.id, editing.name.trim());
      setEditing(null);
    } catch (e) {
      toast('error', 'Rename failed', errorMessage(e));
    }
  };

  return (
    <Dialog title="Saved filters" onClose={onClose} width={560} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {sorted.length === 0 ? (
        <div className="fb-manage-empty">
          <Bookmark size={20} />
          <div>No saved filters yet</div>
          <div className="muted">Build a filter and choose Save → Save as…</div>
        </div>
      ) : (
        <ul className="fb-manage" role="list">
          {sorted.map((f) => {
            const applicable = f.signature === signature;
            return (
              <li key={f.id} className={applicable ? '' : 'other'}>
                {editing?.id === f.id ? (
                  <form className="fb-manage-edit" onSubmit={(e) => (e.preventDefault(), void rename())}>
                    <input className="input sm" autoFocus aria-label="Filter name" value={editing.name} onChange={(e) => setEditing({ id: f.id, name: e.target.value })}
                      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(null))} />
                    <button className="icon-btn sm" type="submit" aria-label="Save name" title="Save name"><Check size={14} /></button>
                  </form>
                ) : (
                  <button className="fb-manage-name" disabled={!applicable} onClick={() => (onApply(f), onClose())} title={applicable ? 'Apply' : 'Saved for a different set of columns'}>
                    <span className="name">{f.name}</span>
                    <span className="desc">{describeModel(normalizeModel(f.model))}</span>
                  </button>
                )}
                {!applicable && <span className="fb-manage-tag">other columns</span>}
                <button className="icon-btn sm" aria-label={`Rename ${f.name}`} title="Rename" onClick={() => setEditing({ id: f.id, name: f.name })}><Pencil size={13} /></button>
                <button
                  className="icon-btn sm danger"
                  aria-label={`Delete ${f.name}`}
                  title="Delete"
                  onClick={() => void useFilters.getState().remove(f.id).catch((e) => toast('error', 'Delete failed', errorMessage(e)))}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

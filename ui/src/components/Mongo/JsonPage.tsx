// JSON view of a page of documents (docs/PLAN-M2.md 6.3): one read-only shell-JSON editor with the whole page;
// "Edit" makes it editable and "Save changes" replaces every document whose text changed (matched by _id).
import { Pencil, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { getField, hasTrunc, toShell, type BsonDoc } from '../../mongo/bson';
import { checkShell, parseShellArray } from '../../mongo/shellJson';
import { useUi, toast } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { MongoEditor } from './MongoEditor';
import { errorText } from './util';

export function pageText(docs: readonly BsonDoc[]): string {
  return `[\n${docs.map((d) => toShell(d, { inline: 60 }).split('\n').map((l) => `  ${l}`).join('\n')).join(',\n')}\n]`;
}

/** Changed documents of an edited page: `{ id, text }` per document whose shell text differs from the original. */
export function changedDocs(original: readonly BsonDoc[], text: string): { changed: { id: string; doc: string }[]; error: string | null } {
  let edited;
  try {
    edited = parseShellArray(text);
  } catch (e) {
    return { changed: [], error: errorText(e) };
  }
  const byId = new Map(original.map((d) => [toShell(getField(d, '_id') ?? { t: 'null' }), toShell(d)]));
  const changed: { id: string; doc: string }[] = [];
  for (const v of edited) {
    if (v.t !== 'object') return { changed: [], error: 'Every element must be a document.' };
    const id = getField(v, '_id');
    if (!id) return { changed: [], error: 'Every document needs its _id (adding documents is done with Insert).' };
    const key = toShell(id);
    if (!byId.has(key)) return { changed: [], error: `No document with _id ${key} on this page (changing _id is not supported here).` };
    if (byId.get(key) !== toShell(v)) changed.push({ id: key, doc: toShell(v) });
  }
  return { changed, error: null };
}

export function JsonPage({ docs, cid, db, coll, theme, canWrite, writeReason, onSaved }: {
  docs: readonly BsonDoc[]; cid: string; db: string; coll: string; theme: EffectiveTheme; canWrite: boolean; writeReason?: string; onSaved: () => void;
}) {
  const original = useMemo(() => pageText(docs), [docs]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(original);
  if (shown !== original) {
    setShown(original);
    setText(original);
    setEditing(false);
  }
  const truncated = docs.some(hasTrunc);
  const parseError = editing ? checkShell(text, 'array')?.message ?? null : null;
  const diff = editing && !parseError ? changedDocs(docs, text) : { changed: [], error: null };

  const save = async () => {
    if (!diff.changed.length || diff.error || busy) return;
    const ok = await useUi.getState().askConfirm({
      title: 'Replace documents?', message: `Replace ${diff.changed.length} changed document${diff.changed.length === 1 ? '' : 's'} in ${db}.${coll}?`,
      items: diff.changed.slice(0, 10).map((c) => `_id: ${c.id}`), confirmLabel: 'Replace',
    });
    if (!ok) return;
    setBusy(true);
    try {
      for (const c of diff.changed) await api.mongo.replace(cid, db, coll, { _id: c.id, doc: c.doc, replace: true });
      toast('success', `${diff.changed.length} document${diff.changed.length === 1 ? '' : 's'} replaced`);
      setEditing(false);
      onSaved();
    } catch (e) {
      toast('error', 'Save failed', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mg-json">
      <div className="mg-json-bar">
        {!editing ? (
          <button className="btn btn-xs" disabled={!canWrite || truncated} onClick={() => setEditing(true)}
            title={writeReason ?? (truncated ? 'A document on this page has truncated values: edit it from the list view' : 'Edit the page')}>
            <Pencil size={14} aria-hidden /> Edit
          </button>
        ) : (
          <>
            <button className="btn btn-xs btn-primary" disabled={!diff.changed.length || !!diff.error || busy} onClick={() => void save()}>
              <Save size={14} aria-hidden /> Save changes{diff.changed.length ? ` (${diff.changed.length})` : ''}
            </button>
            <button className="btn btn-xs" onClick={() => { setText(original); setEditing(false); }}><X size={14} aria-hidden /> Cancel</button>
            {(parseError ?? diff.error) && <span className="form-error" role="alert">{parseError ?? diff.error}</span>}
          </>
        )}
      </div>
      <MongoEditor mode="document" validate="array" theme={theme} value={editing ? text : original} onChange={setText} readOnly={!editing}
        height="auto" minHeight={200} maxHeight={100000} ariaLabel="Documents as JSON" onSubmit={() => void save()} />
    </div>
  );
}

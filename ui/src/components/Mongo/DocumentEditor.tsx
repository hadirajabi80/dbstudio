// Insert / Edit / Clone document dialog (docs/PLAN-M2.md 6.3): shell-JSON editor (ObjectId(), ISODate(),
// NumberLong(), NumberDecimal(), BinData()…), validated on every keystroke here and again by the engine; Ctrl+Enter
// saves. Edit replaces by _id; changing the _id becomes insert + delete after a confirmation; an array inserts many.
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { MongoFieldPath } from '../../api/types';
import { getField, toShell, withoutField, type BsonDoc, type BsonValue } from '../../mongo/bson';
import { checkShell, parseShell } from '../../mongo/shellJson';
import { useUi } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { Dialog } from '../common/Dialog';
import { MongoEditor } from './MongoEditor';
import { errorText } from './util';

export type EditorMode = 'insert' | 'edit' | 'clone';

export interface DocumentEditorProps {
  mode: EditorMode;
  cid: string;
  db: string;
  coll: string;
  /** Edit/clone: the (complete) document. */
  doc?: BsonDoc | null;
  fields?: readonly MongoFieldPath[];
  theme: EffectiveTheme;
  onClose: () => void;
  /** After a successful write (`count` documents written). */
  onSaved: (count: number) => void;
}

export function initialText(mode: EditorMode, doc?: BsonDoc | null): string {
  if (mode === 'insert' || !doc) return '{\n  \n}';
  return toShell(mode === 'clone' ? withoutField(doc, '_id') : doc, { inline: 60 });
}

const TITLE: Record<EditorMode, string> = { insert: 'Insert document', edit: 'Edit document', clone: 'Clone document' };

export function DocumentEditor({ mode, cid, db, coll, doc, fields, theme, onClose, onSaved }: DocumentEditorProps) {
  const [text, setText] = useState(() => initialText(mode, doc));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parseError = useMemo(() => checkShell(text, 'value'), [text]);
  const shape = useMemo<'doc' | 'array' | 'other'>(() => {
    if (parseError) return 'other';
    const v = parseShell(text);
    return v.t === 'object' ? 'doc' : v.t === 'array' && mode === 'insert' && v.v.every((x) => x.t === 'object') ? 'array' : 'other';
  }, [text, parseError, mode]);
  const problem = parseError?.message ?? (shape === 'other' ? (mode === 'insert' ? 'Enter a document { … } or an array of documents.' : 'Enter a document { … }.') : null);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const v = parseShell(text);
      if (mode === 'edit' && doc) {
        const oldId = getField(doc, '_id') as BsonValue;
        const newId = v.t === 'object' ? getField(v, '_id') : undefined;
        const oldIdText = toShell(oldId);
        if (newId && toShell(newId) !== oldIdText) {
          const ok = await useUi.getState().askConfirm({
            title: 'Change _id?', danger: true, confirmLabel: 'Insert new and delete old',
            message: 'MongoDB cannot change an _id in place. The edited document is inserted with the new _id and the original is deleted.',
            items: [`_id: ${oldIdText} → ${toShell(newId)}`],
          });
          if (!ok) {
            setBusy(false);
            return;
          }
          await api.mongo.insert(cid, db, coll, { doc: text });
          await api.mongo.deleteDocs(cid, db, coll, { ids: [oldIdText] });
        } else {
          await api.mongo.replace(cid, db, coll, { _id: oldIdText, doc: text, replace: true });
        }
        onSaved(1);
      } else if (v.t === 'array') {
        for (const d of v.v) await api.mongo.insert(cid, db, coll, { doc: toShell(d) });
        onSaved(v.v.length);
      } else {
        await api.mongo.insert(cid, db, coll, { doc: text });
        onSaved(1);
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`${TITLE[mode]} · ${db}.${coll}`}
      ariaLabel={TITLE[mode]}
      onClose={onClose}
      width={720}
      className="mg-editor-dialog"
      footer={
        <>
          <span className="mg-editor-hint muted">Shell syntax: ObjectId("…"), ISODate("…"), NumberLong("…"), NumberDecimal("…"), BinData(0, "…") · Ctrl+Enter saves</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!!problem || busy} onClick={() => void save()} title={problem ?? undefined}>
            {mode === 'edit' ? 'Replace' : 'Insert'}
          </button>
        </>
      }
    >
      <MongoEditor mode="document" validate="value" fields={fields} theme={theme} value={text} onChange={setText} onSubmit={() => void save()}
        height="auto" minHeight={260} maxHeight={520} ariaLabel="Document" autoFocus invalid={!!problem} />
      {(problem || error) && <p className="form-error" role="alert">{error ?? problem}</p>}
    </Dialog>
  );
}

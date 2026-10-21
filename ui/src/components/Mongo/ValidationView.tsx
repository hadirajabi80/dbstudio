// Validation rules (docs/PLAN-M2.md 6.5): the collection's validator in a shell-JSON editor (with a $jsonSchema
// template and "Generate from schema analysis"), validation level and action, Save (collMod) / Revert, and "Test
// against sample": `find({ $nor: [validator] })` limit 20 shows the documents that would fail.
import { FlaskConical, RotateCcw, Save, Wand } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { MongoSchemaResult, MongoValidation } from '../../api/types';
import { parseEjson, parseEjsonDoc, toShell, type BsonDoc } from '../../mongo/bson';
import { validatorFrom } from '../../mongo/jsonSchema';
import { checkShell, isEmptyDocText } from '../../mongo/shellJson';
import { toast } from '../../store/ui';
import { Select } from '../common/Select';
import { DocTree } from './BsonView';
import type { SubViewProps } from './CollectionView';
import { MongoEditor } from './MongoEditor';
import { errorText, pendingValidator, plural, waitForJob } from './util';

export const VALIDATOR_TEMPLATE = `{
  $jsonSchema: {
    bsonType: "object",
    required: [],
    properties: {
    }
  }
}`;

const LEVELS = [
  { value: 'strict' as const, label: 'Strict: all inserts and updates' },
  { value: 'moderate' as const, label: 'Moderate: valid documents only' },
  { value: 'off' as const, label: 'Off' },
];
const ACTIONS = [
  { value: 'error' as const, label: 'Error: reject invalid writes' },
  { value: 'warn' as const, label: 'Warn: log and accept' },
  { value: 'errorAndLog' as const, label: 'Error and log (8.0+)' },
];

function textOf(v: MongoValidation): string {
  return v.validator ? toShell(parseEjson(v.validator), { inline: 70 }) : '';
}

export default function ValidationView({ cid, db, coll, theme, readOnly, visible }: SubViewProps) {
  const key = `${cid}:${db}.${coll}`;
  const [server, setServer] = useState<MongoValidation | null>(null);
  const [text, setText] = useState('');
  const [level, setLevel] = useState<MongoValidation['level']>('strict');
  const [action, setAction] = useState<MongoValidation['action']>('error');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ docs: BsonDoc[]; count: number; exact: boolean } | null>(null);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.mongo.validation(cid, db, coll);
      setServer(v);
      setLevel(v.level);
      setAction(v.action);
      const draft = pendingValidator.get(key);
      pendingValidator.delete(key);
      setText(draft ?? textOf(v));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [cid, db, coll, key]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ key: string }>).detail.key !== key) return;
      const draft = pendingValidator.get(key);
      pendingValidator.delete(key);
      if (draft) setText(draft);
    };
    window.addEventListener('dbstudio:mongo-validator', on);
    return () => window.removeEventListener('dbstudio:mongo-validator', on);
  }, [key]);

  const parseError = text.trim() ? checkShell(text)?.message ?? null : null;
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  const dirty = !!server && (norm(text) !== norm(textOf(server)) || level !== server.level || action !== server.action);

  const save = async () => {
    if (parseError || busy) return;
    setBusy(true);
    try {
      const v = await api.mongo.setValidation(cid, db, coll, { validator: isEmptyDocText(text) ? null : text, level, action });
      setServer(v);
      setText(textOf(v));
      toast('success', isEmptyDocText(text) ? 'Validation removed' : 'Validation rules saved');
    } catch (e) {
      toast('error', 'Saving the validation failed', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (parseError || isEmptyDocText(text)) return;
    setBusy(true);
    try {
      const r = await api.mongo.find(cid, db, coll, { filter: `{ $nor: [ ${text} ] }`, skip: 0, limit: 20, maxTimeMs: 15000 });
      setTest({ docs: r.docs.map(parseEjsonDoc), count: r.count.value, exact: r.count.exact });
    } catch (e) {
      toast('error', 'Test failed', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const { jobId } = await api.mongo.schema(cid, db, coll, { sampleSize: 1000 });
      const result = await waitForJob<MongoSchemaResult>(jobId);
      setText(toShell(validatorFrom(result), { inline: 70 }));
      toast('info', 'Validation rules drafted from 1,000 sampled documents', 'Review them, then Save.');
    } catch (e) {
      toast('error', 'Schema analysis failed', errorText(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="mg-validation">
      <div className="mg-toolbar" role="toolbar" aria-label="Validation">
        <span className="mg-qlabel">Level</span>
        <Select aria-label="Validation level" size="sm" value={level} onChange={setLevel} options={LEVELS} disabled={readOnly} menuMinWidth={240} />
        <span className="mg-qlabel">Action</span>
        <Select aria-label="Validation action" size="sm" value={action} onChange={setAction} options={ACTIONS} disabled={readOnly} menuMinWidth={240} />
        <span className="flex-1" />
        <button className="btn btn-xs" onClick={() => void generate()} disabled={generating || readOnly} title="Sample documents and draft a $jsonSchema"><Wand size={14} aria-hidden /> {generating ? 'Analyzing…' : 'Generate from schema'}</button>
        {!text.trim() && <button className="btn btn-xs" onClick={() => setText(VALIDATOR_TEMPLATE)} disabled={readOnly}>Insert $jsonSchema template</button>}
        <button className="btn btn-xs" onClick={() => void runTest()} disabled={busy || !!parseError || isEmptyDocText(text)} title="Find documents that violate these rules"><FlaskConical size={14} aria-hidden /> Test against sample</button>
        <button className="btn btn-xs" onClick={() => server && (setText(textOf(server)), setLevel(server.level), setAction(server.action))} disabled={!dirty}><RotateCcw size={14} aria-hidden /> Revert</button>
        <button className="btn btn-xs btn-primary" onClick={() => void save()} disabled={!dirty || !!parseError || busy || readOnly} title={readOnly ? 'The connection is read-only' : undefined}><Save size={14} aria-hidden /> Save</button>
      </div>
      {error && <div className="mg-error" role="alert">{error}</div>}
      <div className="mg-validation-body">
        <div className="mg-validation-editor">
          <MongoEditor mode="filter" theme={theme} value={text} onChange={setText} readOnly={readOnly} height="auto" minHeight={240} maxHeight={visible ? 600 : 240}
            placeholder="No validation rules. Write a query document or a $jsonSchema." ariaLabel="Validator" invalid={!!parseError} onSubmit={() => void save()} />
          {parseError && <p className="form-error" role="alert">{parseError}</p>}
          {server && !server.validator && !text.trim() && <p className="muted">This collection accepts any document.</p>}
        </div>
        {test && (
          <section className="mg-vtest" aria-label="Validation test">
            <h3>{test.count === 0 ? 'Every document passes' : `${test.exact ? '' : '~'}${plural(test.count, 'document')} would fail`}</h3>
            {test.docs.length > 0 && <p className="muted">First {test.docs.length} failing documents:</p>}
            <ul className="mg-cards">
              {test.docs.map((d, i) => <li key={i} className="mg-card invalid"><DocTree doc={d} maxFields={8} /></li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

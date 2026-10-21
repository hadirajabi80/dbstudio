// Explorer dialogs (docs/PLAN-M2.md 6.2): New collection (plain, capped, time series, view), Rename, and the typed
// confirmation of Drop collection / Drop database (danger: the user types the name).
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import type { MongoCreateCollectionRequest } from '../../api/types';
import { checkShell } from '../../mongo/shellJson';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { errorText } from './util';

type Kind = 'collection' | 'capped' | 'timeseries' | 'view';

export function NewCollectionDialog({ cid, db, collections, onClose, onCreated }: {
  cid: string; db: string; collections: string[]; onClose: () => void; onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('collection');
  const [size, setSize] = useState('1048576');
  const [max, setMax] = useState('');
  const [timeField, setTimeField] = useState('ts');
  const [metaField, setMetaField] = useState('');
  const [granularity, setGranularity] = useState<'seconds' | 'minutes' | 'hours'>('seconds');
  const [viewOn, setViewOn] = useState(collections[0] ?? '');
  const [pipeline, setPipeline] = useState('[\n  { $match: {} }\n]');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = !name.trim() ? 'A name is required.' : /[$\0]/.test(name) || name.startsWith('system.') ? 'Names cannot contain $ or start with system.' : null;
  const pipeError = kind === 'view' ? checkShell(pipeline, 'array')?.message ?? null : null;

  const submit = async () => {
    if (nameError || pipeError || busy) return;
    const options: NonNullable<MongoCreateCollectionRequest['options']> = {};
    if (kind === 'capped') Object.assign(options, { capped: true, size: Number(size) || 1048576, max: max ? Number(max) : null });
    if (kind === 'timeseries') options.timeseries = { timeField: timeField.trim() || 'ts', metaField: metaField.trim() || null, granularity };
    if (kind === 'view') {
      options.viewOn = viewOn;
      options.pipeline = splitPipeline(pipeline);
    }
    setBusy(true);
    setError(null);
    try {
      await api.mongo.createCollection(cid, db, { name: name.trim(), options });
      onCreated(name.trim());
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`New collection in ${db}`}
      onClose={onClose}
      onSubmit={() => void submit()}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!!nameError || !!pipeError || busy} onClick={() => void submit()}>Create</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-label" htmlFor="mg-new-name">Name</label>
        <input id="mg-new-name" className={`input ${name && nameError ? 'invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        <span className="form-label">Type</span>
        <div className="segmented" role="radiogroup" aria-label="Collection type">
          {(['collection', 'capped', 'timeseries', 'view'] as Kind[]).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'collection' ? 'Collection' : k === 'capped' ? 'Capped' : k === 'timeseries' ? 'Time series' : 'View'}
            </button>
          ))}
        </div>
        {kind === 'capped' && (
          <>
            <label className="form-label" htmlFor="mg-new-size">Max size (bytes)</label>
            <input id="mg-new-size" className="input" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))} />
            <label className="form-label" htmlFor="mg-new-max">Max documents</label>
            <input id="mg-new-max" className="input" inputMode="numeric" placeholder="unlimited" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
          </>
        )}
        {kind === 'timeseries' && (
          <>
            <label className="form-label" htmlFor="mg-new-tf">Time field</label>
            <input id="mg-new-tf" className="input" value={timeField} onChange={(e) => setTimeField(e.target.value)} />
            <label className="form-label" htmlFor="mg-new-mf">Meta field</label>
            <input id="mg-new-mf" className="input" placeholder="optional" value={metaField} onChange={(e) => setMetaField(e.target.value)} />
            <span className="form-label">Granularity</span>
            <Select aria-label="Granularity" value={granularity} onChange={setGranularity}
              options={[{ value: 'seconds', label: 'Seconds' }, { value: 'minutes', label: 'Minutes' }, { value: 'hours', label: 'Hours' }]} />
          </>
        )}
        {kind === 'view' && (
          <>
            <span className="form-label">Source</span>
            <Select aria-label="Source collection" value={viewOn} onChange={setViewOn} options={collections.map((c) => ({ value: c, label: c }))} mono />
            <label className="form-label" htmlFor="mg-new-pipe">Pipeline</label>
            <textarea id="mg-new-pipe" className={`input mongo-pipe-text ${pipeError ? 'invalid' : ''}`} rows={5} value={pipeline} spellCheck={false} onChange={(e) => setPipeline(e.target.value)} />
          </>
        )}
      </div>
      {(error || pipeError) && <p className="form-error" role="alert">{error ?? pipeError}</p>}
    </Dialog>
  );
}

/** Splits `[ {...}, {...} ]` text into one text per stage (top-level commas), for the engine's pipeline strings. */
export function splitPipeline(text: string): string[] {
  const t = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += t[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if ('{[('.includes(c)) depth++;
    if ('}])'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function RenameCollectionDialog({ cid, db, coll, onClose, onRenamed }: {
  cid: string; db: string; coll: string; onClose: () => void; onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(coll);
  const [dropTarget, setDropTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = !name.trim() || name.trim() === coll || /[$\0]/.test(name);
  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true);
    try {
      await api.mongo.renameCollection(cid, db, coll, { newName: name.trim(), dropTarget });
      onRenamed(name.trim());
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Rename ${db}.${coll}`} onClose={onClose} onSubmit={() => void submit()} width={460}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={invalid || busy} onClick={() => void submit()}>Rename</button></>}>
      <div className="form-grid">
        <label className="form-label" htmlFor="mg-rename">New name</label>
        <input id="mg-rename" className="input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        <span />
        <label className="check"><input type="checkbox" checked={dropTarget} onChange={(e) => setDropTarget(e.target.checked)} /> Drop an existing collection with this name</label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Dialog>
  );
}

/** Danger confirmation that requires typing the name (Drop database / Drop collection). */
export function TypedDropDialog({ what, name, detail, onClose, onConfirm }: {
  what: 'collection' | 'database'; name: string; detail?: string; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed === name;
  const go = async () => {
    if (!armed || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={<span className="confirm-title"><TriangleAlert size={16} className="text-warning" /> Drop {what}</span>}
      ariaLabel={`Drop ${what}`}
      onClose={onClose}
      width={460}
      footer={<><button className="btn" data-autofocus onClick={onClose}>Cancel</button><button className={armed ? 'btn btn-danger' : 'btn btn-danger-outline'} disabled={!armed || busy} onClick={() => void go()}>Drop {what}</button></>}
    >
      <p className="confirm-message">
        This permanently deletes the {what} <code>{name}</code>{detail ? ` ${detail}` : ''}. It cannot be undone.
      </p>
      <label className="form-label mongo-typed-label" htmlFor="mg-typed">Type <code>{name}</code> to confirm</label>
      <input id="mg-typed" className="input mongo-typed" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off"
        onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </Dialog>
  );
}

// Import documents (docs/PLAN-M2.md 6.5): pick a JSON / JSON Lines / CSV file, preview the first 20 parsed documents
// (`POST …/import/preview`), map CSV columns to types, choose insert or upsert, then run the import job with per-batch
// progress and an error list (first 100).
import { FileUp, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { MongoCsvColumnType, MongoExportFormat, MongoImportPreview, MongoImportRequest, MongoImportResult } from '../../api/types';
import { parseEjsonDoc } from '../../mongo/bson';
import { getPlatform } from '../../platform';
import { toast } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { DocTree } from './BsonView';
import { loadCollections } from './store';
import { errorText, plural, useJob } from './util';

const COL_TYPES: { value: MongoCsvColumnType; label: string }[] = [
  { value: 'string', label: 'String' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' }, { value: 'objectId', label: 'ObjectId' },
];

export function formatOf(name: string): MongoExportFormat {
  const n = name.toLowerCase();
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return 'csv';
  if (n.endsWith('.jsonl') || n.endsWith('.ndjson')) return 'jsonl';
  return 'json';
}

export interface ImportDialogProps {
  cid: string;
  db: string;
  /** null: the user picks the target collection. */
  coll: string | null;
  collections: string[];
  onClose: () => void;
  /** Test seam: the picked file. */
  initialFile?: { name: string; path: string | null; content: string };
}

export function ImportDialog({ cid, db, coll, collections, onClose, initialFile }: ImportDialogProps) {
  const [target, setTarget] = useState(coll ?? collections[0] ?? '');
  const [file, setFile] = useState(initialFile ?? null);
  const [format, setFormat] = useState<MongoExportFormat>(initialFile ? formatOf(initialFile.name) : 'json');
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(initialFile?.name.toLowerCase().endsWith('.tsv') ? '\t' : ',');
  const [inference, setInference] = useState(true);
  const [types, setTypes] = useState<Record<string, MongoCsvColumnType>>({});
  const [mode, setMode] = useState<'insert' | 'upsert'>('insert');
  const [upsertKey, setUpsertKey] = useState('_id');
  const [stopOnError, setStopOnError] = useState(false);
  const [preview, setPreview] = useState<MongoImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const job = useJob<MongoImportResult>();

  const request = (): MongoImportRequest => ({
    format, mode, upsertKey: upsertKey.trim() || '_id', batchSize: 1000, stopOnError,
    ...(file?.path && getPlatform().hasFileSystem ? { path: file.path } : { upload: file?.content ?? '' }),
    ...(format === 'csv' ? { csv: { header, delimiter, typeInference: inference, types } } : {}),
  });

  useEffect(() => {
    if (!file || !target) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.mongo.importPreview(cid, db, target, request(), ctl.signal).then(
        (p) => { setPreview(p); setPreviewError(null); },
        (e) => !ctl.signal.aborted && (setPreview(null), setPreviewError(errorText(e))),
      );
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [file, target, format, header, delimiter, inference, types]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    const f = await getPlatform().openTextFile({ filters: [{ name: 'JSON, JSON Lines, CSV', extensions: ['json', 'jsonl', 'ndjson', 'csv', 'tsv'] }] });
    if (!f) return;
    setFile(f);
    setFormat(formatOf(f.name));
    if (f.name.toLowerCase().endsWith('.tsv')) setDelimiter('\t');
    setTypes({});
  };

  const run = async () => {
    const r = await job.run(() => api.mongo.importDocs(cid, db, target, request()));
    if (r) {
      toast(r.failed ? 'warning' : 'success', `Imported ${plural(r.inserted + r.upserted, 'document')} into ${db}.${target}`, r.failed ? `${r.failed} failed` : undefined);
      void loadCollections(cid, db, true);
    }
  };

  const running = job.state.status === 'running';
  const result = job.state.result;
  return (
    <Dialog title={`Import into ${db}${target ? `.${target}` : ''}`} ariaLabel="Import documents" onClose={onClose} width={820} className="mg-import-dialog"
      footer={
        <>
          {running && job.state.jobId && <button className="btn" onClick={() => void api.cancelJob(job.state.jobId!).catch(() => undefined)}>Cancel import</button>}
          <span className="flex-1" />
          <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!result && <button className="btn btn-primary" disabled={!file || !target || running || !preview || preview.docs.length === 0} onClick={() => void run()}><Upload size={14} aria-hidden /> Import</button>}
        </>
      }>
      <div className="form-grid">
        {coll === null && (
          <>
            <span className="form-label">Collection</span>
            <Select aria-label="Target collection" value={target} onChange={setTarget} options={collections.map((c) => ({ value: c, label: c }))} mono />
          </>
        )}
        <span className="form-label">File</span>
        <div className="mg-filepick">
          <button className="btn" onClick={() => void pick()}><FileUp size={14} aria-hidden /> Choose file…</button>
          {file && <span className="mono" title={file.path ?? file.name}>{file.name}</span>}
          {file && <span className="muted">{(file.content.length / 1024).toFixed(file.content.length < 10240 ? 1 : 0)} KB</span>}
        </div>
        <span className="form-label">Format</span>
        <div className="segmented" role="radiogroup" aria-label="Format">
          {(['json', 'jsonl', 'csv'] as const).map((f) => <button key={f} role="radio" aria-checked={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f === 'jsonl' ? 'JSON Lines' : f.toUpperCase()}</button>)}
        </div>
        {format === 'csv' && (
          <>
            <span className="form-label">CSV</span>
            <div className="mg-ixchecks">
              <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header</label>
              <label className="check"><input type="checkbox" checked={inference} onChange={(e) => setInference(e.target.checked)} /> Detect types</label>
              <Select aria-label="Delimiter" size="sm" value={delimiter} onChange={setDelimiter}
                options={[{ value: ',', label: 'Comma ,' }, { value: ';', label: 'Semicolon ;' }, { value: '\t', label: 'Tab' }, { value: '|', label: 'Pipe |' }]} />
            </div>
          </>
        )}
        <span className="form-label">Mode</span>
        <div className="mg-ixchecks">
          <div className="segmented" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked={mode === 'insert'} className={mode === 'insert' ? 'on' : ''} onClick={() => setMode('insert')}>Insert</button>
            <button role="radio" aria-checked={mode === 'upsert'} className={mode === 'upsert' ? 'on' : ''} onClick={() => setMode('upsert')}>Upsert</button>
          </div>
          {mode === 'upsert' && <label className="check">by <input className="input sm" aria-label="Upsert key" value={upsertKey} onChange={(e) => setUpsertKey(e.target.value)} style={{ width: 120 }} /></label>}
          <label className="check"><input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> Stop on the first error</label>
        </div>
      </div>

      {previewError && <p className="form-error" role="alert">{previewError}</p>}
      {preview && !result && (
        <div className="mg-import-preview">
          {preview.columns && (
            <table className="mg-table mg-maptable" aria-label="Column types">
              <thead><tr><th>Column</th><th>Type</th><th>First value</th></tr></thead>
              <tbody>
                {preview.columns.map((c) => {
                  const first = preview.docs[0] ? parseEjsonDoc(preview.docs[0]) : null;
                  const fv = first ? JSON.stringify(first.v.find(([k]) => k === c.name.split('.')[0])?.[1] ?? null) : '';
                  return (
                    <tr key={c.name}>
                      <td className="mono">{c.name}</td>
                      <td><Select aria-label={`Type of ${c.name}`} size="sm" value={types[c.name] ?? c.inferredType} onChange={(t) => setTypes({ ...types, [c.name]: t })} options={COL_TYPES} /></td>
                      <td className="muted mg-ellipsis">{fv && fv !== 'null' ? (c.name.includes('.') ? '(nested)' : previewValue(fv)) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted">Preview: {plural(preview.docs.length, 'document')}{preview.errors.length ? `, ${plural(preview.errors.length, 'problem')}` : ''}</p>
          {preview.errors.length > 0 && <ul className="mg-errlist">{preview.errors.slice(0, 5).map((e) => <li key={e.index}>#{e.index + 1}: {e.message}</li>)}</ul>}
          <div className="mg-preview-docs">
            {preview.docs.slice(0, 6).map((d, i) => <div key={i} className="mg-mini-card"><DocTree doc={parseEjsonDoc(d)} maxFields={8} /></div>)}
          </div>
        </div>
      )}
      {running && (
        <div className="mg-progress" role="progressbar" aria-label="Import progress" aria-valuenow={job.state.done} aria-valuemax={job.state.total ?? undefined}>
          <span style={{ width: job.state.total ? `${Math.min(100, (job.state.done / job.state.total) * 100)}%` : '30%' }} className={job.state.total ? undefined : 'indeterminate'} />
          <em>{job.state.message ?? 'Importing'} · {job.state.done.toLocaleString()}{job.state.total ? ` / ${job.state.total.toLocaleString()}` : ''}</em>
        </div>
      )}
      {job.state.status === 'error' && <p className="form-error" role="alert">{job.state.error}</p>}
      {result && (
        <div className="mg-import-result" role="status">
          <p><strong>{plural(result.inserted, 'document')} inserted</strong>{result.upserted ? `, ${plural(result.upserted, 'document')} upserted` : ''}{result.failed ? `, ${result.failed} failed` : ''}.</p>
          {result.errors.length > 0 && (
            <ul className="mg-errlist" aria-label="Import errors">
              {result.errors.map((e, i) => <li key={i}>#{e.index + 1}: {e.message}</li>)}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

function previewValue(json: string): string {
  try {
    const v = JSON.parse(json) as { v?: unknown; t?: string };
    return v && typeof v === 'object' && 'v' in v ? String(v.v) : json;
  } catch {
    return json;
  }
}

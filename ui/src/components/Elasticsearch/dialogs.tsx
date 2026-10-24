// Elasticsearch dialogs (plan-batch3 WP-ES): confirmations (typed for index deletion), create index (shards, replicas,
// mappings/settings JSON), reindex / import / export as engine jobs with progress and cancel, alias, JSON viewer and
// JSON editor (settings, mappings).
import { Download, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { EsExportRequest, EsExportResult, EsFileFormat, EsImportResult, EsReindexResult } from '../../api/types.es';
import { formatCount, formatMs, indexNameError } from '../../es/format';
import { isPlainObject, parseLenient, pretty } from '../../es/json';
import { getPlatform } from '../../platform';
import { toast } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { Dialog } from '../common/Dialog';
import { CodeEditor } from './CodeEditor';
import { useJob, type JobState } from './jobs';
import { JsonTree } from './JsonTree';
import { esErrorText } from './parts';
import { knownTargets, loadAliases } from './store';
import './es.css';

function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="form-error es-dialog-error" role="alert">{error}</div> : null;
}

/** The applied theme (<html data-theme>), followed live; read-only (the shell's useEffectiveTheme also applies themes). */
function useEffectiveTheme(): EffectiveTheme {
  const read = (): EffectiveTheme => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState<EffectiveTheme>(read);
  useEffect(() => {
    const o = new MutationObserver(() => setTheme(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => o.disconnect();
  }, []);
  return theme;
}

// ---------------------------------------------------------------- confirmations

export function ConfirmDialog({ title, message, action, danger, onClose, onConfirm }: {
  title: string; message: string; action: string; danger?: boolean; onClose(): void; onConfirm(): Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(esErrorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} width={460} footer={
      <>
        <button type="button" className="btn" onClick={onClose} data-autofocus>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => void go()}>{busy ? 'Working…' : action}</button>
      </>
    }>
      <p className="confirm-message">{message}</p>
      <ErrorLine error={error} />
    </Dialog>
  );
}

export function TypedConfirmDialog({ title, message, name, action, onClose, onConfirm }: {
  title: string; message: string; name: string; action: string; onClose(): void; onConfirm(): Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed === name;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(esErrorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} onSubmit={() => void submit()} width={480} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={!ok || busy} onClick={() => void submit()}>{busy ? 'Working…' : action}</button>
      </>
    }>
      <p className="confirm-message">{message}</p>
      <label className="es-typed">
        <span>Type <code className="mono">{name}</code> to confirm</span>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Type ${name} to confirm`} />
      </label>
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- create index

const CREATE_TEMPLATE = pretty({
  mappings: { properties: { title: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }, createdAt: { type: 'date' }, tags: { type: 'keyword' } } },
});

export function CreateIndexDialog({ cid, onClose, onCreated }: { cid: string; onClose(): void; onCreated(name: string): void }) {
  const theme = useEffectiveTheme();
  const [name, setName] = useState('');
  const [shards, setShards] = useState('1');
  const [replicas, setReplicas] = useState('1');
  const [body, setBody] = useState(CREATE_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameError = name ? indexNameError(name) : null;
  const submit = async () => {
    const err = indexNameError(name);
    if (err) return setError(err);
    const parsed = parseLenient(body);
    if (!parsed.ok) return setError(`Mappings / settings: ${parsed.error}`);
    if (parsed.value !== undefined && !isPlainObject(parsed.value)) return setError('The body must be a JSON object ({ "settings", "mappings", "aliases" }).');
    setBusy(true);
    setError(null);
    try {
      await api.es.createIndex(cid, { name, shards: Number(shards) || 1, replicas: replicas === '' ? null : Number(replicas), body: parsed.value ?? null });
      onCreated(name);
      onClose();
    } catch (e) {
      setError(esErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Create index" onClose={onClose} width={640} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !name || !!nameError} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create'}</button>
      </>
    }>
      <div className="form-grid">
        <label className="form-label" htmlFor="es-new-name">Name<span className="req">*</span></label>
        <input id="es-new-name" className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-index" aria-invalid={!!nameError} />
        <label className="form-label" htmlFor="es-new-shards">Primary shards</label>
        <input id="es-new-shards" className="input" inputMode="numeric" value={shards} onChange={(e) => setShards(e.target.value.replace(/\D/g, ''))} />
        <label className="form-label" htmlFor="es-new-replicas">Replicas</label>
        <input id="es-new-replicas" className="input" inputMode="numeric" value={replicas} onChange={(e) => setReplicas(e.target.value.replace(/\D/g, ''))} />
      </div>
      {nameError && <div className="form-hint es-warn-text">{nameError}</div>}
      <div className="es-dialog-label">Settings, mappings and aliases (JSON, optional)</div>
      <CodeEditor value={body} onChange={setBody} language="json" ariaLabel="Index body" theme={theme} height={220} />
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- job progress

function JobProgress<R>({ state, verb }: { state: JobState<R>; verb: string }) {
  if (state.status === 'idle') return null;
  const pct = state.total ? Math.min(100, (state.done / state.total) * 100) : null;
  return (
    <div className="es-job" role="status" aria-live="polite">
      <div className="es-progress-bar es-job-bar"><span className={pct == null && state.status === 'running' ? 'indeterminate' : undefined} style={{ width: `${pct ?? (state.status === 'running' ? 30 : 100)}%` }} /></div>
      <div className="es-job-text">
        {state.status === 'running' && <>{verb}… {formatCount(state.done)}{state.total ? ` of ${formatCount(state.total)}` : ''}{state.message ? ` · ${state.message}` : ''}</>}
        {state.status === 'cancelled' && 'Cancelled.'}
        {state.status === 'error' && <span className="es-warn-text">{state.error}</span>}
      </div>
    </div>
  );
}

function CancelJob<R>({ state }: { state: JobState<R> }) {
  if (state.status !== 'running' || !state.jobId) return null;
  return <button type="button" className="btn" onClick={() => void api.cancelJob(state.jobId!).catch(() => undefined)}>Cancel job</button>;
}

// ---------------------------------------------------------------- reindex

export function ReindexDialog({ cid, source, onClose, onDone }: { cid: string; source: string; onClose(): void; onDone(): void }) {
  const theme = useEffectiveTheme();
  const [src, setSrc] = useState(source);
  const [dest, setDest] = useState(source ? `${source}-copy` : '');
  const [query, setQuery] = useState('');
  const [conflicts, setConflicts] = useState<'abort' | 'proceed'>('abort');
  const [maxDocs, setMaxDocs] = useState('');
  const [error, setError] = useState<string | null>(null);
  const job = useJob<EsReindexResult>();
  const targets = useMemo(() => knownTargets(cid), [cid]);
  const run = async () => {
    const q = parseLenient(query);
    if (!q.ok) return setError(`Query: ${q.error}`);
    const destErr = indexNameError(dest);
    if (destErr) return setError(`Destination: ${destErr}`);
    if (!src.trim()) return setError('Choose a source index.');
    setError(null);
    const r = await job.run(() => api.es.reindex(cid, { source: src.trim(), dest, query: q.value ?? null, conflicts, maxDocs: maxDocs ? Number(maxDocs) : null }));
    if (r) {
      toast(r.failures.length ? 'warning' : 'success', `Reindexed ${formatCount(r.created + r.updated)} documents into ${dest}`, `${formatMs(r.tookMs)}${r.failures.length ? ` · ${r.failures.length} failures` : ''}`);
      onDone();
    }
  };
  const running = job.state.status === 'running';
  const result = job.state.result;
  return (
    <Dialog title="Reindex" onClose={onClose} width={640} footer={
      <>
        <CancelJob state={job.state} />
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && <button type="button" className="btn btn-primary" disabled={running || !src || !dest} onClick={() => void run()}>{running ? 'Reindexing…' : 'Reindex'}</button>}
      </>
    }>
      <datalist id="es-reindex-targets">{targets.map((t) => <option key={t} value={t} />)}</datalist>
      <div className="form-grid">
        <label className="form-label" htmlFor="es-rx-src">Source<span className="req">*</span></label>
        <input id="es-rx-src" className="input mono" list="es-reindex-targets" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="index, alias or pattern" />
        <label className="form-label" htmlFor="es-rx-dest">Destination<span className="req">*</span></label>
        <input id="es-rx-dest" className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="new-index" />
        <label className="form-label" htmlFor="es-rx-conf">Version conflicts</label>
        <select id="es-rx-conf" className="input" value={conflicts} onChange={(e) => setConflicts(e.target.value as 'abort' | 'proceed')}>
          <option value="abort">Abort the reindex</option>
          <option value="proceed">Count and continue</option>
        </select>
        <label className="form-label" htmlFor="es-rx-max">Max documents</label>
        <input id="es-rx-max" className="input" inputMode="numeric" placeholder="all" value={maxDocs} onChange={(e) => setMaxDocs(e.target.value.replace(/\D/g, ''))} />
      </div>
      <div className="es-dialog-label">Only documents matching (query DSL "query" object, optional)</div>
      <CodeEditor value={query} onChange={setQuery} language="json" ariaLabel="Reindex query" theme={theme} height={110} completion={{ cid, dsl: true, index: () => src || null }} />
      <p className="form-hint">The destination is created with dynamic mappings when it does not exist: create it first to control mappings and shards.</p>
      <JobProgress state={job.state} verb="Reindexing" />
      {result && (
        <div className="es-job-result">
          {formatCount(result.created)} created · {formatCount(result.updated)} updated · {formatCount(result.versionConflicts)} conflicts · {formatMs(result.tookMs)}
          {result.failures.length > 0 && <ul className="es-failures">{result.failures.slice(0, 10).map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </div>
      )}
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- export

const EXT: Record<EsFileFormat, string> = { ndjson: 'ndjson', json: 'json', csv: 'csv' };

export function ExportDialog({ cid, index, onClose }: { cid: string; index: string; onClose(): void }) {
  const theme = useEffectiveTheme();
  const [format, setFormat] = useState<EsFileFormat>('ndjson');
  const [query, setQuery] = useState('');
  const [fields, setFields] = useState('');
  const [max, setMax] = useState('');
  const [meta, setMeta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<EsExportResult>();
  const desktop = getPlatform().hasFileSystem;
  const request = (path: string | null): EsExportRequest | null => {
    const q = parseLenient(query);
    if (!q.ok) {
      setError(`Query: ${q.error}`);
      return null;
    }
    return {
      index, format, query: q.value ?? null, path, includeMeta: meta, max: max ? Number(max) : null,
      fields: fields.trim() ? fields.split(',').map((f) => f.trim()).filter(Boolean) : null,
    };
  };
  const run = async () => {
    setError(null);
    const name = `${index.replace(/[^\w.-]+/g, '_')}.${EXT[format]}`;
    if (desktop) {
      const path = await getPlatform().showSaveDialog({ title: 'Export documents', defaultPath: name, filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }] });
      if (!path) return;
      const body = request(path);
      if (!body) return;
      const r = await job.run(async () => (await api.es.exportDocs(cid, body)).json() as Promise<{ jobId: string }>);
      if (r) toast('success', `Exported ${formatCount(r.docs)} documents`, r.path ?? undefined);
      return;
    }
    const body = request(null);
    if (!body) return;
    setBusy(true);
    try {
      const res = await api.es.exportDocs(cid, body);
      const blob = await res.blob();
      await getPlatform().saveFile({ suggestedName: name, content: blob, mime: format === 'csv' ? 'text/csv' : 'application/x-ndjson' });
      toast('success', `Exported ${index}`, name);
      onClose();
    } catch (e) {
      setError(esErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const running = busy || job.state.status === 'running';
  return (
    <Dialog title={`Export ${index}`} onClose={onClose} width={600} footer={
      <>
        <CancelJob state={job.state} />
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose}>{job.state.result ? 'Close' : 'Cancel'}</button>
        {!job.state.result && <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}><Download size={14} aria-hidden /> {running ? 'Exporting…' : 'Export'}</button>}
      </>
    }>
      <div className="form-grid">
        <label className="form-label" htmlFor="es-ex-format">Format</label>
        <select id="es-ex-format" className="input" value={format} onChange={(e) => setFormat(e.target.value as EsFileFormat)}>
          <option value="ndjson">NDJSON (one document per line)</option>
          <option value="json">JSON array</option>
          <option value="csv">CSV</option>
        </select>
        <label className="form-label" htmlFor="es-ex-fields">Fields</label>
        <input id="es-ex-fields" className="input mono" placeholder="all (comma separated: name,price)" value={fields} onChange={(e) => setFields(e.target.value)} />
        <label className="form-label" htmlFor="es-ex-max">Max documents</label>
        <input id="es-ex-max" className="input" inputMode="numeric" placeholder="all" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
        <span className="form-label" />
        <label className="check"><input type="checkbox" checked={meta} disabled={format === 'csv'} onChange={(e) => setMeta(e.target.checked)} /> Include _index and _id (re-importable with ids)</label>
      </div>
      <div className="es-dialog-label">Only documents matching (query DSL "query" object, optional)</div>
      <CodeEditor value={query} onChange={setQuery} language="json" ariaLabel="Export query" theme={theme} height={100} completion={{ cid, dsl: true, index: () => index }} />
      <JobProgress state={job.state} verb="Exporting" />
      {job.state.result && <div className="es-job-result">{formatCount(job.state.result.docs)} documents written to <span className="mono">{job.state.result.path}</span></div>}
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- import

function formatOf(name: string): EsFileFormat {
  const n = name.toLowerCase();
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return 'csv';
  if (n.endsWith('.json')) return 'json';
  return 'ndjson';
}

/** First documents of the picked file (client-side preview). */
export function previewDocs(content: string, format: EsFileFormat, delimiter: string, max = 5): { docs: unknown[]; error: string | null } {
  try {
    if (format === 'json') {
      const v = JSON.parse(content) as unknown;
      return { docs: (Array.isArray(v) ? v : [v]).slice(0, max), error: null };
    }
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (format === 'ndjson') {
      const docs: unknown[] = [];
      for (const l of lines) {
        const v = JSON.parse(l) as Record<string, unknown>;
        if (isPlainObject(v) && Object.keys(v).length === 1 && ['index', 'create'].includes(Object.keys(v)[0])) continue; // bulk action line
        docs.push(v);
        if (docs.length >= max) break;
      }
      return { docs, error: null };
    }
    const header = lines[0]?.split(delimiter) ?? [];
    return { docs: lines.slice(1, max + 1).map((l) => Object.fromEntries(l.split(delimiter).map((v, i) => [header[i] ?? `col${i + 1}`, v]))), error: null };
  } catch (e) {
    return { docs: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export function ImportDialog({ cid, index, onClose, onDone, initialFile }: {
  cid: string; index: string; onClose(): void; onDone(index: string): void; initialFile?: { name: string; path: string | null; content: string };
}) {
  const [target, setTarget] = useState(index);
  const [file, setFile] = useState(initialFile ?? null);
  const [format, setFormat] = useState<EsFileFormat>(initialFile ? formatOf(initialFile.name) : 'ndjson');
  const [delimiter, setDelimiter] = useState(',');
  const [idField, setIdField] = useState('');
  const [batch, setBatch] = useState('1000');
  const [error, setError] = useState<string | null>(null);
  const job = useJob<EsImportResult>();
  const targets = useMemo(() => knownTargets(cid), [cid]);
  const preview = useMemo(() => (file ? previewDocs(file.content, format, delimiter) : null), [file, format, delimiter]);
  const pick = async () => {
    const f = await getPlatform().openTextFile({ filters: [{ name: 'NDJSON, JSON, CSV', extensions: ['ndjson', 'jsonl', 'json', 'csv', 'tsv'] }] });
    if (!f) return;
    setFile(f);
    setFormat(formatOf(f.name));
    if (f.name.toLowerCase().endsWith('.tsv')) setDelimiter('\t');
  };
  const run = async () => {
    const err = indexNameError(target);
    if (err) return setError(err);
    if (!file) return setError('Choose a file.');
    setError(null);
    const r = await job.run(() => api.es.importDocs(cid, {
      index: target, format, idField: idField.trim() || null, batchSize: Number(batch) || 1000,
      ...(file.path && getPlatform().hasFileSystem ? { path: file.path } : { upload: file.content }),
      ...(format === 'csv' ? { csv: { delimiter, header: true } } : {}),
    }));
    if (r) {
      toast(r.failed ? 'warning' : 'success', `Imported ${formatCount(r.indexed)} documents into ${target}`, r.failed ? `${r.failed} failed` : formatMs(r.tookMs));
      onDone(target);
      void loadAliases(cid, true);
    }
  };
  const running = job.state.status === 'running';
  const result = job.state.result;
  return (
    <Dialog title="Import documents" onClose={onClose} width={720} footer={
      <>
        <CancelJob state={job.state} />
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && <button type="button" className="btn btn-primary" disabled={running || !file || !target} onClick={() => void run()}><Upload size={14} aria-hidden /> {running ? 'Importing…' : 'Import'}</button>}
      </>
    }>
      <datalist id="es-import-targets">{targets.map((t) => <option key={t} value={t} />)}</datalist>
      <div className="form-grid">
        <span className="form-label">File</span>
        <span className="es-inline">
          <button type="button" className="btn btn-xs" onClick={() => void pick()}>Choose file…</button>
          {file && <span className="mono" title={file.path ?? file.name}>{file.name} <span className="muted">({formatCount(file.content.length)} chars)</span></span>}
        </span>
        <label className="form-label" htmlFor="es-im-index">Index<span className="req">*</span></label>
        <input id="es-im-index" className="input mono" list="es-import-targets" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="created when missing" />
        <label className="form-label" htmlFor="es-im-format">Format</label>
        <select id="es-im-format" className="input" value={format} onChange={(e) => setFormat(e.target.value as EsFileFormat)}>
          <option value="ndjson">NDJSON (also _bulk files)</option>
          <option value="json">JSON array</option>
          <option value="csv">CSV with a header row</option>
        </select>
        {format === 'csv' && (
          <>
            <label className="form-label" htmlFor="es-im-delim">Delimiter</label>
            <select id="es-im-delim" className="input" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
              <option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option>
            </select>
          </>
        )}
        <label className="form-label" htmlFor="es-im-id">Id field</label>
        <input id="es-im-id" className="input mono" placeholder="generated ids" value={idField} onChange={(e) => setIdField(e.target.value)} />
        <label className="form-label" htmlFor="es-im-batch">Batch size</label>
        <input id="es-im-batch" className="input" inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value.replace(/\D/g, ''))} />
      </div>
      {preview && (
        <div className="es-import-preview">
          <div className="es-dialog-label">Preview</div>
          {preview.error ? <div className="es-warn-text">{preview.error}</div> : preview.docs.map((d, i) => <div key={i} className="es-preview-doc"><JsonTree value={d} openDepth={0} /></div>)}
        </div>
      )}
      <JobProgress state={job.state} verb="Importing" />
      {result && (
        <div className="es-job-result">
          {formatCount(result.indexed)} indexed · {formatCount(result.failed)} failed · {formatMs(result.tookMs)}
          {result.errors.length > 0 && <ul className="es-failures">{result.errors.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </div>
      )}
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- alias

export function AliasDialog({ cid, index, onClose, onDone }: { cid: string; index: string; onClose(): void; onDone(): void }) {
  const theme = useEffectiveTheme();
  const [target, setTarget] = useState(index);
  const [alias, setAlias] = useState('');
  const [write, setWrite] = useState(false);
  const [filter, setFilter] = useState('');
  const [routing, setRouting] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = useMemo(() => knownTargets(cid), [cid]);
  const submit = async () => {
    const err = indexNameError(alias);
    if (err) return setError(`Alias: ${err}`);
    if (!target.trim()) return setError('Choose an index.');
    const f = parseLenient(filter);
    if (!f.ok) return setError(`Filter: ${f.error}`);
    setBusy(true);
    setError(null);
    try {
      await api.es.updateAliases(cid, { actions: [{ add: { index: target.trim(), alias, filter: f.value ?? undefined, routing: routing.trim() || null, isWriteIndex: write || null } }] });
      toast('success', `Alias ${alias} → ${target}`);
      onDone();
      onClose();
    } catch (e) {
      setError(esErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add alias" onClose={onClose} width={560} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !alias || !target} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add alias'}</button>
      </>
    }>
      <datalist id="es-alias-targets">{targets.map((t) => <option key={t} value={t} />)}</datalist>
      <div className="form-grid">
        <label className="form-label" htmlFor="es-al-index">Index<span className="req">*</span></label>
        <input id="es-al-index" className="input mono" list="es-alias-targets" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="index or pattern" />
        <label className="form-label" htmlFor="es-al-name">Alias<span className="req">*</span></label>
        <input id="es-al-name" className="input mono" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="my-alias" />
        <label className="form-label" htmlFor="es-al-routing">Routing</label>
        <input id="es-al-routing" className="input mono" value={routing} onChange={(e) => setRouting(e.target.value)} placeholder="none" />
        <span className="form-label" />
        <label className="check"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Write index (writes through the alias go here)</label>
      </div>
      <div className="es-dialog-label">Filter (query DSL "query" object, optional: a filtered alias)</div>
      <CodeEditor value={filter} onChange={setFilter} language="json" ariaLabel="Alias filter" theme={theme} height={100} completion={{ cid, dsl: true, index: () => target || null }} />
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- JSON viewer / editor

export function JsonDialog({ title, subtitle, value, onClose }: { title: string; subtitle?: string; value: unknown; onClose(): void }) {
  return (
    <Dialog title={title} onClose={onClose} width={720} footer={
      <>
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(pretty(value)).then(() => toast('success', 'Copied JSON'), () => undefined)}>Copy JSON</button>
        <span className="flex-1" />
        <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      </>
    }>
      {subtitle && <p className="muted">{subtitle}</p>}
      <div className="es-json-dialog"><JsonTree value={value} openDepth={3} label={title} /></div>
    </Dialog>
  );
}

export function JsonEditDialog({ title, help, initial, action, theme, onClose, onSave }: {
  title: string; help?: string; initial: string; action: string; theme: 'light' | 'dark'; onClose(): void; onSave(value: unknown): Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const r = parseLenient(text);
    if (!r.ok || !isPlainObject(r.value)) return setError(r.ok ? 'A JSON object is required.' : r.error);
    setBusy(true);
    setError(null);
    try {
      await onSave(r.value);
      onClose();
    } catch (e) {
      setError(esErrorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} width={640} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : action}</button>
      </>
    }>
      {help && <p className="form-hint">{help}</p>}
      <CodeEditor value={text} onChange={setText} language="json" ariaLabel={title} theme={theme} height={260} onRun={() => void save()} />
      <ErrorLine error={error} />
    </Dialog>
  );
}

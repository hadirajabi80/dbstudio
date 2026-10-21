// Schema analysis (docs/PLAN-M2.md 6.5): samples documents (job with progress), then shows every field with its type
// distribution as a stacked bar, how often it is present, example values and min/max/distinct; mixed-type fields are
// flagged. Example chips "Use as filter"; Export JSON Schema; "Use as validation" opens the Validation tab with it.
import { AlertTriangle, ChevronDown, ChevronRight, Download, Filter, Play, ShieldCheck, Square } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import type { MongoSchemaField, MongoSchemaResult } from '../../api/types';
import { fromEjson, scalarShell, shellKey, toShell, typeAliasLabel } from '../../mongo/bson';
import { jsonSchemaFrom, mixedTypeFields, validatorFrom } from '../../mongo/jsonSchema';
import { getPlatform } from '../../platform';
import { toast } from '../../store/ui';
import { Select } from '../common/Select';
import type { SubViewProps } from './CollectionView';
import { MongoEditor } from './MongoEditor';
import { DEFAULT_QUERY } from './open';
import { draftValidator, plural, useJob } from './util';

const TYPE_ORDER = ['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId', 'object', 'array', 'binData', 'null'];

function typeClass(t: string): string {
  const i = TYPE_ORDER.indexOf(t);
  return `mg-tc mg-tc-${i < 0 ? 'other' : t}`;
}

function exampleText(v: unknown): string {
  try {
    return scalarShell(fromEjson(v));
  } catch {
    return String(v);
  }
}

function FieldRow({ f, depth, mixed, onFilter }: { f: MongoSchemaField; depth: number; mixed: Set<string>; onFilter: (path: string, value: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const name = f.path.slice(f.path.lastIndexOf('.') + 1);
  const pct = Math.round(f.probability * 1000) / 10;
  const isMixed = mixed.has(f.path);
  return (
    <>
      <div className={`mg-sfield ${isMixed ? 'mixed' : ''}`} style={{ paddingLeft: 12 + depth * 18 }} role="row">
        <div className="mg-sfield-name" role="cell">
          {f.nested.length > 0 ? (
            <button className="mg-twisty" aria-label={open ? `Collapse ${f.path}` : `Expand ${f.path}`} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            </button>
          ) : <span className="mg-twisty-pad" />}
          <span className="mg-sfield-key" title={f.path}>{name}</span>
          {isMixed && <span className="pill pill-warning" title="Values of this field have different types"><AlertTriangle size={11} aria-hidden /> mixed types</span>}
        </div>
        <div className="mg-sfield-types" role="cell">
          <div className="mg-typebar" aria-label={f.types.map((t) => `${typeAliasLabel(t.bsonType)} ${t.pct}%`).join(', ')}>
            {f.types.map((t) => <span key={t.bsonType} className={typeClass(t.bsonType)} style={{ width: `${t.pct}%` }} title={`${typeAliasLabel(t.bsonType)}: ${t.count.toLocaleString()} (${t.pct}%)`} />)}
          </div>
          <div className="mg-typelegend">
            {f.types.map((t) => <span key={t.bsonType}><i className={typeClass(t.bsonType)} aria-hidden />{typeAliasLabel(t.bsonType)} <span className="muted">{t.pct}%</span></span>)}
          </div>
        </div>
        <div className="mg-sfield-prob" role="cell" title={`Present in ${pct}% of the sampled ${depth ? 'parent values' : 'documents'}`}>
          <div className="mg-probbar"><span style={{ width: `${pct}%` }} /></div>
          <span>{pct}%</span>
        </div>
        <div className="mg-sfield-ex" role="cell">
          {f.examples.slice(0, 5).map((e, i) => (
            <button key={i} className="mg-chip" title="Use as filter" onClick={() => onFilter(f.path, e)}>{exampleText(e)}</button>
          ))}
          {f.stats && (
            <span className="mg-sfield-stats muted">
              {f.stats.distinct.toLocaleString()} distinct · min {exampleText(f.stats.min)} · max {exampleText(f.stats.max)}
            </span>
          )}
        </div>
      </div>
      {open && f.nested.map((n) => <FieldRow key={n.path} f={n} depth={depth + 1} mixed={mixed} onFilter={onFilter} />)}
    </>
  );
}

export default function SchemaView({ cid, db, coll, state, patch, theme }: SubViewProps) {
  const [sampleSize, setSampleSize] = useState(1000);
  const [filter, setFilter] = useState('');
  const job = useJob<MongoSchemaResult>();
  const result = job.state.result;
  const mixed = new Set(result ? mixedTypeFields(result.fields) : []);

  const analyze = () => void job.run(() => api.mongo.schema(cid, db, coll, { sampleSize, filter: filter || null }));
  const cancel = () => {
    if (job.state.jobId) void api.cancelJob(job.state.jobId).catch(() => undefined);
  };

  const useAsFilter = (path: string, value: unknown) => {
    const filterText = `{ ${shellKey(path)}: ${exampleText(value)} }`;
    patch({ sub: 'documents', query: { ...DEFAULT_QUERY, ...state.query, filter: filterText, skip: 0 } });
  };

  const exportSchema = async () => {
    if (!result) return;
    const json = JSON.stringify({ $jsonSchema: JSON.parse(toShellJson(result)) }, null, 2);
    await getPlatform().saveFile({ suggestedName: `${coll}.schema.json`, content: json, mime: 'application/json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  };

  const useAsValidation = () => {
    if (!result) return;
    patch({ sub: 'validation' });
    draftValidator(cid, db, coll, toShell(validatorFrom(result), { inline: 70 }));
    toast('info', 'Validation rules drafted from the schema', 'Review them, then Save.');
  };

  const running = job.state.status === 'running';
  return (
    <div className="mg-schema">
      <div className="mg-toolbar" role="toolbar" aria-label="Schema analysis">
        <span className="mg-qlabel">Filter</span>
        <div className="mg-qfield mg-schema-filter">
          <MongoEditor singleLine mode="filter" theme={theme} value={filter} onChange={setFilter} onSubmit={analyze} placeholder="{} (all documents)" ariaLabel="Schema filter" />
        </div>
        <Select aria-label="Sample size" size="sm" value={sampleSize} onChange={setSampleSize}
          options={[100, 1000, 5000, 20000].map((n) => ({ value: n, label: `Sample ${n.toLocaleString()}` }))} />
        {running ? (
          <button className="btn btn-xs" onClick={cancel}><Square size={12} aria-hidden /> Cancel</button>
        ) : (
          <button className="btn btn-xs btn-primary" onClick={analyze}><Play size={14} aria-hidden /> {result ? 'Analyze again' : 'Analyze schema'}</button>
        )}
        <span className="flex-1" />
        <button className="btn btn-xs" disabled={!result} onClick={() => void exportSchema()}><Download size={14} aria-hidden /> Export JSON Schema</button>
        <button className="btn btn-xs" disabled={!result} onClick={useAsValidation}><ShieldCheck size={14} aria-hidden /> Use as validation</button>
      </div>
      {running && (
        <div className="mg-progress" role="progressbar" aria-valuemin={0} aria-valuemax={job.state.total ?? undefined} aria-valuenow={job.state.done}>
          <span style={{ width: job.state.total ? `${Math.min(100, (job.state.done / job.state.total) * 100)}%` : '30%' }} className={job.state.total ? undefined : 'indeterminate'} />
          <em>{job.state.message ?? 'Sampling'} · {job.state.done.toLocaleString()}{job.state.total ? ` / ${job.state.total.toLocaleString()}` : ''}</em>
        </div>
      )}
      {job.state.status === 'error' && <div className="mg-error" role="alert"><strong>Analysis failed.</strong> {job.state.error}</div>}
      {job.state.status === 'idle' && (
        <div className="mg-empty">
          <p>Sample documents to see every field, its types and how often it is present.</p>
          <button className="btn btn-primary" onClick={analyze}><Play size={14} aria-hidden /> Analyze schema</button>
        </div>
      )}
      {result && (
        <div className="mg-schema-body">
          <p className="mg-schema-sum">
            {plural(result.sampled, 'document')} sampled · {plural(result.fields.length, 'top-level field')}
            {mixed.size > 0 && <span className="text-warning"> · <AlertTriangle size={12} aria-hidden /> {plural(mixed.size, 'field')} with mixed types</span>}
            <span className="muted"> · click an example to filter by it <Filter size={11} aria-hidden /></span>
          </p>
          <div className="mg-sfields" role="table" aria-label="Fields">
            <div className="mg-sfield mg-sfield-header" role="row">
              <div role="columnheader">Field</div><div role="columnheader">Types</div><div role="columnheader">Present</div><div role="columnheader">Examples</div>
            </div>
            {result.fields.map((f) => <FieldRow key={f.path} f={f} depth={0} mixed={mixed} onFilter={useAsFilter} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function toShellJson(result: MongoSchemaResult): string {
  // $jsonSchema bodies only use strings, arrays and documents: relaxed EJSON == plain JSON
  return JSON.stringify(jsonToPlain(jsonSchemaFrom(result)));
}

function jsonToPlain(v: ReturnType<typeof jsonSchemaFrom>): unknown {
  if (v.t === 'object') return Object.fromEntries(v.v.map(([k, x]) => [k, jsonToPlain(x)]));
  if (v.t === 'array') return v.v.map(jsonToPlain);
  if (v.t === 'string') return v.v;
  return null;
}

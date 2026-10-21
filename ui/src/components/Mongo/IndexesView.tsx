// Indexes (docs/PLAN-M2.md 6.5): name and key definition, type, size, usage ($indexStats) and properties (unique,
// sparse, partial, TTL, collation); Create index dialog (fields with completion, 1 / -1 / text / 2dsphere / 2d /
// hashed, options) with build progress for long builds; Drop with confirmation.
import { KeyRound, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { MongoFieldPath, MongoIndexInfo, MongoIndexKeyPart, MongoIndexKeyType } from '../../api/types';
import { parseEjson, toShell } from '../../mongo/bson';
import { checkShell } from '../../mongo/shellJson';
import { toast, useUi } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import type { SubViewProps } from './CollectionView';
import { showMongoDialog } from './dialogHost';
import { MongoEditor } from './MongoEditor';
import { cachedFields, loadFields } from './store';
import { formatBytes } from './tree';
import { errorText, waitForJob } from './util';

export function indexKind(ix: MongoIndexInfo): string {
  const types = ix.key.map((k) => k.type);
  if (types.includes('text')) return 'Text';
  if (types.includes('2dsphere') || types.includes('2d')) return 'Geospatial';
  if (types.includes('hashed')) return 'Hashed';
  if (ix.ttlSeconds !== null) return 'TTL';
  if (ix.key.some((k) => k.field.includes('$**'))) return 'Wildcard';
  return ix.key.length > 1 ? 'Compound' : 'Regular';
}

function ttlText(s: number): string {
  if (s % 86400 === 0 && s) return `${s / 86400} d`;
  if (s % 3600 === 0 && s) return `${s / 3600} h`;
  if (s % 60 === 0 && s) return `${s / 60} min`;
  return `${s} s`;
}

export default function IndexesView({ cid, db, coll, theme, readOnly, statsChanged }: SubViewProps) {
  const [list, setList] = useState<MongoIndexInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState<{ name: string; done: number; total: number | null; message: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.mongo.indexes(cid, db, coll));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [cid, db, coll]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = () => {
    void loadFields(cid, db, coll).then((fields) => showMongoDialog((close) => (
      <CreateIndexDialog cid={cid} db={db} coll={coll} fields={fields} theme={theme} onClose={close}
        onStarted={(name, jobId) => {
          if (!jobId) {
            toast('success', `Index ${name} created`);
            void load();
            statsChanged();
            return;
          }
          setBuilding({ name, done: 0, total: null, message: 'Starting' });
          waitForJob(jobId, (ev) => setBuilding({ name, done: ev.done, total: ev.total, message: ev.message })).then(
            () => toast('success', `Index ${name} built`),
            (e) => toast('error', `Building ${name} failed`, errorText(e)),
          ).finally(() => {
            setBuilding(null);
            void load();
            statsChanged();
          });
        }} />
    )));
  };

  const drop = async (ix: MongoIndexInfo) => {
    const ok = await useUi.getState().askConfirm({
      title: `Drop index ${ix.name}?`, danger: true, confirmLabel: 'Drop index',
      message: `Queries on ${db}.${coll} that use this index will fall back to other indexes or collection scans.`,
      items: [`db.${coll}.dropIndex("${ix.name}")`],
    });
    if (!ok) return;
    try {
      await api.mongo.dropIndex(cid, db, coll, ix.name);
      toast('success', `Dropped index ${ix.name}`);
      void load();
      statsChanged();
    } catch (e) {
      toast('error', 'Drop failed', errorText(e));
    }
  };

  return (
    <div className="mg-indexes">
      <div className="mg-toolbar" role="toolbar" aria-label="Indexes">
        <button className="btn btn-xs btn-primary" onClick={create} disabled={readOnly || !!building} title={readOnly ? 'The connection is read-only' : undefined}><Plus size={14} aria-hidden /> Create index</button>
        <button className="icon-btn sm" aria-label="Refresh indexes" onClick={() => void load()}><RefreshCw size={14} /></button>
        <span className="flex-1" />
        {list && <span className="muted">{list.length} index{list.length === 1 ? '' : 'es'} · {formatBytes(list.reduce((s, i) => s + (i.size ?? 0), 0))}</span>}
      </div>
      {building && (
        <div className="mg-progress" role="progressbar" aria-label={`Building index ${building.name}`} aria-valuenow={building.done} aria-valuemax={building.total ?? undefined}>
          <span style={{ width: building.total ? `${Math.min(100, (building.done / building.total) * 100)}%` : '30%' }} className={building.total ? undefined : 'indeterminate'} />
          <em>Building {building.name}: {building.message ?? ''} {building.total ? `${building.done.toLocaleString()} / ${building.total.toLocaleString()}` : ''}</em>
        </div>
      )}
      {error && <div className="mg-error" role="alert">{error}</div>}
      {list && (
        <div className="mg-table-scroll">
          <table className="mg-table mg-ixtable" aria-label="Indexes">
            <thead><tr><th>Name and definition</th><th>Type</th><th>Size</th><th>Usage</th><th>Properties</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.map((ix) => (
                <tr key={ix.name}>
                  <td>
                    <div className="mg-ixname"><KeyRound size={13} aria-hidden className="obj-pk" /> {ix.name}</div>
                    <div className="mg-ixkeys">{ix.key.map((k) => <span key={k.field} className="mg-ixkey"><span>{k.field}</span><b>{String(k.type)}</b></span>)}</div>
                  </td>
                  <td>{indexKind(ix)}</td>
                  <td className="mg-num">{formatBytes(ix.size) || '—'}</td>
                  <td className="mg-num">{ix.usage ? <span title={ix.usage.since ? `since ${new Date(ix.usage.since).toLocaleString()}` : undefined}>{ix.usage.ops.toLocaleString()} ops</span> : <span className="muted" title="$indexStats is not permitted">—</span>}</td>
                  <td>
                    <span className="mg-props">
                      {ix.unique && <span className="pill">unique</span>}
                      {ix.sparse && <span className="pill pill-muted">sparse</span>}
                      {ix.ttlSeconds !== null && <span className="pill pill-muted" title={`expireAfterSeconds: ${ix.ttlSeconds}`}>TTL {ttlText(ix.ttlSeconds)}</span>}
                      {ix.partialFilter && <span className="pill pill-muted" title={toShell(parseEjson(ix.partialFilter), { inline: 200 })}>partial</span>}
                      {ix.collation && <span className="pill pill-muted" title={toShell(parseEjson(ix.collation), { inline: 200 })}>collation</span>}
                    </span>
                  </td>
                  <td className="mg-td-actions">
                    {ix.name !== '_id_' && (
                      <button className="icon-btn xs danger" aria-label={`Drop index ${ix.name}`} title={readOnly ? 'The connection is read-only' : 'Drop index'} disabled={readOnly} onClick={() => void drop(ix)}><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TYPES: { value: string; label: string }[] = [
  { value: '1', label: '1 (asc)' }, { value: '-1', label: '-1 (desc)' }, { value: 'text', label: 'text' },
  { value: '2dsphere', label: '2dsphere' }, { value: '2d', label: '2d' }, { value: 'hashed', label: 'hashed' },
];

const toType = (v: string): MongoIndexKeyType => (v === '1' ? 1 : v === '-1' ? -1 : (v as MongoIndexKeyType));

export function CreateIndexDialog({ cid, db, coll, fields = cachedFields(cid, db, coll), theme, onClose, onStarted }: {
  cid: string; db: string; coll: string; fields?: readonly MongoFieldPath[]; theme: SubViewProps['theme'];
  onClose: () => void; onStarted: (name: string, jobId: string | null) => void;
}) {
  const [keys, setKeys] = useState<{ field: string; type: string }[]>([{ field: '', type: '1' }]);
  const [name, setName] = useState('');
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState('');
  const [partial, setPartial] = useState('');
  const [collation, setCollation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = keys.length > 0 && keys.every((k) => k.field.trim()) && new Set(keys.map((k) => k.field.trim())).size === keys.length;
  const partialErr = partial.trim() ? checkShell(partial)?.message : null;
  const collErr = collation.trim() ? checkShell(collation)?.message : null;
  const ttlErr = ttl && keys.length !== 1 ? 'TTL indexes have exactly one field.' : null;
  const autoName = keys.filter((k) => k.field.trim()).map((k) => `${k.field.trim()}_${k.type}`).join('_');

  const submit = async () => {
    if (!valid || partialErr || collErr || ttlErr || busy) return;
    setBusy(true);
    setError(null);
    try {
      const key: MongoIndexKeyPart[] = keys.map((k) => ({ field: k.field.trim(), type: toType(k.type) }));
      const r = await api.mongo.createIndex(cid, db, coll, {
        key, options: {
          name: name.trim() || null, unique, sparse, expireAfterSeconds: ttl ? Number(ttl) : null,
          partialFilterExpression: partial.trim() || null, collation: collation.trim() || null,
        },
      });
      onStarted(r.name, r.jobId);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Create index on ${db}.${coll}`} onClose={onClose} width={620}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid || !!partialErr || !!collErr || !!ttlErr || busy} onClick={() => void submit()}>Create index</button></>}>
      <datalist id="mg-ix-fields">{fields.map((f) => <option key={f.path} value={f.path} />)}</datalist>
      <fieldset className="mg-ixfields">
        <legend>Fields</legend>
        {keys.map((k, i) => (
          <div key={i} className="mg-ixfield">
            <input className="input" list="mg-ix-fields" aria-label={`Field ${i + 1}`} placeholder="field.path" value={k.field} spellCheck={false}
              onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} />
            <Select aria-label={`Field ${i + 1} type`} value={k.type} onChange={(type) => setKeys(keys.map((x, j) => (j === i ? { ...x, type } : x)))} options={TYPES} />
            <button className="icon-btn" aria-label={`Remove field ${i + 1}`} disabled={keys.length === 1} onClick={() => setKeys(keys.filter((_, j) => j !== i))}><X size={14} /></button>
          </div>
        ))}
        <button className="link-btn" onClick={() => setKeys([...keys, { field: '', type: '1' }])}><Plus size={12} aria-hidden /> Add field</button>
      </fieldset>
      <div className="form-grid mg-ixopts">
        <label className="form-label" htmlFor="mg-ix-name">Name</label>
        <input id="mg-ix-name" className="input" placeholder={autoName || 'generated from the fields'} value={name} onChange={(e) => setName(e.target.value)} />
        <span className="form-label">Options</span>
        <div className="mg-ixchecks">
          <label className="check"><input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> Unique</label>
          <label className="check"><input type="checkbox" checked={sparse} onChange={(e) => setSparse(e.target.checked)} /> Sparse</label>
        </div>
        <label className="form-label" htmlFor="mg-ix-ttl">TTL (seconds)</label>
        <input id="mg-ix-ttl" className={`input ${ttlErr ? 'invalid' : ''}`} inputMode="numeric" placeholder="no expiry" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ''))} />
        <span className="form-label">Partial filter</span>
        <MongoEditor singleLine mode="filter" fields={fields} theme={theme} value={partial} onChange={setPartial} placeholder={'{ status: { $exists: true } }'} ariaLabel="Partial filter expression" invalid={!!partialErr} />
        <span className="form-label">Collation</span>
        <MongoEditor singleLine mode="collation" theme={theme} value={collation} onChange={setCollation} placeholder={'{ locale: "en", strength: 2 }'} ariaLabel="Collation" invalid={!!collErr} />
      </div>
      {(error || partialErr || collErr || ttlErr) && <p className="form-error" role="alert">{error ?? partialErr ?? collErr ?? ttlErr}</p>}
    </Dialog>
  );
}

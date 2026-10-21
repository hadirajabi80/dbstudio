// Export documents (docs/PLAN-M2.md 6.5): JSON (relaxed or canonical Extended JSON), JSON Lines or CSV (dot paths
// flattened; choose the columns); the current query or the whole collection. Desktop: the engine writes the file as
// a job with progress; browser: the file is downloaded.
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { MongoExportFormat, MongoExportResult, MongoFieldPath } from '../../api/types';
import { isEmptyDocText } from '../../mongo/shellJson';
import { getPlatform } from '../../platform';
import { toast } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import type { QueryState } from './open';
import { loadFields } from './store';
import { errorText, plural, useJob } from './util';

export function ExportDialog({ cid, db, coll, query, onClose }: { cid: string; db: string; coll: string; query?: QueryState; onClose: () => void }) {
  const hasQuery = !!query && !(isEmptyDocText(query.filter) && !query.projection.trim() && !query.sort.trim());
  const [scope, setScope] = useState<'query' | 'all'>(hasQuery ? 'query' : 'all');
  const [format, setFormat] = useState<MongoExportFormat>('json');
  const [ejsonMode, setEjsonMode] = useState<'relaxed' | 'canonical'>('relaxed');
  const [limit, setLimit] = useState('');
  const [fields, setFields] = useState<MongoFieldPath[]>([]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useJob<MongoExportResult>();

  useEffect(() => {
    void loadFields(cid, db, coll).then((f) => setFields(f.filter((x) => !x.types.every((t) => t === 'object'))));
  }, [cid, db, coll]);

  const ext = format === 'jsonl' ? 'jsonl' : format;
  const run = async () => {
    setError(null);
    const q = scope === 'query' && query ? query : null;
    const body = {
      format, filter: q?.filter ?? '', projection: q?.projection || null, sort: q?.sort || null, limit: limit ? Number(limit) : null,
      fields: format === 'csv' && picked ? fields.map((f) => f.path).filter((p) => picked.has(p)) : undefined, ejsonMode,
    };
    const platform = getPlatform();
    try {
      if (platform.hasFileSystem) {
        const path = await platform.showSaveDialog({ title: 'Export documents', defaultPath: `${coll}.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }] });
        if (!path) return;
        const r = await job.run(async () => {
          const res = await api.mongo.exportDocs(cid, db, coll, { ...body, path });
          if (!('jobId' in res)) throw new Error('The engine returned a file instead of starting an export job.');
          return res;
        });
        if (r) {
          toast('success', `Exported ${plural(r.docs, 'document')}`, r.path ?? undefined);
          onClose();
        }
      } else {
        const res = await api.mongo.exportDocs(cid, db, coll, { ...body, path: null });
        if ('blob' in res) {
          await platform.saveFile({ suggestedName: res.filename ?? `${coll}.${ext}`, content: res.blob });
          toast('success', `Exported ${db}.${coll}`, res.filename ?? undefined);
          onClose();
        }
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const running = job.state.status === 'running';
  return (
    <Dialog title={`Export ${db}.${coll}`} ariaLabel="Export documents" onClose={onClose} width={600}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={running} onClick={() => void run()}><Download size={14} aria-hidden /> Export</button></>}>
      <div className="form-grid">
        <span className="form-label">Documents</span>
        <div className="mg-radios" role="radiogroup" aria-label="Documents">
          <label className="check"><input type="radio" name="mg-exp-scope" checked={scope === 'query'} disabled={!hasQuery} onChange={() => setScope('query')} /> Current query{hasQuery && query ? <code className="mg-exp-q">{query.filter.trim() || '{}'}{query.sort.trim() ? ` sort ${query.sort.trim()}` : ''}</code> : <span className="muted"> (none)</span>}</label>
          <label className="check"><input type="radio" name="mg-exp-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> Whole collection</label>
        </div>
        <span className="form-label">Format</span>
        <div className="segmented" role="radiogroup" aria-label="Format">
          {(['json', 'jsonl', 'csv'] as const).map((f) => <button key={f} role="radio" aria-checked={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f === 'jsonl' ? 'JSON Lines' : f.toUpperCase()}</button>)}
        </div>
        {format !== 'csv' ? (
          <>
            <span className="form-label">Extended JSON</span>
            <div className="mg-radios" role="radiogroup" aria-label="Extended JSON">
              <label className="check"><input type="radio" name="mg-exp-ejson" checked={ejsonMode === 'relaxed'} onChange={() => setEjsonMode('relaxed')} /> Relaxed (readable)</label>
              <label className="check"><input type="radio" name="mg-exp-ejson" checked={ejsonMode === 'canonical'} onChange={() => setEjsonMode('canonical')} /> Canonical (keeps every type for re-import)</label>
            </div>
          </>
        ) : (
          <>
            <span className="form-label">Columns</span>
            <div className="mg-colpick">
              <label className="check"><input type="checkbox" checked={!picked} onChange={(e) => setPicked(e.target.checked ? null : new Set(fields.map((f) => f.path)))} /> All fields (flattened dot paths)</label>
              {picked && (
                <div className="mg-colpick-list">
                  {fields.map((f) => (
                    <label key={f.path} className="check sm"><input type="checkbox" checked={picked.has(f.path)} onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(f.path); else n.delete(f.path);
                      setPicked(n);
                    }} /> {f.path}</label>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        <label className="form-label" htmlFor="mg-exp-limit">Limit</label>
        <input id="mg-exp-limit" className="input" inputMode="numeric" placeholder="all" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />
      </div>
      {running && (
        <div className="mg-progress" role="progressbar" aria-label="Export progress" aria-valuenow={job.state.done}>
          <span className="indeterminate" /><em>{job.state.done.toLocaleString()} documents written</em>
        </div>
      )}
      {(error || job.state.error) && <p className="form-error" role="alert">{error ?? job.state.error}</p>}
    </Dialog>
  );
}

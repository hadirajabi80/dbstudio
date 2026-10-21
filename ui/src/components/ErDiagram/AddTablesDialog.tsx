// "Add tables…": pick tables of any schema of the connection's database (loaded on demand) to add to the diagram.
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { dbKey, useCatalog } from '../../store/catalog';
import { Dialog } from '../common/Dialog';
import { ObjectIcon } from '../common/icons';
import { Select } from '../common/Select';
import { tableKey } from './model';

const TABULAR = new Set(['table', 'view', 'mview']);

export interface AddTablesDialogProps {
  connectionId: string;
  database: string | null;
  initialSchema: string | null;
  /** Keys already in the diagram (not offered). */
  members: ReadonlySet<string>;
  onAdd(keys: string[]): void;
  onClose(): void;
}

export function AddTablesDialog({ connectionId, database, initialSchema, members, onAdd, onClose }: AddTablesDialogProps) {
  const db = useCatalog((s) => s.dbs[dbKey(connectionId, database)]);
  const schemaNames = useMemo(() => db?.schemasResp?.schemas.map((s) => s.name) ?? Object.keys(db?.loaded ?? {}), [db]);
  const [schema, setSchema] = useState<string>(initialSchema ?? schemaNames[0] ?? '');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    void useCatalog.getState().loadSchemas(connectionId, database);
  }, [connectionId, database]);
  useEffect(() => {
    if (schema) void useCatalog.getState().loadSchema(connectionId, database, schema);
  }, [connectionId, database, schema]);

  const status = db?.schemaStatus[schema];
  const objects = useMemo(() => {
    const s = db?.loaded[schema];
    const needle = q.trim().toLowerCase();
    return (s?.objects ?? [])
      .filter((o) => TABULAR.has(o.t) && !members.has(tableKey(schema, o.n)) && (!needle || o.n.toLowerCase().includes(needle)))
      .sort((a, b) => a.n.localeCompare(b.n));
  }, [db, schema, q, members]);

  const toggle = (k: string) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };
  const submit = () => {
    if (picked.size) onAdd([...picked]);
    onClose();
  };

  return (
    <Dialog
      title="Add tables to diagram"
      onClose={onClose}
      width={460}
      onSubmit={submit}
      footer={(
        <>
          <span className="flex-1 muted er-add-count">{picked.size ? `${picked.size} selected` : ''}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!picked.size} onClick={submit}>Add {picked.size || ''}</button>
        </>
      )}
    >
      <div className="er-add-head">
        <Select aria-label="Schema" value={schema} onChange={(v) => setSchema(v)} options={schemaNames.map((s) => ({ value: s, label: s }))} mono style={{ minWidth: 140 }} />
        <div className="search-box er-add-search">
          <Search size={14} aria-hidden="true" />
          <input className="input" placeholder="Filter tables" aria-label="Filter tables" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="er-add-list" role="group" aria-label={`Tables of ${schema}`}>
        {status === 'loading' && !objects.length && <div className="muted er-add-empty">Loading {schema}…</div>}
        {status !== 'loading' && !objects.length && <div className="muted er-add-empty">{q ? 'No table matches the filter' : 'Every table of this schema is already in the diagram'}</div>}
        {objects.map((o) => {
          const k = tableKey(schema, o.n);
          return (
            <label key={k} className="check er-add-item">
              <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} />
              <ObjectIcon type={o.t} size={14} />
              <span className="mono">{o.n}</span>
              {o.fk?.length ? <span className="muted er-add-meta">{o.fk.length} FK</span> : null}
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}

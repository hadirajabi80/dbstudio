// "New procedure…" wizard (docs/PLAN-M1.5.md 1.3.3): schema, name, parameters, return type, Oracle package member.
// Create opens a new console with the dialect template inserted as a Monaco snippet (Tab through the placeholders).
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { catalogDatabase, newConsole } from '../../app/actions';
import { Dialog } from '../../components/common/Dialog';
import { useCatalog } from '../../store/catalog';
import { dbKey } from '../../store/catalog';
import { toast } from '../../store/ui';
import { useDesignerUi, type WizardRequest } from '../store';
import { insertSnippetInTab } from '../snippet';
import {
  DEFAULT_PARAM_TYPE, DEFAULT_RETURN_TYPE, defaultName, kindsFor, routineSnippet, type ParamDirection, type RoutineKind, type WizardParam, type WizardSpec,
} from './templates';

const KIND_LABEL: Record<RoutineKind, string> = { procedure: 'Procedure', function: 'Function', package: 'Package', trigger: 'Trigger' };

export function ProcWizard({ req }: { req: WizardRequest }) {
  const close = useDesignerUi((s) => s.closeWizard);
  const kinds = kindsFor(req.dialect);
  const [kind, setKind] = useState<RoutineKind>(req.kind && kinds.includes(req.kind) ? req.kind : kinds[0]);
  const [schema, setSchema] = useState(req.schema ?? '');
  const [name, setName] = useState('');
  const [params, setParams] = useState<WizardParam[]>([]);
  const [returns, setReturns] = useState(DEFAULT_RETURN_TYPE[req.dialect]);
  const [table, setTable] = useState(req.table ?? '');
  const [timing, setTiming] = useState<'BEFORE' | 'AFTER' | 'INSTEAD OF'>(req.dialect === 'plsql' ? 'BEFORE' : 'AFTER');
  const [events, setEvents] = useState<('INSERT' | 'UPDATE' | 'DELETE')[]>(['INSERT']);
  const [pkgMember, setPkgMember] = useState(!!req.packageName);
  const [pkgName, setPkgName] = useState(req.packageName ?? '');
  const [busy, setBusy] = useState(false);

  const db = useCatalog((s) => s.dbs[dbKey(req.connectionId, catalogDatabase(req.connectionId, req.database))]);
  const schemas = db?.snapshot?.schemas.map((s) => s.name) ?? (req.schema ? [req.schema] : []);
  const objects = useMemo(() => db?.snapshot?.schemas.find((s) => s.name === (schema || db?.defaultSchema))?.objects ?? [], [db, schema]);
  const tables = objects.filter((o) => o.t === 'table' || o.t === 'view').map((o) => o.n);
  const packages = objects.filter((o) => o.t === 'package').map((o) => o.n);

  useEffect(() => {
    if (!table && tables.length && kind === 'trigger') setTable(tables[0]);
  }, [kind, tables.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const memberMode = req.dialect === 'plsql' && pkgMember && (kind === 'procedure' || kind === 'function');
  const isRoutine = kind === 'procedure' || kind === 'function' || kind === 'package';

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const spec: WizardSpec = {
        dialect: req.dialect, kind, schema: schema || null, name: name.trim() || defaultName(kind, req.dialect), params, returns,
        trigger: kind === 'trigger' ? { table: table || 'table_name', timing, events: events.length ? events : ['INSERT'], forEachRow: req.dialect !== 'tsql' } : undefined,
      };
      if (memberMode) {
        if (!pkgName) {
          toast('warning', 'Choose the package to add the member to');
          return;
        }
        const ref = { database: req.database, schema: schema || null, name: pkgName, type: 'package' as const };
        const ddl = (await api.ddl(req.connectionId, req.database, ref)).ddl;
        const [specPart, bodyPart] = splitPackage(ddl);
        spec.packageMember = { packageName: pkgName, spec: specPart, body: bodyPart, member: kind === 'function' ? 'function' : 'procedure' };
      }
      const snippet = routineSnippet(spec);
      const id = newConsole(req.connectionId, req.database, '');
      void insertSnippetInTab(id, snippet);
      close();
    } catch (e) {
      toast('error', 'Could not prepare the template', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setParam = (i: number, p: Partial<WizardParam>) => setParams((ps) => ps.map((x, k) => (k === i ? { ...x, ...p } : x)));

  return (
    <Dialog
      title={`New ${KIND_LABEL[kind].toLowerCase()}`}
      onClose={close}
      width={640}
      className="dz-wizard"
      onSubmit={() => void create()}
      footer={
        <>
          <span className="flex-1 muted">Opens in a new console as a template; Tab moves through the placeholders, F5 creates it.</span>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-label" htmlFor="dz-w-kind">
          Kind
        </label>
        <div className="form-control">
          <div className="segmented" role="radiogroup" aria-label="Kind" id="dz-w-kind">
            {kinds.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        {req.dialect !== 'sqlite' && (
          <>
            <label className="form-label" htmlFor="dz-w-schema">
              Schema
            </label>
            <div className="form-control">
              <select id="dz-w-schema" className="input" value={schema} onChange={(e) => setSchema(e.target.value)}>
                {(schemas.length ? schemas : [schema]).map((s) => (
                  <option key={s} value={s}>
                    {s || '(default)'}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <label className="form-label" htmlFor="dz-w-name">
          Name
        </label>
        <div className="form-control">
          <input id="dz-w-name" className="input mono" data-autofocus value={name} placeholder={defaultName(kind, req.dialect)} onChange={(e) => setName(e.target.value)} />
        </div>
        {req.dialect === 'plsql' && (kind === 'procedure' || kind === 'function') && (
          <>
            <span className="form-label">Package</span>
            <div className="form-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label className="check">
                <input type="checkbox" checked={pkgMember} onChange={(e) => setPkgMember(e.target.checked)} />
                Add to an existing package
              </label>
              {pkgMember && (
                <select className="input" style={{ width: 'auto' }} aria-label="Package" value={pkgName} onChange={(e) => setPkgName(e.target.value)}>
                  <option value="">(choose)</option>
                  {packages.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              )}
            </div>
          </>
        )}
        {kind === 'function' && (
          <>
            <label className="form-label" htmlFor="dz-w-ret">
              Returns
            </label>
            <div className="form-control">
              <input id="dz-w-ret" className="input mono" value={returns} onChange={(e) => setReturns(e.target.value)} />
            </div>
          </>
        )}
        {kind === 'trigger' && (
          <>
            <label className="form-label" htmlFor="dz-w-table">
              Table
            </label>
            <div className="form-control">
              <input id="dz-w-table" className="input mono" list="dz-w-tables" value={table} onChange={(e) => setTable(e.target.value)} />
              <datalist id="dz-w-tables">
                {tables.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <span className="form-label">Fires</span>
            <div className="form-control" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="input" style={{ width: 'auto' }} aria-label="Timing" value={timing} onChange={(e) => setTiming(e.target.value as typeof timing)}>
                {(req.dialect === 'tsql' ? ['AFTER', 'INSTEAD OF'] : ['BEFORE', 'AFTER', 'INSTEAD OF']).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              {(['INSERT', 'UPDATE', 'DELETE'] as const).map((ev) => (
                <label key={ev} className="check">
                  <input
                    type={req.dialect === 'sqlite' ? 'radio' : 'checkbox'}
                    name="dz-w-event"
                    checked={events.includes(ev)}
                    onChange={(e) => setEvents(req.dialect === 'sqlite' ? [ev] : e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
                  />
                  {ev}
                </label>
              ))}
            </div>
          </>
        )}
        {isRoutine && (
          <>
            <span className="form-label">Parameters</span>
            <div className="form-control">
              {params.length > 0 && (
                <table className="dz-params">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Direction</th>
                      <th>Default</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {params.map((p, i) => (
                      <tr key={i}>
                        <td>
                          <input className="input mono" aria-label={`Parameter ${i + 1} name`} value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} />
                        </td>
                        <td>
                          <input className="input mono" aria-label={`Parameter ${i + 1} type`} value={p.type} onChange={(e) => setParam(i, { type: e.target.value })} />
                        </td>
                        <td>
                          <select className="input" aria-label={`Parameter ${i + 1} direction`} value={p.direction} onChange={(e) => setParam(i, { direction: e.target.value as ParamDirection })}>
                            <option value="in">IN</option>
                            <option value="out">OUT</option>
                            <option value="inout">IN OUT</option>
                          </select>
                        </td>
                        <td>
                          <input className="input mono" aria-label={`Parameter ${i + 1} default`} value={p.default} disabled={p.direction !== 'in'} onChange={(e) => setParam(i, { default: e.target.value })} />
                        </td>
                        <td>
                          <button type="button" className="icon-btn" aria-label={`Remove parameter ${i + 1}`} onClick={() => setParams((ps) => ps.filter((_, k) => k !== i))}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button
                type="button"
                className="btn btn-xs"
                onClick={() =>
                  setParams((ps) => [
                    ...ps,
                    { name: req.dialect === 'tsql' ? `@Param${ps.length + 1}` : `p_param${ps.length + 1}`, type: DEFAULT_PARAM_TYPE[req.dialect], direction: 'in', default: '' },
                  ])
                }
              >
                <Plus size={12} /> Parameter
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Oracle DDL of a package (spec, optionally followed by the body) → [spec, body | null]. */
export function splitPackage(ddl: string): [string, string | null] {
  const m = /\n\s*\/?\s*\n?\s*CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?PACKAGE\s+BODY\b/i.exec(ddl);
  if (!m) return [ddl.trim().replace(/\n\/\s*$/, ''), null];
  return [ddl.slice(0, m.index).trim().replace(/\n?\/\s*$/, ''), ddl.slice(m.index).trim().replace(/\n?\/\s*$/, '')];
}

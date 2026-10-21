// "New procedure…" wizard (docs/PLAN-M1.5.md 1.3.3): schema, name, parameters, return type, Oracle package member.
// Create opens a new console with the dialect template inserted as a Monaco snippet (Tab through the placeholders).
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { catalogDatabase, newConsole } from '../../app/actions';
import { Dialog } from '../../components/common/Dialog';
import { Select } from '../../components/common/Select';
import { useCatalog } from '../../store/catalog';
import { dbKey } from '../../store/catalog';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { useDesignerUi, type WizardRequest } from '../store';
import { insertSnippetInTab } from '../snippet';
import {
  DEFAULT_PARAM_TYPE, DEFAULT_RETURN_TYPE, defaultName, defaultTiming, kindsFor, routineSnippet, triggerTimings, type ParamDirection, type RoutineKind,
  type TriggerTiming, type WizardParam, type WizardSpec,
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
  const [timing, setTiming] = useState<TriggerTiming>(defaultTiming(req.dialect, false));
  const [events, setEvents] = useState<('INSERT' | 'UPDATE' | 'DELETE')[]>(['INSERT']);
  /** PostgreSQL: row-level (default) or statement-level trigger. */
  const [eachRow, setEachRow] = useState(true);
  const [pkgMember, setPkgMember] = useState(!!req.packageName);
  const [pkgName, setPkgName] = useState(req.packageName ?? '');
  const [busy, setBusy] = useState(false);

  const db = useCatalog((s) => s.dbs[dbKey(req.connectionId, catalogDatabase(req.connectionId, req.database))]);
  const schemas = db?.snapshot?.schemas.map((s) => s.name) ?? (req.schema ? [req.schema] : []);
  const objects = useMemo(() => db?.snapshot?.schemas.find((s) => s.name === (schema || db?.defaultSchema))?.objects ?? [], [db, schema]);
  const tableNames = objects.filter((o) => o.t === 'table').map((o) => o.n);
  const viewNames = objects.filter((o) => o.t === 'view').map((o) => o.n);
  const onView = viewNames.includes(table) && !tableNames.includes(table);
  const timings = triggerTimings(req.dialect, onView);
  const nameRef = useRef<HTMLInputElement>(null);
  const packages = objects.filter((o) => o.t === 'package').map((o) => o.n);

  // Name first: the Dialog focuses its first field (the Schema select); this effect runs after the Dialog's.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // The catalog may arrive after the wizard opened: keep the timing valid for a view or a table.
  useEffect(() => {
    if (!timings.includes(timing)) setTiming(defaultTiming(req.dialect, onView));
  }, [onView]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Picking a view switches to INSTEAD OF (the only timing a view takes); back on a table the default returns. */
  const chooseTable = (t: string) => {
    setTable(t);
    const view = viewNames.includes(t) && !tableNames.includes(t);
    if (!triggerTimings(req.dialect, view).includes(timing)) setTiming(defaultTiming(req.dialect, view));
  };

  const memberMode = req.dialect === 'plsql' && pkgMember && (kind === 'procedure' || kind === 'function');
  const isRoutine = kind === 'procedure' || kind === 'function' || kind === 'package';

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const spec: WizardSpec = {
        dialect: req.dialect, kind, schema: schema || null, name: name.trim() || defaultName(kind, req.dialect), params, returns,
        trigger: kind === 'trigger' ? { table: table || 'table_name', timing, events: events.length ? events : ['INSERT'], forEachRow: req.dialect === 'pgsql' ? eachRow || onView : req.dialect !== 'tsql' } : undefined,
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
      useTabs.getState().rename(id, `New: ${memberMode ? pkgName : spec.name}`);
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
              <Select
                id="dz-w-schema"
                value={schema}
                options={(schemas.length ? schemas : [schema]).map((s) => ({ value: s, label: s || '(default)' }))}
                onChange={(v) => setSchema(v)}
              />
            </div>
          </>
        )}
        <label className="form-label" htmlFor="dz-w-name">
          Name
        </label>
        <div className="form-control">
          <input ref={nameRef} id="dz-w-name" className="input mono" data-autofocus value={name} placeholder={defaultName(kind, req.dialect)} onChange={(e) => setName(e.target.value)} />
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
                <Select
                  style={{ width: 'auto', minWidth: 180 }}
                  mono
                  aria-label="Package"
                  value={pkgName}
                  options={[{ value: '', label: '(choose)' }, ...packages.map((p) => ({ value: p, label: p }))]}
                  onChange={(v) => setPkgName(v)}
                />
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
              {tableNames.length + viewNames.length > 0 ? (
                <Select
                  id="dz-w-table"
                  mono
                  value={table}
                  options={[
                    { value: '', label: '(choose a table)' },
                    ...(table && !tableNames.includes(table) && !viewNames.includes(table) ? [{ value: table, label: table }] : []),
                    ...tableNames.map((t) => ({ value: t, label: t, group: 'Tables' })),
                    ...viewNames.map((t) => ({ value: t, label: t, group: 'Views (INSTEAD OF)' })),
                  ]}
                  onChange={chooseTable}
                />
              ) : (
                <input id="dz-w-table" className="input mono" value={table} placeholder="table_name" onChange={(e) => chooseTable(e.target.value)} />
              )}
            </div>
            <span className="form-label">Fires</span>
            <div className="form-control" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select<typeof timing>
                style={{ width: 'auto', minWidth: 120 }}
                aria-label="Timing"
                value={timing}
                options={timings.map((t) => ({ value: t, label: t }))}
                onChange={setTiming}
              />
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
              {req.dialect === 'pgsql' && (
                <label className="check" title={onView ? 'INSTEAD OF triggers are always row-level' : 'Off: FOR EACH STATEMENT'}>
                  <input type="checkbox" checked={eachRow || onView} disabled={onView} onChange={(e) => setEachRow(e.target.checked)} />
                  FOR EACH ROW
                </label>
              )}
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
                          <Select<ParamDirection>
                            aria-label={`Parameter ${i + 1} direction`}
                            value={p.direction}
                            options={[{ value: 'in', label: 'IN' }, { value: 'out', label: 'OUT' }, { value: 'inout', label: 'IN OUT' }]}
                            onChange={(direction) => setParam(i, { direction })}
                          />
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

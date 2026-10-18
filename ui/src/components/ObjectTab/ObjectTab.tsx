import { Code2, Copy, KeyRound, LoaderCircle, PencilRuler, Play, RefreshCw, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { DdlResponse, ObjectDetails } from '../../api/types';
import { copyText, newConsole, selectTop } from '../../app/actions';
import { runCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import type { ObjectTarget } from '../../commands/types';
import { FormattedToggle } from '../../editor/FormattedDdl';
import { useFormattedDdl } from '../../editor/formatted-ddl';
import { SqlEditor } from '../../editor/SqlEditor';
import { formatCount } from '../../lib/format';
import { isTabular, OBJECT_TYPE_SINGULAR, qualifiedName } from '../../lib/sql';
import { useConnection, useDialect } from '../../store/connections';
import { useSettings } from '../../store/settings';
import type { ObjectTab as ObjectTabT } from '../../store/tabs';
import type { EffectiveTheme } from '../../theme/useTheme';
import { ObjectIcon } from '../common/icons';

type Section = 'ddl' | 'columns' | 'indexes' | 'fks' | 'refs' | 'params';

const noop = () => {};

/** Types with a designer (tables, views) or an editable script (F4). */
const DESIGNABLE = new Set(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'trigger', 'type']);
const CODEGEN_TYPES = new Set(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package']);

/** Read-only object view: DDL (Monaco via WP-D's SqlEditor) plus columns/indexes/FKs from /catalog/object. */
export function ObjectTabView({ tab, theme, visible }: { tab: ObjectTabT; theme: EffectiveTheme; visible: boolean }) {
  const conn = useConnection(tab.connectionId);
  const dialect = useDialect(tab.connectionId);
  const editorSettings = useSettings((s) => s.settings.editor);
  const [ddl, setDdl] = useState<DdlResponse | null>(null);
  const [details, setDetails] = useState<ObjectDetails | null>(null);
  const [error, setError] = useState<{ ddl?: string; details?: string }>({});
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>(tab.column ? 'columns' : 'ddl');
  const { ref } = tab;

  const load = useCallback(async () => {
    setLoading(true);
    setError({});
    const [d, o] = await Promise.allSettled([api.ddl(tab.connectionId, tab.database, ref), api.objectDetails(tab.connectionId, tab.database, ref)]);
    if (d.status === 'fulfilled') setDdl(d.value);
    else setDdl(null);
    if (o.status === 'fulfilled') setDetails(o.value);
    else setDetails(null);
    setError({
      ddl: d.status === 'rejected' ? errorMessage(d.reason) : undefined,
      details: o.status === 'rejected' ? errorMessage(o.reason) : undefined,
    });
    setLoading(false);
  }, [tab.connectionId, tab.database, ref]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab.column) setSection('columns');
  }, [tab.column]);

  const qualified = qualifiedName(ref, dialect, { always: true });
  // Non-destructive formatted view of the DDL (WP-H); "DDL in console" and Copy keep the stored text.
  const formatted = useFormattedDdl(ddl?.ddl ?? null, dialect);
  const target: ObjectTarget = { kind: 'object', connectionId: tab.connectionId, database: tab.database, ref };
  const designable = DESIGNABLE.has(ref.type);
  const codegenable = CODEGEN_TYPES.has(ref.type);
  const sections: { id: Section; label: string; count?: number; show: boolean }[] = [
    { id: 'ddl', label: 'DDL', show: true },
    { id: 'columns', label: 'Columns', count: details?.columns.length, show: !!details?.columns.length },
    { id: 'indexes', label: 'Indexes', count: details?.indexes.length, show: !!details?.indexes.length },
    { id: 'fks', label: 'Foreign keys', count: details?.foreignKeys.length, show: !!details?.foreignKeys.length },
    { id: 'refs', label: 'Referenced by', count: details?.referencedBy.length, show: !!details?.referencedBy.length },
    { id: 'params', label: 'Parameters', count: details?.parameters.length, show: !!details?.parameters.length },
  ];

  return (
    <div className="object-tab" style={{ display: visible ? undefined : 'none' }}>
      <div className="object-header">
        <ObjectIcon type={ref.type} size={18} />
        <div className="object-title">
          <div className="object-name">{qualified}</div>
          <div className="object-sub">
            {OBJECT_TYPE_SINGULAR[ref.type]} · {conn?.name ?? 'unknown connection'}
            {tab.database ? ` · ${tab.database}` : ''}
            {details?.rowCountEstimate != null && ` · ~${formatCount(details.rowCountEstimate)} rows`}
            {details?.modified && ` · modified ${new Date(details.modified).toLocaleString()}`}
          </div>
        </div>
        <div className="flex-1" />
        {isTabular(ref.type) && (
          <button className="btn btn-xs" onClick={() => selectTop(tab.connectionId, tab.database, ref, 1000)}>
            <Play size={12} /> Select top 1000
          </button>
        )}
        {designable && (
          <button className="btn btn-xs" onClick={() => runCommand('designer.edit', target)} title={ref.type === 'table' ? 'Open the table designer (F4)' : 'Edit the definition (F4)'}>
            <PencilRuler size={12} /> {ref.type === 'table' ? 'Design' : 'Edit'}
          </button>
        )}
        {codegenable && (
          <button className="btn btn-xs" onClick={() => runCommand('codegen.open', target)} title={commandView('codegen.open', target, 'Generate C#, Go, TypeScript, Java or Python code').tooltip}>
            <Code2 size={12} /> Generate code
          </button>
        )}
        <button className="btn btn-xs" onClick={() => newConsole(tab.connectionId, tab.database, ddl?.ddl ?? '')} disabled={!ddl} title="Open the DDL as it is stored in a new console">
          <SquareTerminal size={12} /> DDL in console
        </button>
        <button className="icon-btn" title="Copy DDL" onClick={() => ddl && void copyText(ddl.ddl, 'DDL copied')} disabled={!ddl}>
          <Copy size={14} />
        </button>
        <button className="icon-btn" title="Reload" onClick={() => void load()}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      <div className="object-sections" role="tablist">
        {sections
          .filter((s) => s.show)
          .map((s) => (
            <button key={s.id} role="tab" aria-selected={section === s.id} className={`results-tab${section === s.id ? ' active' : ''}`} onClick={() => setSection(s.id)}>
              {s.label}
              {s.count !== undefined && <span className="results-tab-count">{s.count}</span>}
            </button>
          ))}
        {ddl && section === 'ddl' && <span className="muted object-ddl-source">{ddl.source === 'generated' ? 'generated from catalog' : 'stored definition'}</span>}
        {ddl && section === 'ddl' && <FormattedToggle {...formatted.toggle} />}
      </div>
      <div className="object-body">
        {section === 'ddl' ? (
          error.ddl ? (
            <div className="object-error">Could not load DDL: {error.ddl}</div>
          ) : ddl ? (
            <SqlEditor
              tabId={`${tab.id}-ddl`}
              dialect={dialect}
              catalog={null}
              value={formatted.text}
              onChange={noop}
              onRun={noop}
              readOnly
              theme={theme}
              settings={editorSettings}
            />
          ) : (
            <div className="object-loading">
              <LoaderCircle size={16} className="spin" />
            </div>
          )
        ) : details ? (
          <DetailsTable section={section} details={details} highlight={tab.column ?? null} />
        ) : (
          <div className="object-error">{error.details ?? 'Loading…'}</div>
        )}
      </div>
    </div>
  );
}

function DetailsTable({ section, details, highlight }: { section: Section; details: ObjectDetails; highlight: string | null }) {
  if (section === 'columns') {
    return (
      <table className="details-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            <th>Attributes</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {details.columns.map((c) => (
            <tr key={c.name} className={highlight && c.name.toLowerCase() === highlight.toLowerCase() ? 'highlight' : ''}>
              <td className="muted">{c.ordinal}</td>
              <td className="mono">
                {c.isPk && <KeyRound size={11} className="obj-pk" />} {c.name}
              </td>
              <td className="mono">{c.type}</td>
              <td>{c.nullable ? 'yes' : <strong>NOT NULL</strong>}</td>
              <td className="mono muted">{c.default ?? ''}</td>
              <td>
                {c.isPk && <span className="pill">PK</span>}
                {c.isIdentity && <span className="pill">identity</span>}
                {c.isComputed && <span className="pill">computed</span>}
              </td>
              <td className="muted">{c.comment ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (section === 'indexes') {
    return (
      <table className="details-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Columns</th>
            <th>Unique</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {details.indexes.map((i) => (
            <tr key={i.name}>
              <td className="mono">
                {i.isPrimaryKey && <KeyRound size={11} className="obj-pk" />} {i.name}
              </td>
              <td className="mono">{i.columns.join(', ')}</td>
              <td>{i.unique ? 'yes' : ''}</td>
              <td className="muted">{i.type ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (section === 'fks') {
    return (
      <table className="details-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Columns</th>
            <th>References</th>
          </tr>
        </thead>
        <tbody>
          {details.foreignKeys.map((f) => (
            <tr key={f.name}>
              <td className="mono">{f.name}</td>
              <td className="mono">{f.columns.join(', ')}</td>
              <td className="mono">
                {f.refSchema ? `${f.refSchema}.` : ''}
                {f.refTable} ({f.refColumns.join(', ')})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (section === 'refs') {
    return (
      <table className="details-table">
        <thead>
          <tr>
            <th>Table</th>
            <th>Constraint</th>
            <th>Columns</th>
          </tr>
        </thead>
        <tbody>
          {details.referencedBy.map((r) => (
            <tr key={`${r.schema}.${r.table}.${r.constraint}`}>
              <td className="mono">
                {r.schema ? `${r.schema}.` : ''}
                {r.table}
              </td>
              <td className="mono">{r.constraint}</td>
              <td className="mono">{r.columns.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="details-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Direction</th>
          <th>Default</th>
        </tr>
      </thead>
      <tbody>
        {details.parameters.map((p, i) => (
          <tr key={`${p.name}${i}`}>
            <td className="mono">{p.name || <span className="muted">(return)</span>}</td>
            <td className="mono">{p.typeText}</td>
            <td>{p.direction}</td>
            <td>{p.hasDefault ? 'yes' : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

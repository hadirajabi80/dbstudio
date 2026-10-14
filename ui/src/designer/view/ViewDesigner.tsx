// View designer tab (docs/PLAN-M1.5.md 1.3.2): name/schema/options strip over a SqlEditor holding only the SELECT,
// a live column preview (POST /sessions/{sid}/describe, debounced 600 ms) and the generated DDL
// (CREATE OR ALTER / CREATE OR REPLACE / DROP+CREATE) which Apply runs.
import { Code2, Eye, FileCode2, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, isApiError } from '../../api/client';
import type { ColumnInfo, DdlFailedDetail, DdlScript, ViewModel, ViewOptions } from '../../api/types';
import { catalogDatabase, effectiveDatabase } from '../../app/actions';
import { runCommand } from '../../commands/registry';
import type { TabViewProps } from '../../components/layout/tabViews';
import { SqlEditor } from '../../editor/SqlEditor';
import { useCatalog, useSnapshot } from '../../store/catalog';
import { useConnection, useDialect } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import { registerDesignerActions } from '../actions';
import { applySummary, scriptToText, splitForApply } from '../ddl';
import { DdlPreview, type ApplyFailure } from '../DdlPreview';
import { openEditScript, viewTitle, type ViewDesignerState } from '../open';
import '../designer.css';

const NO_OPTIONS: ViewOptions = { schemaBinding: false, checkOption: false, force: false };

export function ViewDesignerView({ tab, theme, visible }: TabViewProps) {
  const st = tab.state as ViewDesignerState;
  const cid = st.connectionId;
  const conn = useConnection(cid);
  const dialect = useDialect(cid);
  const catalogDb = catalogDatabase(cid, st.database);
  const snapshot = useSnapshot(cid, catalogDb);
  const editorSettings = useSettings((s) => s.settings.editor);
  const askConfirm = useUi((s) => s.askConfirm);

  const [server, setServer] = useState<ViewModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!st.name || st.body !== undefined);
  const [name, setName] = useState(st.newName ?? st.name ?? '');
  const [schema, setSchema] = useState<string | null>(st.schema);
  const [body, setBody] = useState(st.body ?? (dialect === 'plsql' ? 'SELECT\n    \nFROM ' : 'SELECT\n    \nFROM '));
  const [options, setOptions] = useState<ViewOptions>(st.options ?? NO_OPTIONS);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [describeNotes, setDescribeNotes] = useState<string[]>([]);
  const [describing, setDescribing] = useState(false);
  const [script, setScript] = useState<DdlScript | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [generated, setGenerated] = useState('');
  const [text, setText] = useState('');
  const [handEdited, setHandEdited] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<ApplyFailure | null>(null);
  const lines = useRef<number[]>([]);
  const originalName = server?.name ?? st.name ?? null;

  const load = useCallback(async () => {
    if (!st.name) return;
    setLoadError(null);
    try {
      const v = await api.designerView(cid, st.database, st.schema, st.name);
      setServer(v);
      setBody(v.body);
      setOptions(v.options ?? NO_OPTIONS);
      setName(v.name);
      setSchema(v.schema);
      setLoaded(true);
    } catch (e) {
      setLoadError(errorMessage(e));
      setLoaded(true);
    }
  }, [cid, st.database, st.schema, st.name]);

  useEffect(() => {
    if (st.name) void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = loaded && (server ? body !== server.body || name !== server.name || JSON.stringify(options) !== JSON.stringify(server.options) : body.replace(/\s+/g, ' ').trim() !== 'SELECT FROM' && body.trim() !== '');

  useEffect(() => {
    const t = setTimeout(() => {
      useTabs.getState().updateView(tab.id, { dirty: dirty || handEdited, state: { ...st, body, newName: name, options, schema } satisfies ViewDesignerState });
    }, 300);
    return () => clearTimeout(t);
  }, [body, name, options, schema, dirty, handEdited]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- describe (live columns) ----------
  const describe = useCallback(
    async (sql: string, signal?: AbortSignal) => {
      if (!sql.trim() || /^\s*select\s+from\s*$/i.test(sql)) {
        setColumns(null);
        setDescribeError(null);
        return;
      }
      setDescribing(true);
      try {
        const s = await useSessions.getState().ensure(tab.id, cid, effectiveDatabase(cid, st.database), 'auto');
        const r = await api.describe(s.sessionId, { sql }, signal);
        setColumns(r.columns);
        setDescribeError(null);
        setDescribeNotes(r.warnings);
      } catch (e) {
        if (isApiError(e, 'ABORTED')) return;
        setColumns(null);
        setDescribeError(errorMessage(e));
      } finally {
        if (!signal?.aborted) setDescribing(false);
      }
    },
    [cid, st.database, tab.id],
  );

  useEffect(() => {
    if (!loaded) return;
    const ac = new AbortController();
    const t = setTimeout(() => void describe(body, ac.signal), 600);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [body, loaded, describe]);

  // ---------- DDL script ----------
  useEffect(() => {
    if (!loaded || handEdited) return;
    if (!name.trim() || !body.trim()) {
      setScript(null);
      setGenerated('');
      setText(!name.trim() ? '-- Name the view to see its DDL\n' : '');
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setScriptLoading(true);
      try {
        const s = await api.scriptView(cid, { database: st.database, schema, name: name.trim(), originalName, body, options }, ac.signal);
        const p = scriptToText(s.statements, dialect);
        lines.current = p.lines;
        setScript(s);
        setScriptError(null);
        setGenerated(p.text);
        setText(p.text);
      } catch (e) {
        if (isApiError(e, 'ABORTED')) return;
        setScriptError(errorMessage(e));
      } finally {
        if (!ac.signal.aborted) setScriptLoading(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [name, schema, body, options, originalName, handEdited, loaded, cid, st.database, dialect]);

  const apply = useCallback(async () => {
    if (applying) return;
    const statements = handEdited ? splitForApply(text, dialect) : (script?.statements ?? []).map((s, i) => ({ sql: s.sql, line: lines.current[i] ?? null }));
    if (!statements.length) {
      toast('info', 'Nothing to apply');
      return;
    }
    if (originalName && name.trim() && name.trim() !== originalName) {
      const ok = await askConfirm({ title: 'Rename the view?', message: `“${originalName}” becomes “${name.trim()}”. Code that uses the old name stops working.`, confirmLabel: 'Apply', danger: true });
      if (!ok) return;
    }
    setApplying(true);
    setFailure(null);
    try {
      const r = await api.applyDdl(cid, { database: st.database, statements: statements.map((s) => s.sql), transactional: script?.transactional ?? dialect !== 'plsql', schema });
      const n = name.trim();
      toast('success', `${originalName ? 'Updated' : 'Created'} view ${n}`, `${r.executed} statement${r.executed === 1 ? '' : 's'} in ${r.elapsedMs} ms`);
      useTabs.getState().updateView(tab.id, {
        title: viewTitle(dialect, schema, n), dirty: false,
        state: { ...st, schema, name: n, body: undefined, newName: undefined, options: undefined } satisfies ViewDesignerState,
      });
      setHandEdited(false);
      try {
        const v = await api.designerView(cid, st.database, schema, n);
        setServer(v);
        setBody(v.body);
        setOptions(v.options ?? NO_OPTIONS);
      } catch {
        setServer({ schema, name: n, body, options, ddl: '' });
      }
      if (schema) void useCatalog.getState().loadSchema(cid, catalogDb, schema, true);
    } catch (e) {
      const detail = isApiError(e, 'DDL_FAILED') ? (e.detail as DdlFailedDetail) : null;
      setFailure({
        message: detail?.providerError?.message ?? errorMessage(e),
        detail,
        line: detail ? statements[detail.failedIndex]?.line ?? null : null,
        executed: detail && !detail.rolledBack ? statements.slice(0, detail.executed).map((s) => s.sql) : [],
      });
      toast('error', 'Apply failed', detail?.providerError?.message ?? errorMessage(e));
    } finally {
      setApplying(false);
    }
  }, [applying, handEdited, text, dialect, script, originalName, name, cid, st, schema, tab.id, body, options, catalogDb, askConfirm]);

  useEffect(() => registerDesignerActions(tab.id, { apply: () => void apply() }), [tab.id, apply]);

  const schemas = snapshot?.schemas.map((s) => s.name) ?? (schema ? [schema] : []);
  const locked = handEdited || applying;

  return (
    <div className="dz" style={{ display: visible ? undefined : 'none' }} data-command-scope="designer" aria-label={tab.title}>
      <div className="dz-header">
        <div className="dz-title">
          <Eye size={16} aria-hidden="true" />
          <span>{originalName ? 'Edit view' : 'New view'}</span>
          <span className="dz-sub">
            {conn?.name ?? ''}
            {st.database ? ` · ${st.database}` : ''}
          </span>
        </div>
        <label className="dz-field">
          Name
          <input className="input mono" style={{ width: 200 }} value={name} disabled={locked} autoFocus={!originalName} placeholder={dialect === 'plsql' ? 'V_NAME' : 'vName'} onChange={(e) => setName(e.target.value)} />
        </label>
        {dialect !== 'sqlite' && (
          <label className="dz-field">
            Schema
            <select className="input" value={schema ?? ''} disabled={locked || !!originalName} onChange={(e) => setSchema(e.target.value || null)}>
              {(schemas.length ? schemas : ['']).map((s) => (
                <option key={s} value={s}>
                  {s || '(default)'}
                </option>
              ))}
            </select>
          </label>
        )}
        {dialect === 'tsql' && (
          <label className="check sm" title="Binds the view to the schema of the tables it uses">
            <input type="checkbox" checked={options.schemaBinding} disabled={locked} onChange={(e) => setOptions({ ...options, schemaBinding: e.target.checked })} />
            WITH SCHEMABINDING
          </label>
        )}
        {dialect !== 'sqlite' && (
          <label className="check sm" title="Rejects updates through the view that it would not show">
            <input type="checkbox" checked={options.checkOption} disabled={locked} onChange={(e) => setOptions({ ...options, checkOption: e.target.checked })} />
            WITH CHECK OPTION
          </label>
        )}
        {dialect === 'plsql' && (
          <label className="check sm" title="Create the view even if referenced objects are missing">
            <input type="checkbox" checked={options.force} disabled={locked} onChange={(e) => setOptions({ ...options, force: e.target.checked })} />
            FORCE
          </label>
        )}
        <span className="dz-spacer" />
        {originalName && (
          <>
            <button type="button" className="btn btn-xs" title="Open the full DDL as an editable script" onClick={() => void openEditScript(cid, st.database, { database: st.database, schema, name: originalName, type: 'view' })}>
              <FileCode2 size={12} /> Edit as SQL
            </button>
            <button
              type="button"
              className="btn btn-xs"
              title="Generate code for this view"
              onClick={() => runCommand('codegen.open', { kind: 'object', connectionId: cid, database: st.database, ref: { database: st.database, schema, name: originalName, type: 'view' } })}
            >
              <Code2 size={12} /> Code
            </button>
          </>
        )}
        <button type="button" className="btn btn-primary btn-xs" disabled={applying || (!handEdited && !script?.statements.length)} onClick={() => void apply()} title="Apply the DDL (Ctrl+S)">
          {applying ? <LoaderCircle size={12} className="spin" /> : <Play size={12} />} Apply
        </button>
      </div>
      {loadError && (
        <div className="dz-banner error" role="alert">
          <span>Could not load the view: {loadError}</span>
          <button type="button" className="btn btn-xs" onClick={() => void load()}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}
      {!loaded ? (
        <div className="dz-empty">
          <LoaderCircle size={16} className="spin" aria-label="Loading view" />
        </div>
      ) : (
        <div className="dz-body">
          <div className="dz-split" style={{ flex: '1 1 55%' }}>
            <div className={`dz-split-main${locked ? ' dz-locked' : ''}`}>
              <div className="dz-preview-bar">
                <strong>SELECT</strong>
                <span>The query the view returns (IntelliSense knows this connection’s tables). Ctrl+Enter refreshes the columns.</span>
              </div>
              <div className="dz-editor-host">
                <SqlEditor
                  tabId={`${tab.id}-body`}
                  dialect={dialect}
                  catalog={snapshot}
                  value={body}
                  onChange={setBody}
                  onRun={() => void describe(body)}
                  readOnly={locked}
                  theme={theme}
                  settings={editorSettings}
                  requestSchema={(s) => void useCatalog.getState().loadSchema(cid, catalogDb, s)}
                />
              </div>
            </div>
            <aside className="dz-side" aria-label="Columns of the view">
              <div className="dz-side-title">
                Columns {columns && <span className="results-tab-count">{columns.length}</span>}
                {describing && <LoaderCircle size={12} className="spin" aria-label="Describing" />}
              </div>
              <div className="dz-side-body">
                {describeError && <div className="dz-describe-error">{describeError}</div>}
                {!describeError &&
                  describeNotes.map((n) => (
                    <div key={n} className="dz-describe-note">
                      {n}
                    </div>
                  ))}
                {columns ? (
                  <table className="details-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Null</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((c) => (
                        <tr key={`${c.ordinal}:${c.name}`}>
                          <td className="mono">{c.name || <span className="muted">(no name)</span>}</td>
                          <td className="mono muted">{c.dbType}</td>
                          <td>{c.nullable ? 'yes' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  !describeError && <div className="dz-empty">Write the SELECT to see the columns it returns.</div>
                )}
              </div>
            </aside>
          </div>
          <DdlPreview
            tabId={tab.id}
            dialect={dialect}
            theme={theme}
            text={text}
            handEdited={handEdited}
            loading={scriptLoading}
            summary={handEdited ? `${splitForApply(text, dialect).length} statement(s) (edited)` : script ? applySummary(script, dialect) : ''}
            warnings={handEdited ? [] : [...(script?.warnings ?? []), ...(script?.statements.map((s) => s.warning).filter((w): w is string => !!w) ?? [])]}
            error={scriptError}
            failure={failure}
            onChange={(t) => {
              if (t === text) return;
              setText(t);
              if (t !== generated && generated) setHandEdited(true);
            }}
            onRegenerate={() => {
              setHandEdited(false);
              setText(generated);
              setFailure(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

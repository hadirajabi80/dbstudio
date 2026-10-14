// "Generate code" tab (docs/PLAN-M1.5.md 1.4): language / flavor / naming options over a read-only preview of the
// generated files. Everything is generated in the renderer from the catalog (instant, no network) except the
// optional describe of a query and "Run to infer result columns" for procedures.
import { Code2, Copy, Download, ExternalLink, FlaskConical, LoaderCircle, MousePointerClick } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ColumnInfo, Dialect } from '../../api/types';
import { catalogDatabase, copyText, effectiveDatabase } from '../../app/actions';
import {
  detectQueryParams, findCatalogObject, flavorsFor, fromCatalogObject, fromColumnInfos, generate, LANGUAGES, languageInfo, normalizeOptions,
  queryObject, withLanguage, type CgObject, type CgRoutine, type CodegenOptions, type QueryParamType,
} from '../../codegen';
import { routineSqlName } from '../../codegen/shape';
import { objectTargetOf } from '../../commands/core';
import { quoteIdent } from '../../lib/sql';
import { getPlatform } from '../../platform';
import { useCatalog, useSnapshot } from '../../store/catalog';
import { useConnection, useDialect } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution, isRunning } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { CodeView } from './CodeView';
import { openGeneratedFile, type CodegenFileState, type CodegenTabState, type CodegenTarget } from './open';
import './codegen.css';

const PARAM_TYPES: QueryParamType[] = ['string', 'int', 'long', 'decimal', 'float', 'bool', 'date', 'datetime', 'datetimeoffset', 'time', 'guid', 'binary'];

export function useCodegenOptions(): [CodegenOptions, (o: CodegenOptions) => void] {
  const stored = useSettings((s) => (s.settings.ui?.codegen as Partial<CodegenOptions> | undefined) ?? null);
  const opts = useMemo(() => normalizeOptions(stored), [stored]);
  return [opts, (o) => useSettings.getState().update({ ui: { codegen: o } })];
}

export function CodegenTabView({ tab, theme, visible }: TabViewProps) {
  const st = tab.state as CodegenTabState;
  const cid = st.connectionId;
  const conn = useConnection(cid);
  const dialect = useDialect(cid);
  const catalogDb = cid ? catalogDatabase(cid, st.database) : null;
  const snapshot = useSnapshot(cid, catalogDb);
  const [opts, setOpts] = useCodegenOptions();
  const [fileIdx, setFileIdx] = useState(0);
  const [described, setDescribed] = useState<Record<number, ColumnInfo[] | string>>({});
  const [inferring, setInferring] = useState<string | null>(null);

  const updateState = (p: Partial<CodegenTabState>) => useTabs.getState().updateView(tab.id, { state: { ...st, ...p } });

  // Make sure the schemas of the targets are loaded.
  useEffect(() => {
    if (!cid) return;
    const schemas = new Set(st.targets.filter((t) => t.kind === 'object').map((t) => (t.kind === 'object' ? t.ref.schema : null)).filter((s): s is string => !!s));
    for (const s of schemas) void useCatalog.getState().loadSchema(cid, catalogDb, s);
  }, [cid, catalogDb, st.targets]);

  // Describe queries that arrived without columns.
  useEffect(() => {
    if (!cid) return;
    st.targets.forEach((t, i) => {
      if (t.kind !== 'query' || t.columns || described[i]) return;
      void (async () => {
        try {
          const s = await useSessions.getState().ensure(tab.id, cid, effectiveDatabase(cid, st.database), 'auto');
          const r = await api.describe(s.sessionId, { sql: t.sql });
          setDescribed((d) => ({ ...d, [i]: r.columns }));
        } catch (e) {
          setDescribed((d) => ({ ...d, [i]: errorMessage(e) }));
        }
      })();
    });
  }, [cid, st.targets]); // eslint-disable-line react-hooks/exhaustive-deps

  const { objects, missing, queryErrors } = useMemo(() => {
    const objects: CgObject[] = [];
    const missing: string[] = [];
    const queryErrors: string[] = [];
    st.targets.forEach((t, i) => {
      if (t.kind === 'object') {
        const o = findCatalogObject(snapshot, t.ref);
        const cg = o ? fromCatalogObject(o, t.ref.schema ?? snapshot?.defaultSchema ?? null) : null;
        if (!cg) {
          missing.push(t.ref.name);
          return;
        }
        if ((cg.kind === 'proc' || cg.kind === 'func') && st.inferred?.[routineKey(cg, dialect)]) cg.resultColumns = fromColumnInfos(st.inferred[routineKey(cg, dialect)]);
        objects.push(cg);
      } else {
        const cols = t.columns ?? (Array.isArray(described[i]) ? (described[i] as ColumnInfo[]) : null);
        if (typeof described[i] === 'string') queryErrors.push(`${t.name}: ${described[i]}`);
        objects.push(queryObject(t.name, t.sql, dialect, cols ? fromColumnInfos(cols) : [], t.paramTypes ?? {}));
      }
    });
    return { objects, missing, queryErrors };
  }, [st.targets, st.inferred, snapshot, described, dialect]);

  const files = useMemo(() => {
    try {
      return generate({ dialect, objects }, opts);
    } catch (e) {
      console.error('[codegen] generator failed', e);
      return [{ path: 'error.txt', language: 'plaintext', content: `Code generation failed: ${errorMessage(e)}` }];
    }
  }, [dialect, objects, opts]);
  const file = files[Math.min(fileIdx, Math.max(0, files.length - 1))] ?? null;
  const info = languageInfo(opts.language);
  const flavors = flavorsFor(opts.language, dialect);
  const queries = st.targets.map((t, i) => ({ t, i })).filter((x) => x.t.kind === 'query');
  const routines = objects.filter((o): o is CgRoutine => o.kind === 'proc' && dialect === 'tsql');

  const set = (p: Partial<CodegenOptions>) => setOpts({ ...opts, ...p });

  const infer = async (r: CgRoutine) => {
    if (!cid) return;
    const name = routineSqlName(r, dialect, quoteIdent);
    const args = r.params.filter((p) => p.direction !== 'return' && !p.hasDefault).map((p) => `${p.name} = NULL`);
    const sql = `EXEC ${name}${args.length ? ' ' + args.join(', ') : ''}`;
    const ok = await useUi.getState().askConfirm({
      title: 'Run the procedure to infer its result columns?',
      message: `DbStudio runs ${name} with NULL parameters inside a transaction and rolls it back afterwards, then reads the shape of its first result set.`,
      items: [sql],
      confirmLabel: 'Run and roll back',
    });
    if (!ok) return;
    setInferring(r.name);
    const tabId = `${tab.id}:infer`;
    try {
      const cols = await runForColumns(tabId, cid, st.database, sql);
      if (!cols) toast('info', `${name} returned no result set`);
      else {
        updateState({ inferred: { ...(st.inferred ?? {}), [routineKey(r, dialect)]: cols } });
        toast('success', `Inferred ${cols.length} result columns of ${name}`);
      }
    } catch (e) {
      toast('error', `Could not run ${name}`, errorMessage(e));
    } finally {
      setInferring(null);
    }
  };

  if (!visible) return null;
  const empty = !st.targets.length;

  return (
    <div className="cg" data-command-scope="codegen" aria-label={tab.title}>
      <div className="cg-header">
        <Code2 size={16} aria-hidden="true" />
        <strong>Generate code</strong>
        <span className="muted">
          {st.targets.length ? st.targets.map((t) => (t.kind === 'object' ? t.ref.name : t.name)).join(', ') : ''}
          {conn ? ` · ${conn.name}` : ''}
        </span>
      </div>
      <div className="cg-options" role="group" aria-label="Code generation options">
        <label className="cg-field">
          Language
          <select className="input sm" value={opts.language} onChange={(e) => setOpts(withLanguage(opts, e.target.value as CodegenOptions['language']))}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="cg-field">
          Flavor
          <select className="input sm" value={flavors.some((f) => f.id === opts.flavor) ? opts.flavor : flavors[0]?.id} onChange={(e) => set({ flavor: e.target.value })} title={flavors.find((f) => f.id === opts.flavor)?.description}>
            {flavors.map((f) => (
              <option key={f.id} value={f.id} title={f.description}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {info.naming.length > 1 && (
          <label className="cg-field">
            Naming
            <select className="input sm" value={opts.naming && info.naming.includes(opts.naming) ? opts.naming : info.naming[0]} onChange={(e) => set({ naming: e.target.value as CodegenOptions['naming'] })}>
              {info.naming.map((n) => (
                <option key={n} value={n}>
                  {({ pascal: 'PascalCase', camel: 'camelCase', snake: 'snake_case', asIs: 'As in database' } as const)[n]}
                </option>
              ))}
            </select>
          </label>
        )}
        {info.namespaceLabel && (
          <label className="cg-field">
            {info.namespaceLabel}
            <input className="input sm mono" style={{ width: 170 }} value={opts.namespace} placeholder={info.namespacePlaceholder} onChange={(e) => set({ namespace: e.target.value })} />
          </label>
        )}
        <Check label="One file" checked={opts.combined} onChange={(v) => set({ combined: v })} title="One file for everything, or one file per object" />
        <Check label="Singular type names" checked={opts.singularize} onChange={(v) => set({ singularize: v })} title="Customers → Customer" />
        {opts.singularize && (
          <input className="input sm" style={{ width: 150 }} aria-label="Singularisation exceptions" placeholder="Exceptions: Status, Data=Datum" value={opts.singularExceptions} onChange={(e) => set({ singularExceptions: e.target.value })} />
        )}
      </div>
      <div className="cg-options" role="group" aria-label={`${info.label} options`}>
        {opts.language === 'csharp' && (
          <>
            <Check label="Nullable reference types" checked={opts.nullableReferenceTypes} onChange={(v) => set({ nullableReferenceTypes: v })} />
            {opts.flavor !== 'efcore' && <Check label="Data annotations" checked={opts.dataAnnotations} onChange={(v) => set({ dataAnnotations: v })} />}
            <Check label="Records" checked={opts.records} onChange={(v) => set({ records: v })} title="record types with init-only properties" />
            <Check label="required members" checked={opts.requiredMembers} onChange={(v) => set({ requiredMembers: v })} title="required instead of = &quot;&quot; for non-null strings" />
            <Check label="DateOnly / TimeOnly" checked={opts.dateOnly} onChange={(v) => set({ dateOnly: v })} />
          </>
        )}
        {opts.language === 'go' && (
          <>
            <label className="cg-field">
              NULL as
              <select className="input sm" value={opts.goNullable} onChange={(e) => set({ goNullable: e.target.value as CodegenOptions['goNullable'] })}>
                <option value="pointer">*T pointers</option>
                <option value="sqlNull">sql.NullT</option>
              </select>
            </label>
            <label className="cg-field">
              Decimals as
              <select className="input sm" value={opts.goDecimal} onChange={(e) => set({ goDecimal: e.target.value as CodegenOptions['goDecimal'] })}>
                <option value="float64">float64</option>
                <option value="string">string</option>
              </select>
            </label>
            <Check label="json tags" checked={opts.goJsonTags} onChange={(v) => set({ goJsonTags: v })} />
          </>
        )}
        {opts.language === 'typescript' && (
          <>
            <label className="cg-field">
              NULL as
              <select className="input sm" value={opts.tsNullable} onChange={(e) => set({ tsNullable: e.target.value as CodegenOptions['tsNullable'] })}>
                <option value="union">T | null</option>
                <option value="optional">optional (?)</option>
              </select>
            </label>
            <label className="cg-field">
              Dates as
              <select className="input sm" value={opts.tsDate} onChange={(e) => set({ tsDate: e.target.value as CodegenOptions['tsDate'] })}>
                <option value="string">string (ISO)</option>
                <option value="Date">Date</option>
              </select>
            </label>
            <label className="cg-field">
              Decimals as
              <select className="input sm" value={opts.tsDecimal} onChange={(e) => set({ tsDecimal: e.target.value as CodegenOptions['tsDecimal'] })}>
                <option value="number">number</option>
                <option value="string">string</option>
              </select>
            </label>
            <label className="cg-field">
              BIGINT as
              <select className="input sm" value={opts.tsBigint} onChange={(e) => set({ tsBigint: e.target.value as CodegenOptions['tsBigint'] })}>
                <option value="number">number</option>
                <option value="string">string</option>
                <option value="bigint">bigint</option>
              </select>
            </label>
          </>
        )}
        {opts.language === 'java' && opts.flavor === 'jdbc' && <Check label="Records" checked={opts.javaRecords} onChange={(v) => set({ javaRecords: v })} title="Java 16+ records instead of classes with getters/setters" />}
        {opts.language === 'python' && <Check label="X | None (3.10+)" checked={opts.pyUnionSyntax} onChange={(v) => set({ pyUnionSyntax: v })} title="Off: Optional[X]" />}
        {dialect === 'plsql' && <Check label="NUMBER(1) as boolean" checked={opts.numberOneAsBool} onChange={(v) => set({ numberOneAsBool: v })} />}
        {['csharp', 'go', 'typescript', 'java', 'python'].includes(opts.language) && (
          <span className="cg-field" role="group" aria-label="Include">
            Include
            <Check label="Model" checked={opts.include.model} onChange={(v) => set({ include: { ...opts.include, model: v } })} />
            <Check label="Data access" checked={opts.include.repository} onChange={(v) => set({ include: { ...opts.include, repository: v } })} />
            <Check label="Procedures" checked={opts.include.procedures} onChange={(v) => set({ include: { ...opts.include, procedures: v } })} />
            {opts.language === 'csharp' && <Check label="Interface" checked={opts.include.interface} onChange={(v) => set({ include: { ...opts.include, interface: v } })} />}
          </span>
        )}
      </div>

      {queries.length > 0 && (
        <div className="cg-params" aria-label="Query parameters">
          {queries.map(({ t, i }) => {
            if (t.kind !== 'query') return null;
            const params = detectQueryParams(t.sql, dialect, t.paramTypes ?? {});
            return (
              <div key={i} className="cg-param-row">
                <span className="cg-field">
                  <strong>{t.name}</strong>
                  {params.length ? 'parameters:' : 'has no parameters'}
                </span>
                {params.map((p) => (
                  <label key={p.name} className="cg-field">
                    <span className="mono">{p.positional ? `? #${p.name.slice(1)}` : p.name}</span>
                    <select
                      className="input sm"
                      value={p.type}
                      onChange={(e) => {
                        const targets = st.targets.map((x, k) => (k === i && x.kind === 'query' ? { ...x, paramTypes: { ...(x.paramTypes ?? {}), [p.name]: e.target.value as QueryParamType } } : x));
                        updateState({ targets });
                      }}
                    >
                      {PARAM_TYPES.map((pt) => (
                        <option key={pt}>{pt}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {(routines.length > 0 || missing.length > 0 || queryErrors.length > 0) && (
        <div className="cg-notes">
          {routines.map((r) => (
            <span key={r.name} className="cg-field">
              {r.resultColumns ? `${r.name}: ${r.resultColumns.length} result columns` : `${r.name}: result shape unknown`}
              <button type="button" className="btn btn-xs" disabled={!!inferring} onClick={() => void infer(r)} title="Runs the procedure with NULL parameters in a rolled-back transaction">
                {inferring === r.name ? <LoaderCircle size={12} className="spin" /> : <FlaskConical size={12} />} Run to infer result columns
              </button>
            </span>
          ))}
          {missing.length > 0 && <span className="muted">Not in the loaded catalog (yet): {missing.join(', ')}</span>}
          {queryErrors.map((e) => (
            <span key={e} className="cg-error">
              {e}
            </span>
          ))}
        </div>
      )}

      {empty ? (
        <div className="cg-empty">
          <MousePointerClick size={20} aria-hidden="true" />
          <div className="cg-empty-title">Pick an object in the explorer or a result set</div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const t = objectTargetOf(undefined);
              if (!t) {
                toast('info', 'Select a table, view or procedure in the explorer first');
                return;
              }
              useTabs.getState().updateView(tab.id, { connectionId: t.connectionId, database: t.database, state: { ...st, connectionId: t.connectionId, database: t.database, targets: (t.refs ?? [t.ref]).map((ref) => ({ kind: 'object', ref })) satisfies CodegenTarget[] } });
            }}
          >
            Use the explorer selection
          </button>
        </div>
      ) : (
        <>
          <div className="cg-files" role="tablist" aria-label="Generated files">
            {files.map((f, i) => (
              <button key={f.path} type="button" role="tab" aria-selected={file === f} className={`results-tab${file === f ? ' active' : ''}`} onClick={() => setFileIdx(i)}>
                {f.path}
              </button>
            ))}
            <span className="flex-1" />
            {file && (
              <>
                <button type="button" className="btn btn-xs" onClick={() => void copyText(file.content, `${file.path} copied`)} title="Copy to clipboard">
                  <Copy size={12} /> Copy
                </button>
                <button type="button" className="btn btn-xs" onClick={() => void saveFile(file)} title="Save to a file">
                  <Download size={12} /> Save file…
                </button>
                <button type="button" className="btn btn-xs" onClick={() => openGeneratedFile({ path: file.path, language: file.language, content: file.content })} title="Open in its own tab">
                  <ExternalLink size={12} /> Open as tab
                </button>
              </>
            )}
          </div>
          <div className="cg-output">
            {file ? (
              <CodeView value={file.content} language={file.language} theme={theme} label={`Generated ${file.path}`} />
            ) : (
              <div className="cg-empty">
                <div className="cg-empty-title">Nothing to generate for this selection with {info.label} / {flavors.find((f) => f.id === opts.flavor)?.label ?? opts.flavor}</div>
                <span className="muted">Try another flavor, or include more parts above.</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange(v: boolean): void; title?: string }) {
  return (
    <label className="check sm" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function routineKey(r: CgRoutine, dialect: Dialect): string {
  return routineSqlName(r, dialect, (s) => s).toLowerCase();
}

async function saveFile(f: { path: string; language: string; content: string }) {
  const ext = f.path.split('.').pop() ?? 'txt';
  const saved = await getPlatform().saveFile({ suggestedName: f.path, content: f.content, mime: 'text/plain', filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (saved) toast('success', `Saved ${typeof saved === 'string' ? saved : f.path}`);
}

/** Runs `sql` on a manual-transaction session, rolls back, and returns the first result set's columns. */
async function runForColumns(tabId: string, connectionId: string, database: string | null, sql: string): Promise<ColumnInfo[] | null> {
  const session = await useSessions.getState().ensure(tabId, connectionId, effectiveDatabase(connectionId, database), 'manual');
  const localId = `cg${Date.now().toString(36)}`;
  const batches = [{ sql, line: 1, col: 1 }];
  useResults.getState().begin(createExecution({ localId, tabId, connectionId, sessionId: session.sessionId, label: 'statement', batches, maxRows: 1, confirmedDestructive: true }));
  try {
    const res = await api.execute(session.sessionId, { batches, maxRows: 1, stopOnError: true, label: 'statement', source: { tabId, title: 'Infer result columns' }, confirmedDestructive: true });
    useResults.getState().attach(localId, res.executionId);
    const exec = await new Promise<ReturnType<typeof useResults.getState>['executions'][string]>((resolve) => {
      const check = () => {
        const e = Object.values(useResults.getState().executions).find((x) => x.localId === localId);
        if (e && !isRunning(e)) {
          unsub();
          resolve(e);
        }
      };
      const unsub = useResults.subscribe(check);
      check();
    });
    if (exec.status === 'error') throw new Error(exec.messages.find((m) => m.severity === 'error')?.text ?? 'The procedure failed');
    return exec.resultSets[0]?.columns ?? null;
  } finally {
    try {
      await useSessions.getState().rollback(tabId);
    } catch {
      /* nothing to roll back */
    }
    void useSessions.getState().close(tabId, true).catch(() => undefined);
    useResults.getState().clearTab(tabId);
  }
}

/** A generated file opened in its own tab. */
export function GeneratedFileView({ tab, theme, visible }: TabViewProps) {
  const f = tab.state as CodegenFileState;
  if (!visible) return null;
  return (
    <div className="cg" aria-label={tab.title}>
      <div className="cg-files">
        <strong>{f.path}</strong>
        <span className="flex-1" />
        <button type="button" className="btn btn-xs" onClick={() => void copyText(f.content, `${f.path} copied`)}>
          <Copy size={12} /> Copy
        </button>
        <button type="button" className="btn btn-xs" onClick={() => void saveFile(f)}>
          <Download size={12} /> Save file…
        </button>
      </div>
      <div className="cg-output">
        <CodeView value={f.content} language={f.language} theme={theme} label={f.path} />
      </div>
    </div>
  );
}

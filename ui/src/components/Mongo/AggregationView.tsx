// Aggregation pipeline builder (docs/PLAN-M2.md 6.4): ordered stage cards (stage picker, shell-JSON body with
// completion, enable toggle, per-stage preview of 10 documents debounced 500 ms and cancelled on edit), Run (paged
// 20), Explain, Save / Open (settings ui.mongoPipelines), Import from text, Export to code in five languages.
// Keyboard: Ctrl+Shift+A adds a stage, Alt+Up/Down moves the focused stage, Ctrl+/ toggles it.
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Code, FileInput, FolderOpen, Gauge, GripVertical, Play, Plus, Save, Trash2, TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import type { MongoFieldPath } from '../../api/types';
import { parseEjsonDoc, toShell, type BsonDoc } from '../../mongo/bson';
import { STAGES, stageDoc, WRITE_STAGES } from '../../mongo/operators';
import { checkShell, parseShell, parseShellArray } from '../../mongo/shellJson';
import { uiSetting, useSettings } from '../../store/settings';
import { toast, useUi } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { DocTree } from './BsonView';
import type { SubViewProps } from './CollectionView';
import { showMongoDialog } from './dialogHost';
import { MongoEditor } from './MongoEditor';
import { newStage, type StageState } from './open';
import { cachedFields, loadFields } from './store';
import { errorText, plural } from './util';

export interface SavedPipeline {
  name: string;
  ns: string;
  stages: { op: string; body: string; enabled: boolean }[];
  savedAt: string;
}

export const PIPELINES_KEY = 'mongoPipelines';
const PREVIEW_LIMIT = 10;
const DEBOUNCE_MS = 500;

/** Stage text for the engine: `{ $op: body }`. */
export function stageText(s: StageState): string {
  return `{ ${s.op}: ${s.body.trim() || '{}'} }`;
}

export function stageError(s: StageState): string | null {
  if (!s.body.trim()) return 'The stage body is empty.';
  return checkShell(s.body, 'value')?.message ?? null;
}

/** Splits `[ { $match: … }, … ]` into stage states (Import from text, Open). */
export function stagesFromText(text: string): StageState[] {
  return parseShellArray(text).map((v) => {
    if (v.t !== 'object' || v.v.length !== 1 || !v.v[0][0].startsWith('$')) throw new Error('Each stage must be a document with one $stage field.');
    const [op, body] = v.v[0];
    return newStage(op, toShell(body, { inline: 60 }));
  });
}

interface Preview {
  status: 'idle' | 'loading' | 'ok' | 'error';
  docs: BsonDoc[];
  truncated: boolean;
  error: string | null;
  writeSkipped?: boolean;
}

const IDLE: Preview = { status: 'idle', docs: [], truncated: false, error: null };

const STAGE_OPTIONS = STAGES.map((s) => ({ value: s.name, label: s.name, detail: s.summary }));

export default function AggregationView({ tabId, cid, db, coll, state, patch, theme, visible, readOnly }: SubViewProps) {
  const stages = useMemo(() => state.pipeline ?? [newStage('$match', '{\n  \n}')], [state.pipeline]);
  const [fields, setFields] = useState<readonly MongoFieldPath[]>(() => cachedFields(cid, db, coll));
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [autoPreview, setAutoPreview] = useState(true);
  const [run, setRun] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; docs: BsonDoc[]; truncated: boolean; error: string | null; skip: number }>({ status: 'idle', docs: [], truncated: false, error: null, skip: 0 });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const ctls = useRef(new Map<string, AbortController>());
  const focusStage = useRef<string | null>(null);
  const doneKey = useRef(new Map<string, string>());

  useEffect(() => {
    void loadFields(cid, db, coll).then(setFields);
  }, [cid, db, coll]);

  const setStages = useCallback((next: StageState[]) => patch({ pipeline: next }), [patch]);
  const update = (id: string, p: Partial<StageState>) => setStages(stages.map((s) => (s.id === id ? { ...s, ...p } : s)));

  /** Enabled stages up to and including `index` (texts) and the position of that stage among them. */
  const sliceFor = useCallback((index: number) => {
    const upto = stages.slice(0, index + 1).filter((s) => s.enabled);
    return upto.map(stageText);
  }, [stages]);

  const firstInvalid = stages.findIndex((s) => s.enabled && stageError(s));

  // per-stage previews: debounced, cancelled on edit
  useEffect(() => {
    if (!autoPreview || !visible) return;
    stages.forEach((s, i) => {
      const pipeKey = s.enabled ? JSON.stringify(sliceFor(i)) : '';
      if (pipeKey && doneKey.current.get(s.id) === pipeKey) return;
      const prev = timers.current.get(s.id);
      if (prev) clearTimeout(prev);
      ctls.current.get(s.id)?.abort();
      if (!s.enabled) return;
      if (firstInvalid >= 0 && firstInvalid <= i) {
        setPreviews((p) => ({ ...p, [s.id]: { ...IDLE, status: 'error', error: firstInvalid === i ? stageError(s) : `Fix stage ${firstInvalid + 1} first.` } }));
        return;
      }
      timers.current.set(s.id, setTimeout(() => {
        const ctl = new AbortController();
        ctls.current.set(s.id, ctl);
        const pipe = sliceFor(i);
        setPreviews((p) => ({ ...p, [s.id]: { ...(p[s.id] ?? IDLE), status: 'loading' } }));
        api.mongo.aggregate(cid, db, coll, { pipeline: pipe, previewStage: pipe.length - 1, limit: PREVIEW_LIMIT, skip: 0, allowDiskUse: true, maxTimeMs: 10000 }, ctl.signal).then(
          (r) => !ctl.signal.aborted && doneKey.current.set(s.id, pipeKey) && setPreviews((p) => ({ ...p, [s.id]: { status: 'ok', docs: r.docs.map(parseEjsonDoc), truncated: r.truncated, error: null, writeSkipped: r.writeStageSkipped } })),
          (e) => !ctl.signal.aborted && doneKey.current.set(s.id, pipeKey) && setPreviews((p) => ({ ...p, [s.id]: { ...IDLE, status: 'error', error: errorText(e) } })),
        );
      }, DEBOUNCE_MS));
    });
    const t = timers.current;
    const c = ctls.current;
    return () => {
      t.forEach((x) => clearTimeout(x));
      c.forEach((x) => x.abort());
    };
  }, [stages, autoPreview, visible, cid, db, coll, sliceFor, firstInvalid]);

  const hasWrite = stages.some((s) => s.enabled && WRITE_STAGES.has(s.op));

  const runPipeline = async (skip = 0) => {
    if (firstInvalid >= 0) {
      toast('error', `Stage ${firstInvalid + 1} has an error`, stageError(stages[firstInvalid]) ?? undefined);
      return;
    }
    if (hasWrite) {
      if (readOnly) {
        toast('error', 'This connection is read-only', '$out and $merge write to a collection.');
        return;
      }
      const ok = await useUi.getState().askConfirm({ title: 'Run a write stage?', danger: true, confirmLabel: 'Run and write', message: 'The pipeline ends in $out or $merge and will write its results to a collection.' });
      if (!ok) return;
    }
    setRun((r) => ({ ...r, status: 'loading', error: null, skip }));
    try {
      const r = await api.mongo.aggregate(cid, db, coll, { pipeline: stages.filter((s) => s.enabled).map(stageText), limit: 20, skip, allowDiskUse: true, maxTimeMs: 60000 });
      setRun({ status: 'ok', docs: r.docs.map(parseEjsonDoc), truncated: r.truncated, error: null, skip });
      if (hasWrite) toast('success', 'The pipeline wrote its output');
    } catch (e) {
      setRun({ status: 'error', docs: [], truncated: false, error: errorText(e), skip });
    }
  };

  const addStage = (after?: number) => {
    const s = newStage('$match', '{\n  \n}');
    const next = [...stages];
    next.splice(after === undefined ? next.length : after + 1, 0, s);
    focusStage.current = s.id;
    setStages(next);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    focusStage.current = next[j].id;
    setStages(next);
  };
  const remove = (i: number) => setStages(stages.filter((_, k) => k !== i));
  const changeOp = (s: StageState, op: string) => {
    const doc = stageDoc(op);
    const untouched = !s.body.trim() || s.body.replace(/\s/g, '') === '{}' || s.body === stageDoc(s.op)?.snippet?.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\\\$/g, '$');
    update(s.id, { op, body: untouched && doc?.snippet ? doc.snippet.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\\\$/g, '$') : s.body });
  };

  useEffect(() => {
    if (!focusStage.current) return;
    const id = focusStage.current;
    focusStage.current = null;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tab-host="${tabId}"] [data-stage="${id}"] .mg-stage-head`)?.focus());
  });

  const openExport = () => {
    let pipeline;
    try {
      pipeline = stages.filter((s) => s.enabled).map((s) => parseShell(stageText(s)));
    } catch (e) {
      toast('error', 'Fix the pipeline first', errorText(e));
      return;
    }
    void import('./ExportCodeDialog').then(({ ExportCodeDialog }) =>
      showMongoDialog((close) => <ExportCodeDialog input={{ kind: 'aggregate', db, coll, pipeline }} theme={theme} onClose={close} />));
  };

  // palette / shortcut actions
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; action: string }>).detail;
      if (d.tabId !== tabId) return;
      if (d.action === 'addStage') addStage();
      else if (d.action === 'runPipeline') void runPipeline();
      else if (d.action === 'exportCode' && state.sub === 'aggregate') openExport();
    };
    window.addEventListener('dbstudio:mongo', on);
    return () => window.removeEventListener('dbstudio:mongo', on);
  });

  const onStageKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    if ((e.target as HTMLElement).closest('.monaco-editor, textarea')) return;
    if (e.altKey && e.key === 'ArrowUp') move(i, -1);
    else if (e.altKey && e.key === 'ArrowDown') move(i, 1);
    else if ((e.ctrlKey || e.metaKey) && e.key === '/') update(stages[i].id, { enabled: !stages[i].enabled });
    else return;
    e.preventDefault();
  };
  const onRootKey = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      addStage();
    }
  };

  const explain = () => patch({ sub: 'explain', explainOf: 'aggregate', runSeq: (state.runSeq ?? 0) + 1 });

  const savedAll = useSettings((st) => st.settings.ui[PIPELINES_KEY]) as SavedPipeline[] | undefined;
  const saved = (savedAll ?? []).filter((p) => p.ns === `${db}.${coll}` || !p.ns);

  const save = () => showMongoDialog((close) => <SaveDialog onClose={close} onSave={(name) => {
    const all = uiSetting<SavedPipeline[]>(PIPELINES_KEY, []).filter((p) => !(p.name === name && p.ns === `${db}.${coll}`));
    all.unshift({ name, ns: `${db}.${coll}`, stages: stages.map(({ op, body, enabled }) => ({ op, body, enabled })), savedAt: new Date().toISOString() });
    useSettings.getState().update({ ui: { [PIPELINES_KEY]: all.slice(0, 100) } });
    toast('success', `Saved pipeline “${name}”`);
  }} />);

  const load = (p: SavedPipeline) => setStages(p.stages.map((s) => ({ ...newStage(s.op, s.body), enabled: s.enabled })));

  const importText = () => showMongoDialog((close) => <ImportTextDialog onClose={close} onImport={(next) => setStages(next)} theme={theme} />);

  return (
    <div className="mg-agg" data-command-scope="mongoAggregate" onKeyDown={onRootKey}>
      <div className="mg-toolbar" role="toolbar" aria-label="Pipeline">
        <button className="btn btn-xs btn-primary" onClick={() => void runPipeline()} disabled={run.status === 'loading'} title="Run the whole pipeline (20 per page)">
          <Play size={14} aria-hidden /> Run
        </button>
        <button className="btn btn-xs" onClick={explain}><Gauge size={14} aria-hidden /> Explain</button>
        <span className="tb-sep" />
        <button className="btn btn-xs" onClick={save}><Save size={14} aria-hidden /> Save</button>
        <OpenMenu saved={saved} onOpen={load} />
        <button className="btn btn-xs" onClick={importText} title="Paste a pipeline [ {…}, … ]"><FileInput size={14} aria-hidden /> Import text</button>
        <button className="btn btn-xs" onClick={openExport} title="mongosh, Node.js, C#, Python, Java"><Code size={14} aria-hidden /> Export to code</button>
        <span className="flex-1" />
        <label className="check sm"><input type="checkbox" checked={autoPreview} onChange={(e) => setAutoPreview(e.target.checked)} /> Auto preview</label>
        <span className="muted mg-stagecount">{plural(stages.length, 'stage')}</span>
      </div>
      <div className="mg-agg-body">
        <ol className="mg-stages" aria-label="Pipeline stages">
          {stages.map((s, i) => {
            const p = previews[s.id] ?? IDLE;
            const doc = stageDoc(s.op);
            const err = stageError(s);
            return (
              <li key={s.id} className={`mg-stage ${s.enabled ? '' : 'disabled'} ${s.collapsed ? 'collapsed' : ''}`} data-stage={s.id} onKeyDown={(e) => onStageKey(e, i)}>
                <div className="mg-stage-head" tabIndex={0} aria-label={`Stage ${i + 1}: ${s.op}${s.enabled ? '' : ' (disabled)'}`}>
                  <GripVertical size={14} className="muted" aria-hidden />
                  <button className="icon-btn xs" aria-label={s.collapsed ? 'Expand stage' : 'Collapse stage'} onClick={() => update(s.id, { collapsed: !s.collapsed })}>
                    {s.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <span className="mg-stage-n">{i + 1}</span>
                  <span className="mg-stage-op"><Select aria-label={`Stage ${i + 1} operator`} size="sm" mono value={s.op} onChange={(op) => changeOp(s, op)} options={STAGE_OPTIONS} searchable menuMinWidth={220} /></span>
                  {WRITE_STAGES.has(s.op) && <span className="pill pill-warning" title="Writes to a collection when the pipeline runs; previews skip it"><TriangleAlert size={11} aria-hidden /> writes</span>}
                  <span className="mg-stage-summary muted" title={doc?.syntax}>{doc?.summary}</span>
                  <span className="flex-1" />
                  <label className="mg-switch" title={s.enabled ? 'Disable stage (Ctrl+/)' : 'Enable stage (Ctrl+/)'}>
                    <input type="checkbox" role="switch" checked={s.enabled} onChange={(e) => update(s.id, { enabled: e.target.checked })} aria-label={`Stage ${i + 1} enabled`} />
                    <span aria-hidden />
                  </label>
                  <button className="icon-btn xs" aria-label="Move stage up" title="Move up (Alt+Up)" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                  <button className="icon-btn xs" aria-label="Move stage down" title="Move down (Alt+Down)" disabled={i === stages.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                  <button className="icon-btn xs" aria-label="Add stage after" title="Add a stage after this one" onClick={() => addStage(i)}><Plus size={14} /></button>
                  <button className="icon-btn xs danger" aria-label="Delete stage" onClick={() => remove(i)}><Trash2 size={14} /></button>
                </div>
                {!s.collapsed && (
                  <div className="mg-stage-body">
                    <div className="mg-stage-editor">
                      <MongoEditor mode={`stage:${s.op}`} validate="value" fields={fields} theme={theme} value={s.body} onChange={(body) => update(s.id, { body })}
                        height="auto" minHeight={64} maxHeight={320} ariaLabel={`Stage ${i + 1} ${s.op} body`} lineNumbers={false} invalid={!!err} onSubmit={() => void runPipeline()} />
                      {err && s.body.trim() && <p className="mg-stage-err" role="alert">{err}</p>}
                    </div>
                    <div className="mg-stage-preview" aria-label={`Output after stage ${i + 1}`} aria-busy={p.status === 'loading'}>
                      <div className="mg-preview-head">
                        {!s.enabled ? <span className="muted">Stage disabled: its input passes through</span>
                          : p.status === 'loading' ? <span className="muted">Running…</span>
                            : p.status === 'error' ? <span className="mg-err-text">{p.error}</span>
                              : p.status === 'ok' ? <span className="muted">Output after <code>{s.op}</code>: {p.docs.length === 0 ? 'no documents' : `${p.truncated ? 'first ' : ''}${plural(p.docs.length, 'document')}`}{p.writeSkipped ? ' (the write stage is skipped in previews)' : ''}</span>
                                : <span className="muted">{autoPreview ? 'Preview pending…' : 'Auto preview is off'}</span>}
                      </div>
                      {s.enabled && p.status === 'ok' && p.docs.length > 0 && (
                        <div className="mg-preview-docs">
                          {p.docs.map((d, k) => <div key={k} className="mg-mini-card"><DocTree doc={d} maxFields={8} /></div>)}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <button className="btn mg-addstage" onClick={() => addStage()} title="Add stage (Ctrl+Shift+A)"><Plus size={14} aria-hidden /> Add stage</button>
        {run.status !== 'idle' && (
          <section className="mg-run" aria-label="Pipeline output">
            <header className="mg-run-head">
              <strong>Output</strong>
              {run.status === 'loading' && <span className="muted">Running…</span>}
              {run.status === 'ok' && <span className="muted">{run.docs.length ? `${run.skip + 1}–${run.skip + run.docs.length}${run.truncated ? ' (more available)' : ''}` : 'No documents'}</span>}
              <span className="flex-1" />
              <button className="btn btn-xs" disabled={run.skip === 0 || run.status === 'loading'} onClick={() => void runPipeline(Math.max(0, run.skip - 20))}>Previous</button>
              <button className="btn btn-xs" disabled={!run.truncated || run.status === 'loading'} onClick={() => void runPipeline(run.skip + 20)}>Next</button>
            </header>
            {run.status === 'error' && <div className="mg-error" role="alert">{run.error}</div>}
            <ul className="mg-cards">
              {run.docs.map((d, k) => <li key={k} className="mg-card"><DocTree doc={d} /></li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function OpenMenu({ saved, onOpen }: { saved: SavedPipeline[]; onOpen: (p: SavedPipeline) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="mg-menuwrap">
      <button className="btn btn-xs" aria-haspopup="menu" aria-expanded={open} disabled={!saved.length} onClick={() => setOpen(!open)}
        title={saved.length ? 'Open a saved pipeline' : 'No saved pipelines for this collection yet'}>
        <FolderOpen size={14} aria-hidden /> Open
      </button>
      {open && (
        <ul className="mg-popmenu" role="menu" onMouseLeave={() => setOpen(false)}>
          {saved.map((p) => (
            <li key={`${p.ns}:${p.name}`} role="menuitem" tabIndex={0} onClick={() => { setOpen(false); onOpen(p); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setOpen(false); onOpen(p); } else if (e.key === 'Escape') setOpen(false); }}>
              <span>{p.name}</span> <span className="muted">{plural(p.stages.length, 'stage')} · {new Date(p.savedAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

function SaveDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState('');
  const go = () => {
    if (!name.trim()) return;
    onSave(name.trim());
    onClose();
  };
  return (
    <Dialog title="Save pipeline" onClose={onClose} onSubmit={go} width={420}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim()} onClick={go}>Save</button></>}>
      <div className="form-grid">
        <label className="form-label" htmlFor="mg-pipe-name">Name</label>
        <input id="mg-pipe-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
    </Dialog>
  );
}

function ImportTextDialog({ onClose, onImport, theme }: { onClose: () => void; onImport: (s: StageState[]) => void; theme: SubViewProps['theme'] }) {
  const [text, setText] = useState('[\n  { $match: {} }\n]');
  let error: string | null = null;
  let stages: StageState[] = [];
  try {
    stages = stagesFromText(text);
  } catch (e) {
    error = errorText(e);
  }
  return (
    <Dialog title="Import pipeline from text" onClose={onClose} width={640}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!error || !stages.length} onClick={() => { onImport(stages); onClose(); }}>Replace pipeline ({stages.length})</button></>}>
      <p className="muted">Paste an aggregation pipeline (mongosh syntax). It replaces the current stages.</p>
      <MongoEditor mode="document" validate="array" theme={theme} value={text} onChange={setText} height="auto" minHeight={200} maxHeight={420} ariaLabel="Pipeline text" autoFocus invalid={!!error} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </Dialog>
  );
}

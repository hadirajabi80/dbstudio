// Execute routine dialog (SSMS "Execute Stored Procedure", Navicat's run dialog): one row per parameter, inputs start
// empty, typed editors, a NULL toggle per parameter and "Default" for parameters that have one (the argument is then
// left out of the call), OUT parameters shown as "output". The call SQL is previewed live; Execute (Ctrl+Enter) runs it
// with bind values. "Last values" refills the inputs from the previous run of the same routine on this connection.
import { History, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { peekEditSession, isEditDirty } from '../../designer/editSession';
import { getConnection } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { ConnectionBadge } from '../common/ConnectionBadge';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { Kbd } from '../Shortcuts/Kbd';
import { choiceSignature, resolveRoutines, runRoutineCall, type RoutineChoice } from './routines';
import {
  bareParamName, buildRoutineCall, initialInput, isOutputOnly, paramKindOf, routineLabel, routineNoun, valueEditorOf, type ParamInput,
  type RoutineParam, type RoutineSpec,
} from './routineSql';
import { recallRoutine, rememberRoutine, routineKey, useExecuteRoutine, type ExecuteRoutineRequest } from './store';
import './executeRoutine.css';

/** Rendered by the shell (App); shows the pending request of `useExecuteRoutine`. */
export function ExecuteRoutineHost() {
  const req = useExecuteRoutine((s) => s.request);
  if (!req) return null;
  return <ExecuteRoutineDialog key={`${req.connectionId}|${req.ref.schema}|${req.ref.name}|${req.fromTabId ?? ''}`} req={req} />;
}

function directionLabel(p: RoutineParam): string | null {
  return p.direction === 'out' ? 'out' : p.direction === 'inout' ? 'in/out' : null;
}

function keyOf(req: ExecuteRoutineRequest, c: RoutineChoice): string {
  return routineKey(req.database ?? req.ref.database, routineLabel(c.spec), choiceSignature(c));
}

const PREVIEW_VALUE_MAX = 60;

function previewValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'string' ? `'${v}'` : String(v);
  return s.length > PREVIEW_VALUE_MAX ? `${s.slice(0, PREVIEW_VALUE_MAX - 1)}…` : s;
}

function bindPrefix(spec: RoutineSpec): string {
  return spec.dialect === 'tsql' ? '@' : spec.dialect === 'plsql' ? ':' : '$';
}

export function ExecuteRoutineDialog({ req }: { req: ExecuteRoutineRequest }) {
  const [choices, setChoices] = useState<RoutineChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<ParamInput[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const close = () => useExecuteRoutine.getState().close();
  const conn = getConnection(req.connectionId);

  useEffect(() => {
    let live = true;
    resolveRoutines(req)
      .then((list) => {
        if (!live) return;
        setChoices(list);
        const first = (req.member ? list.find((c) => c.spec.name === req.member) : undefined) ?? list[0];
        if (first) {
          setChoiceId(first.id);
          setInputs(first.spec.params.map(initialInput));
        }
      })
      .catch((e) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [req]);

  const choice = choices?.find((c) => c.id === choiceId) ?? null;
  const spec = choice?.spec ?? null;
  const call = spec ? buildRoutineCall(spec, inputs) : null;
  const memory = choice ? recallRoutine(req.connectionId, keyOf(req, choice)) : undefined;
  const noun = routineNoun(spec?.kind ?? req.ref.type);
  const edit = req.fromTabId ? peekEditSession(req.fromTabId) : undefined;
  const editTab = req.fromTabId ? useTabs.getState().tabs.find((t) => t.id === req.fromTabId) : undefined;
  const unsavedEdit = !!edit && editTab?.kind === 'console' && isEditDirty(edit, editTab.text);
  const valid = !!call && !call.error && call.errors.every((e) => e === null);

  // First value field once the parameters are known (the Dialog focused whatever existed before they loaded).
  useEffect(() => {
    if (!spec) return;
    const el = bodyRef.current?.querySelector<HTMLElement>('[data-er-value]:not([disabled])') ?? document.querySelector<HTMLElement>('.er-dialog .btn-primary');
    el?.focus();
  }, [spec]);

  const pick = (id: string) => {
    const c = choices?.find((x) => x.id === id);
    if (!c) return;
    setChoiceId(id);
    setInputs(c.spec.params.map(initialInput));
    setShowErrors(false);
  };

  const set = (i: number, p: Partial<ParamInput>) => setInputs((cur) => cur.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const setValue = (i: number, value: string) => set(i, { value, mode: 'value' });

  const recallLast = () => {
    if (!spec || !memory) return;
    setInputs(spec.params.map((p) => {
      const m = memory[bareParamName(p).toLowerCase()];
      if (!m) return initialInput(p);
      if (m.mode === 'default' && !p.hasDefault) return { mode: 'value', value: m.values[0] ?? '' };
      return { mode: m.mode, value: m.values[0] ?? '' };
    }));
  };

  const execute = async () => {
    if (!spec || !call || busy) return;
    if (!valid) {
      setShowErrors(true);
      const bad = call.errors.findIndex((e) => e !== null);
      bodyRef.current?.querySelector<HTMLElement>(`[data-er-row="${bad}"] [data-er-value]`)?.focus();
      return;
    }
    setBusy(true);
    rememberRoutine(req.connectionId, keyOf(req, choice!), spec.params.map((p, i) => ({ name: bareParamName(p), input: inputs[i] ?? initialInput(p) })));
    close();
    await runRoutineCall(req, spec, call);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void execute();
    }
  };

  const title = (
    <span className="er-title">
      <Play size={15} strokeWidth={1.75} aria-hidden="true" />
      <span>Execute {noun}</span>
      <span className="er-title-name mono">{spec ? routineLabel(spec) : [req.ref.schema, req.ref.name].filter(Boolean).join('.')}</span>
    </span>
  );

  return (
    <Dialog
      title={title}
      ariaLabel={`Execute ${noun} ${req.ref.name}`}
      onClose={close}
      onSubmit={() => void execute()}
      width={760}
      className="er-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!memory}
            onClick={recallLast}
            title={memory ? 'Fill in the values of the last run on this connection' : 'No earlier run of this routine on this connection'}
          >
            <History size={14} strokeWidth={1.5} /> Last values
          </button>
          <div className="flex-1" />
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!call || !!call.error || busy} onClick={() => void execute()} title={`Execute ${noun}`}>
            <Play size={13} fill="currentColor" /> Execute <Kbd shortcut="Mod+Enter" className="on-accent" />
          </button>
        </>
      }
    >
      <div className="er-body" ref={bodyRef} onKeyDown={onKeyDown}>
        <div className="er-context">
          <ConnectionBadge conn={conn} />
          {spec?.returnType && <span className="er-returns">returns <span className="mono">{spec.returnType}</span></span>}
        </div>
        {unsavedEdit && (
          <p className="er-note" role="note">
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
            The console has unsaved changes. This runs the {noun} as saved on the server; save first to run your edits.
          </p>
        )}
        {choices && choices.length > 1 && (
          <label className="er-choice">
            <span>{spec?.packageName ? 'Member' : 'Overload'}</span>
            <Select
              size="sm"
              mono
              aria-label={spec?.packageName ? 'Package member' : 'Overload'}
              value={choiceId}
              options={choices.map((c) => ({ value: c.id, label: c.label }))}
              onChange={pick}
            />
          </label>
        )}
        {loadError && <p className="er-error" role="alert">Could not read the parameters: {loadError}</p>}
        {!choices && !loadError && <p className="er-muted">Reading parameters…</p>}
        {choices && choices.length === 0 && <p className="er-muted">Nothing to execute here.</p>}
        {spec && spec.params.length === 0 && <p className="er-muted">This {noun} has no parameters.</p>}
        {spec && spec.params.length > 0 && (
          <div className="er-grid" role="table" aria-label="Parameters">
            <div className="er-head" role="row">
              <span role="columnheader">Parameter</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Value</span>
              <span role="columnheader" className="sr-only">Options</span>
            </div>
            {spec.params.map((p, i) => (
              <ParamRow
                key={`${choiceId}-${i}`}
                index={i}
                param={p}
                spec={spec}
                input={inputs[i] ?? initialInput(p)}
                error={showErrors || (inputs[i]?.value ?? '') !== '' ? call?.errors[i] ?? null : null}
                mru={memory?.[bareParamName(p).toLowerCase()]?.values ?? []}
                onValue={(v) => setValue(i, v)}
                onMode={(mode) => set(i, { mode })}
              />
            ))}
          </div>
        )}
        {call?.error && <p className="er-error" role="alert">{call.error}</p>}
        {call && (
          <div className="er-preview-wrap">
            <div className="er-preview-label">Call</div>
            <pre className="er-preview mono" aria-label="Generated SQL" aria-live="polite">{call.sql}</pre>
            {call.params.length > 0 && (
              <div className="er-binds mono" aria-label="Bind values">
                {call.params.map((b) => (
                  <span key={b.name} className="er-bind">
                    {bindPrefix(spec!)}{b.name}
                    <span className={`er-bind-eq${call.invalid.includes(b.name) ? ' missing' : ''}`}>
                      {b.direction === 'out' ? '→ output' : call.invalid.includes(b.name) ? '= ?' : `= ${previewValue(b.value)}`}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

interface RowProps {
  index: number;
  param: RoutineParam;
  spec: RoutineSpec;
  input: ParamInput;
  error: string | null;
  mru: string[];
  onValue(v: string): void;
  onMode(m: ParamInput['mode']): void;
}

function ParamRow({ index, param: p, spec, input, error, mru, onValue, onMode }: RowProps) {
  const name = bareParamName(p) || `$${index + 1}`;
  const dir = directionLabel(p);
  const kind = paramKindOf(p.type, spec.dialect);
  const outputOnly = isOutputOnly(p) || (kind === 'refcursor' && spec.dialect === 'plsql');
  const editor = valueEditorOf(p.type, kind);
  const valueId = `er-value-${index}`;
  const listId = `er-mru-${index}`;
  const placeholder = input.mode === 'null' ? 'NULL' : input.mode === 'default' ? 'default' : kind === 'string' ? 'empty string' : '';
  const common = {
    id: valueId,
    'data-er-value': true,
    'aria-label': `Value of ${name}`,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${valueId}-err` : undefined,
    spellCheck: false,
  } as const;
  const muted = input.mode !== 'value' ? ' er-passive' : '';
  const shownValue = input.mode === 'value' ? input.value : '';

  let field: ReactNode;
  if (outputOnly) {
    field = <span className="pill pill-muted er-output" title="Written by the routine; shown in the results">output</span>;
  } else if (editor === 'bool') {
    field = (
      <Select
        size="sm"
        aria-label={`Value of ${name}`}
        value={input.mode === 'value' && input.value ? input.value : null}
        placeholder={input.mode === 'null' ? 'NULL' : input.mode === 'default' ? 'default' : 'choose…'}
        options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
        onChange={onValue}
        searchable={false}
        className={`er-bool${muted}`}
      />
    );
  } else if (editor === 'multiline') {
    field = <textarea {...common} className={`input sm mono er-text${muted}${error ? ' invalid' : ''}`} rows={3} value={shownValue} placeholder={placeholder} onChange={(e) => onValue(e.target.value)} />;
  } else {
    const type = editor === 'date' ? 'date' : editor === 'datetime' ? 'datetime-local' : editor === 'time' ? 'time' : 'text';
    field = (
      <>
        <input
          {...common}
          type={type}
          step={editor === 'datetime' || editor === 'time' ? 1 : undefined}
          inputMode={editor === 'number' ? (kind === 'int' ? 'numeric' : 'decimal') : undefined}
          className={`input sm mono${muted}${error ? ' invalid' : ''}`}
          value={shownValue}
          placeholder={placeholder}
          list={mru.length && type === 'text' ? listId : undefined}
          onChange={(e) => onValue(e.target.value)}
        />
        {mru.length > 0 && type === 'text' && (
          <datalist id={listId}>
            {mru.map((v) => <option key={v} value={v} />)}
          </datalist>
        )}
      </>
    );
  }

  return (
    <div className="er-row" role="row" data-er-row={index}>
      <span className="er-name mono" role="cell" title={p.name}>
        {name}
        {dir && <span className="er-dir">{dir}</span>}
      </span>
      <span className="er-type mono" role="cell" title={p.type}>{p.type}</span>
      <span className="er-value" role="cell">
        {field}
        {error && <span id={`${valueId}-err`} className="er-field-error">{error}</span>}
      </span>
      <span className="er-opts" role="cell">
        {!outputOnly && (
          <button
            type="button"
            className={`er-toggle${input.mode === 'null' ? ' on' : ''}`}
            aria-pressed={input.mode === 'null'}
            title={`Pass NULL for ${name}`}
            onClick={() => onMode(input.mode === 'null' ? 'value' : 'null')}
          >
            NULL
          </button>
        )}
        {!outputOnly && p.hasDefault && (
          <button
            type="button"
            className={`er-toggle${input.mode === 'default' ? ' on' : ''}`}
            aria-pressed={input.mode === 'default'}
            title={`Use the default of ${name} (the argument is left out of the call)`}
            onClick={() => onMode(input.mode === 'default' ? 'value' : 'default')}
          >
            Default
          </button>
        )}
      </span>
    </div>
  );
}

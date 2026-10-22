// Execute routine dialog (SSMS "Execute Stored Procedure", Navicat's run dialog, done cleaner): a header with the
// routine, overloads / package members as pills, one row per parameter (typed editors, NULL / Default toggles, inline
// validation), the live call preview, and two ways to run it: Run (Ctrl+Enter) opens the routine's full-page result
// tab, "Run in console" keeps the classic path (results under a console holding the call). Opened from the explorer,
// the object tab, the Objects tab and the palette, without opening the routine for editing first.
import { History, Play, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { peekEditSession, isEditDirty } from '../../designer/editSession';
import { getConnection } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { ConnectionBadge } from '../common/ConnectionBadge';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { Kbd } from '../Shortcuts/Kbd';
import { CallPreview, RoutineHeading, RoutineParamsForm, useParamInputs } from './RoutineForm';
import { choiceSignature, resolveRoutines, runRoutineCall, type RoutineChoice } from './routines';
import { bareParamName, initialInput, routineLabel, routineNoun, type ParamInput } from './routineSql';
import { openRoutineRun } from './runInView';
import { recallRoutine, rememberRoutine, routineKey, useExecuteRoutine, type ExecuteRoutineRequest } from './store';
import './executeRoutine.css';

/** Rendered by the shell (App); shows the pending request of `useExecuteRoutine`. */
export function ExecuteRoutineHost() {
  const req = useExecuteRoutine((s) => s.request);
  if (!req) return null;
  return <ExecuteRoutineDialog key={`${req.connectionId}|${req.ref.schema}|${req.ref.name}|${req.fromTabId ?? ''}`} req={req} />;
}

function keyOf(req: ExecuteRoutineRequest, c: RoutineChoice): string {
  return routineKey(req.database ?? req.ref.database, routineLabel(c.spec), choiceSignature(c));
}

/** Up to this many overloads / members show as pills; more fall back to a searchable list. */
const MAX_PILLS = 6;

export function ExecuteRoutineDialog({ req }: { req: ExecuteRoutineRequest }) {
  const [choices, setChoices] = useState<RoutineChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choiceId, setChoiceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const close = () => useExecuteRoutine.getState().close();
  const conn = getConnection(req.connectionId);
  const choice = choices?.find((c) => c.id === choiceId) ?? null;
  const spec = choice?.spec ?? null;
  const form = useParamInputs(spec);
  const { call, valid } = form;

  useEffect(() => {
    let live = true;
    resolveRoutines(req)
      .then((list) => {
        if (!live) return;
        setChoices(list);
        const first = (req.member ? list.find((c) => c.spec.name === req.member) : undefined) ?? list[0];
        if (first) {
          setChoiceId(first.id);
          form.setInputs(first.spec.params.map(initialInput));
        }
      })
      .catch((e) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [req]); // eslint-disable-line react-hooks/exhaustive-deps

  const memory = choice ? recallRoutine(req.connectionId, keyOf(req, choice)) : undefined;
  const noun = routineNoun(spec?.kind ?? req.ref.type);
  const edit = req.fromTabId ? peekEditSession(req.fromTabId) : undefined;
  const editTab = req.fromTabId ? useTabs.getState().tabs.find((t) => t.id === req.fromTabId) : undefined;
  const unsavedEdit = !!edit && editTab?.kind === 'console' && isEditDirty(edit, editTab.text);

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
    form.setInputs(c.spec.params.map(initialInput));
    form.setShowErrors(false);
  };

  const recallLast = () => {
    if (!spec || !memory) return;
    form.setInputs(spec.params.map((p): ParamInput => {
      const m = memory[bareParamName(p).toLowerCase()];
      if (!m) return initialInput(p);
      if (m.mode === 'default' && !p.hasDefault) return { mode: 'value', value: m.values[0] ?? '' };
      return { mode: m.mode, value: m.values[0] ?? '' };
    }));
  };

  /** Validates, remembers the values, closes, and runs in the result page or in a console. */
  const run = async (where: 'page' | 'console') => {
    if (!spec || !call || busy) return;
    if (!valid) {
      form.setShowErrors(true);
      bodyRef.current?.querySelector<HTMLElement>(`[data-er-row="${form.firstError}"] [data-er-value]`)?.focus();
      return;
    }
    setBusy(true);
    rememberRoutine(req.connectionId, keyOf(req, choice!), spec.params.map((p, i) => ({ name: bareParamName(p), input: form.inputs[i] ?? initialInput(p) })));
    close();
    if (where === 'page') await openRoutineRun(req, spec, form.inputs, call);
    else await runRoutineCall(req, spec, call);
  };

  const pills = choices && choices.length > 1 && choices.length <= MAX_PILLS;
  const memberLabel = spec?.packageName ? 'Package member' : 'Overload';
  const title = (
    <RoutineHeading
      spec={spec}
      fallbackName={[req.ref.schema, req.ref.name].filter(Boolean).join('.')}
      eyebrow={`Execute ${noun}`}
    />
  );

  return (
    <Dialog
      title={title}
      ariaLabel={`Execute ${noun} ${req.ref.name}`}
      onClose={close}
      width={800}
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
          <button
            type="button"
            className="btn"
            disabled={!call || !!call.error || busy}
            onClick={() => void run('console')}
            title={req.fromTabId ? 'Run in the console this came from; results appear under the editor' : 'Run in the current console (or a new one); results appear under the editor'}
          >
            <SquareTerminal size={14} strokeWidth={1.5} /> Run in console
          </button>
          <button type="button" className="btn btn-primary" disabled={!call || !!call.error || busy} onClick={() => void run('page')} title={`Run the ${noun} and show its results on a full page`}>
            <Play size={13} fill="currentColor" /> Run <Kbd shortcut="Mod+Enter" className="on-accent" />
          </button>
        </>
      }
    >
      <div
        className="er-body"
        ref={bodyRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            void run('page');
          }
        }}
      >
        <div className="er-context">
          <ConnectionBadge conn={conn} />
          {(req.database ?? req.ref.database) && <span className="er-db mono">{req.database ?? req.ref.database}</span>}
          {spec?.returnType && (
            <span className="er-returns">
              returns <span className="mono">{spec.returnType}</span>
            </span>
          )}
        </div>
        {unsavedEdit && (
          <p className="er-note" role="note">
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
            The console has unsaved changes. This runs the {noun} as saved on the server; save first to run your edits.
          </p>
        )}
        {pills && (
          <div className="er-choices" role="radiogroup" aria-label={memberLabel}>
            {choices!.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={c.id === choiceId} className={`er-choice-pill mono${c.id === choiceId ? ' on' : ''}`} onClick={() => pick(c.id)} title={c.label}>
                {c.label}
              </button>
            ))}
          </div>
        )}
        {choices && choices.length > MAX_PILLS && (
          <label className="er-choice">
            <span>{memberLabel}</span>
            <Select size="sm" mono aria-label={memberLabel} value={choiceId} options={choices.map((c) => ({ value: c.id, label: c.label }))} onChange={pick} />
          </label>
        )}
        {loadError && <p className="er-error" role="alert">Could not read the parameters: {loadError}</p>}
        {!choices && !loadError && (
          <div className="er-loading" role="status">
            {[64, 48, 56].map((w, i) => <span key={i} className="er-skeleton" style={{ width: `${w}%` }} />)}
          </div>
        )}
        {choices && choices.length === 0 && <p className="er-muted">Nothing to execute here.</p>}
        {spec && (
          <section className="er-section">
            <div className="er-section-head">
              <span className="er-section-label">Parameters</span>
              {spec.params.length > 0 && <span className="er-count">{spec.params.length}</span>}
            </div>
            <RoutineParamsForm spec={spec} state={form} memory={memory} onSubmit={() => void run('page')} />
          </section>
        )}
        {call?.error && <p className="er-error" role="alert">{call.error}</p>}
        {spec && call && <CallPreview spec={spec} call={call} />}
      </div>
    </Dialog>
  );
}

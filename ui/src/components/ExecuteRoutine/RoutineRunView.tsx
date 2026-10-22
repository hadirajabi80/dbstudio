// Routine result page (WP3, `routine.run` view tab): a run started from Execute routine gets the whole editor area.
// Header with the routine, status and timing; the arguments (editable in place, "Run again"); OUT / IN OUT values and
// the return value as a key/value card (the trailing outputs result set is not repeated as a tab); every other result
// set as its own tab with the full grid; messages in a collapsible section.
import {
  ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleSlash, CircleStop, Copy, LoaderCircle, MessageSquare, Play, RotateCw, SlidersHorizontal,
  SquareTerminal, Table2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { copyText, newConsole } from '../../app/actions';
import { useCommandContext } from '../../commands/useCommands';
import { formatCell, formatCount, formatDuration } from '../../lib/format';
import { useConnection, useDialect } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { isRunning, type ExecutionState } from '../../store/resultsReducer';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { ConnectionBadge } from '../common/ConnectionBadge';
import type { TabViewProps } from '../layout/tabViews';
import { MessagesPane } from '../MessagesPane/MessagesPane';
import { ResultSetView } from '../ResultsPane/ResultsPane';
import { Kbd } from '../Shortcuts/Kbd';
import { argumentSummary, CallPreview, RoutineHeading, RoutineParamsForm, useParamInputs } from './RoutineForm';
import { bareParamName, routineNoun, type ParamInput } from './routineSql';
import { cancelInView, runInView } from './runInView';
import { splitOutputs, totalRows, type OutputEntry, type RoutineRunState } from './runModel';
import { rememberRoutine, routineKey } from './store';
import { routineLabel } from './routineSql';
import './executeRoutine.css';

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StatusPill({ exec }: { exec: ExecutionState | undefined }) {
  const running = isRunning(exec);
  const now = useNow(running);
  if (!exec) return <span className="rr-status idle">Not run in this session</span>;
  if (running) {
    return (
      <span className="rr-status running" role="status">
        <LoaderCircle size={13} className="spin" /> Running · {formatDuration(now - exec.startedAt)}
      </span>
    );
  }
  const failed = exec.status === 'error' || exec.errorCount > 0;
  const Icon = exec.status === 'cancelled' ? CircleSlash : failed ? CircleAlert : CircleCheck;
  const cls = exec.status === 'cancelled' ? 'cancelled' : failed ? 'error' : 'ok';
  const text = exec.status === 'cancelled' ? 'Cancelled' : failed ? 'Failed' : 'Completed';
  return (
    <span className={`rr-status ${cls}`} role="status">
      <Icon size={13} /> {text} · {formatDuration(exec.elapsedMs ?? (exec.endedAt ?? now) - exec.startedAt)}
    </span>
  );
}

export function RoutineRunView({ tab, theme, visible }: TabViewProps) {
  useCommandContext();
  const st = tab.state as RoutineRunState;
  const { spec, request } = st;
  const exec = useTabExecution(tab.id);
  const conn = useConnection(request.connectionId);
  const dialect = useDialect(request.connectionId);
  const running = isRunning(exec);
  const split = useMemo(() => splitOutputs(exec, spec), [exec, spec]);
  const [active, setActive] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState<boolean | null>(null);
  const noun = routineNoun(spec.kind);
  const title = `Run: ${routineLabel(spec)}`;

  // A new run: back to the first result set, messages follow the run's outcome again.
  const runId = exec?.localId;
  useEffect(() => {
    setActive(null);
    setMessagesOpen(null);
  }, [runId]);

  const shownRs = split.resultSets.find((r) => r.id === active) ?? split.resultSets[0] ?? null;
  const done = !!exec && !running;
  const errors = exec?.errorCount ?? 0;
  const autoMessages = done && (errors > 0 || split.resultSets.length === 0);
  const showMessages = messagesOpen ?? autoMessages;
  const rows = totalRows(split.resultSets);

  const rerun = (inputs?: ParamInput[], sql?: string, params?: RoutineRunState['params']) => {
    const next: RoutineRunState = { ...st, inputs: inputs ?? st.inputs, sql: sql ?? st.sql, params: params ?? st.params, runs: st.runs + 1 };
    useTabs.getState().updateView(tab.id, { state: next });
    void runInView(tab.id, { connectionId: request.connectionId, database: request.database, sql: next.sql, params: next.params, title });
  };
  const args = argumentSummary(spec, st.inputs);

  return (
    <div
      className="rr-view"
      tabIndex={-1}
      data-primary-focus
      style={{ display: visible ? undefined : 'none' }}
      data-command-scope="results"
      onKeyDown={(e) => {
        // Ctrl+Enter runs again (the parameter editor handles its own; the grid keeps its keys).
        if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || editing || running) return;
        if ((e.target as HTMLElement).closest('.resultset')) return;
        e.preventDefault();
        e.stopPropagation();
        rerun();
      }}
    >
      <header className="rr-header">
        <RoutineHeading spec={spec} fallbackName={request.ref.name} eyebrow={`${noun[0].toUpperCase()}${noun.slice(1)} result`} />
        <StatusPill exec={exec} />
        {done && (
          <span className="rr-meta">
            {split.resultSets.length > 0 && <>{split.resultSets.length} result set{split.resultSets.length === 1 ? '' : 's'} · {formatCount(rows)} row{rows === 1 ? '' : 's'}</>}
            {exec!.rowsAffected > 0 && <>{split.resultSets.length > 0 ? ' · ' : ''}{formatCount(exec!.rowsAffected)} affected</>}
          </span>
        )}
        <div className="flex-1" />
        <ConnectionBadge conn={conn} />
        <button className="icon-btn sm" title="Copy the call SQL" aria-label="Copy the call SQL" onClick={() => void copyText(st.sql, 'Call copied')}>
          <Copy size={14} />
        </button>
        <button className="btn btn-xs" title="Open the call in a new console" onClick={() => newConsole(request.connectionId, request.database, st.sql)}>
          <SquareTerminal size={13} /> Open in console
        </button>
        <button className={`btn btn-xs${editing ? ' on' : ''}`} aria-expanded={editing} onClick={() => setEditing(!editing)} title="Change the arguments">
          <SlidersHorizontal size={13} /> Parameters
        </button>
        {running ? (
          <button className="btn btn-xs" onClick={() => void cancelInView(tab.id)}>
            <CircleStop size={13} /> Cancel
          </button>
        ) : (
          <button className="btn btn-xs btn-primary" onClick={() => rerun()} title={`Run the ${noun} again with the same arguments`}>
            {exec ? <RotateCw size={13} /> : <Play size={12} fill="currentColor" />} {exec ? 'Run again' : 'Run'}
          </button>
        )}
      </header>

      {editing ? (
        <ParamsEditor
          key={st.runs}
          st={st}
          busy={running}
          onRun={(inputs, sql, params) => {
            rememberRoutine(request.connectionId, routineKey(request.database ?? request.ref.database, routineLabel(spec), spec.params.map((p) => p.type).join(', ')),
              spec.params.map((p, i) => ({ name: bareParamName(p), input: inputs[i] })));
            setEditing(false);
            rerun(inputs, sql, params);
          }}
        />
      ) : (
        args.length > 0 && (
          <div className="rr-args" aria-label="Arguments">
            {args.map((a) => (
              <button key={a.name} type="button" className={`rr-arg mode-${a.mode}`} onClick={() => setEditing(true)} title="Change the arguments">
                <span className="rr-arg-name mono">{a.name}</span>
                <span className="rr-arg-value mono">{a.text}</span>
              </button>
            ))}
          </div>
        )
      )}

      {split.outputs && <OutputsCard outputs={split.outputs} />}

      <section className={`rr-results${split.resultSets.length ? '' : ' no-sets'}`} aria-label="Result sets">
        {split.resultSets.length > 0 && (
          <>
            <div className="rr-tabs" role="tablist" aria-label="Result sets">
              {split.resultSets.map((r, i) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={shownRs?.id === r.id}
                  className={`rr-tab${shownRs?.id === r.id ? ' active' : ''}`}
                  onClick={() => setActive(r.id)}
                >
                  <Table2 size={13} /> Result {i + 1}
                  <span className="rr-tab-count">{formatCount(r.rowCount)}</span>
                  {!r.done && <LoaderCircle size={11} className="spin" />}
                </button>
              ))}
            </div>
            {shownRs && exec && (
              <div className="rr-grid">
                <ResultSetView key={`${exec.localId}:${shownRs.id}`} exec={exec} rs={shownRs} dialect={dialect} theme={theme} />
              </div>
            )}
          </>
        )}
        {split.resultSets.length === 0 && (
          <div className="rr-empty">
            {!exec ? (
              <>
                <Play size={22} strokeWidth={1.5} />
                <div className="rr-empty-title">Run the {noun} to see its results here</div>
                <button className="btn btn-primary" onClick={() => rerun()}>
                  <Play size={12} fill="currentColor" /> Run <Kbd shortcut="Mod+Enter" className="on-accent" />
                </button>
              </>
            ) : running ? (
              <>
                <LoaderCircle size={22} className="spin" />
                <div className="rr-empty-title">Waiting for results…</div>
              </>
            ) : (
              <>
                {errors > 0 ? <CircleAlert size={22} strokeWidth={1.5} className="rr-err" /> : <CircleCheck size={22} strokeWidth={1.5} className="rr-ok" />}
                <div className="rr-empty-title">{errors > 0 ? `The ${noun} failed` : split.outputs ? 'No result sets; the outputs are above' : `The ${noun} returned no result sets`}</div>
                {exec.rowsAffected > 0 && <div className="rr-empty-hint">{formatCount(exec.rowsAffected)} row{exec.rowsAffected === 1 ? '' : 's'} affected</div>}
              </>
            )}
          </div>
        )}
      </section>

      {exec && (
        <section className={`rr-messages${showMessages ? ' open' : ''}`}>
          <button className="rr-messages-head" aria-expanded={showMessages} onClick={() => setMessagesOpen(!showMessages)}>
            {showMessages ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <MessageSquare size={13} /> Messages
            {errors > 0 ? <span className="badge badge-error">{errors}</span> : exec.messages.length > 0 && <span className="rr-tab-count">{exec.messages.length}</span>}
          </button>
          {showMessages && (
            <div className="rr-messages-body">
              <MessagesPane exec={exec} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ParamsEditor({ st, busy, onRun }: { st: RoutineRunState; busy: boolean; onRun(inputs: ParamInput[], sql: string, params: RoutineRunState['params']): void }) {
  const form = useParamInputs(st.spec, st.inputs);
  const submit = () => {
    if (!form.call || busy) return;
    if (!form.valid) {
      form.setShowErrors(true);
      return;
    }
    onRun(form.inputs, form.call.sql, form.call.params);
  };
  return (
    <div className="rr-editor">
      <RoutineParamsForm spec={st.spec} state={form} onSubmit={submit} idPrefix="rr" />
      <div className="rr-editor-side">
        {form.call && <CallPreview spec={st.spec} call={form.call} />}
        {form.call?.error && <p className="er-error" role="alert">{form.call.error}</p>}
        <div className="rr-editor-actions">
          <button className="btn btn-primary" disabled={!form.call || !!form.call.error || busy} onClick={submit}>
            <Play size={12} fill="currentColor" /> Run <Kbd shortcut="Mod+Enter" className="on-accent" />
          </button>
        </div>
      </div>
    </div>
  );
}

function OutputsCard({ outputs }: { outputs: OutputEntry[] }) {
  const { nullText, dateFormat } = useSettings((s) => s.settings.results);
  const onlyReturn = outputs.length === 1 && outputs[0].name === 'Return value';
  return (
    <section className="rr-outputs" aria-label={onlyReturn ? 'Return value' : 'Output parameters'}>
      <div className="rr-outputs-head">{onlyReturn ? 'Return value' : 'Outputs'}</div>
      <div className="rr-outputs-grid">
        {outputs.map((o) => {
          const text = formatCell(o.value, o.column, { nullText, dateFormat });
          const isNull = o.value === null;
          return (
            <button
              key={o.name}
              type="button"
              className={`rr-output${o.name === 'Return value' ? ' ret' : ''}`}
              onClick={() => void copyText(isNull ? 'NULL' : text, `${o.name} copied`)}
              title="Copy the value"
            >
              <span className="rr-output-name mono">{o.name}</span>
              <span className={`rr-output-value mono${isNull ? ' null' : ''}`}>{text}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

import { CalendarDays, CaseSensitive, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ColumnInfo } from '../../api/types';
import { kindClass, resolveColumn, type FilterCondition, type FilterValue } from '../../filter/model';
import { OPERATOR_INFO, PERIOD_UNITS, arityOf, defaultOperator, operatorsFor } from '../../filter/operators';
import { conditionProblem, splitList } from '../../filter/values';
import { Select } from '../common/Select';

interface Props {
  cond: FilterCondition;
  columns: ColumnInfo[];
  onChange(c: FilterCondition): void;
  onRemove(): void;
  /** Enter in a value input. */
  onSubmit?(): void;
  autoFocus?: boolean;
  /** Server mode: regex is not pushed down (shown with a hint). */
  serverMode?: boolean;
}

const COMMIT_MS = 180;

function listText(values: FilterValue[]): string {
  return values.map((v) => {
    const s = v === null ? '' : String(v);
    return /[,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(', ');
}

/** One condition: enable · column · operator · operand(s) · case · remove. */
export function ConditionRow({ cond, columns, onChange, onRemove, onSubmit, autoFocus, serverMode }: Props) {
  const ci = resolveColumn(columns, cond.column, cond.ordinal);
  const col = ci >= 0 ? columns[ci] : undefined;
  const ops = operatorsFor(col?.kind);
  const arity = arityOf(cond.op);
  const cls = kindClass(col?.kind);
  const problem = col ? conditionProblem(cond, col.kind) : 'Column is not in this result';
  const filled = cond.values.some((v) => v !== null && String(v).trim() !== '');
  const showProblem = problem && (filled || arity === 'two');
  /** Incomplete and not yet flagged (e.g. "Id equals …" just added): shown as a draft that does not filter yet. */
  const draft = !!problem && !showProblem && cond.enabled !== false;
  const firstRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  // A new condition: the column is usually already right (focused grid column), so the value gets the focus.
  useEffect(() => {
    if (autoFocus) (valueRef.current ?? firstRef.current)?.focus();
  }, [autoFocus]);

  // Local text for operands, committed after a short pause (live filtering of large results stays smooth).
  const [texts, setTexts] = useState<string[]>(() => toTexts(cond));
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = useRef(cond.values);
  useEffect(() => {
    if (cond.values !== lastCommitted.current) {
      lastCommitted.current = cond.values;
      setTexts(toTexts(cond));
    }
  }, [cond]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: string[], now = false) => {
    if (pending.current) clearTimeout(pending.current);
    const run = () => {
      const values: FilterValue[] = arity === 'list' ? splitList(next[0] ?? '') : arity === 'period' ? [Number(next[0]) || next[0], next[1] || 'days'] : next.slice(0, arity === 'two' ? 2 : 1);
      lastCommitted.current = values;
      onChange({ ...cond, values });
    };
    if (now) run();
    else pending.current = setTimeout(run, COMMIT_MS);
  };
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const setText = (i: number, v: string) => {
    const next = [...texts];
    next[i] = v;
    setTexts(next);
    commit(next);
  };

  const changeColumn = (idx: number) => {
    const c = columns[idx];
    const sameClass = kindClass(c.kind) === cls;
    const keepOp = sameClass && operatorsFor(c.kind).includes(cond.op);
    onChange({ ...cond, column: c.name, ordinal: idx, op: keepOp ? cond.op : defaultOperator(c.kind), values: keepOp && sameClass ? cond.values : [] });
  };

  const changeOp = (op: FilterCondition['op']) => {
    const a = arityOf(op);
    let values = cond.values;
    if (a === 'none') values = [];
    else if (a === 'period') values = [typeof values[0] === 'number' ? values[0] : 7, 'days'];
    else if (arity === 'period' || arity === 'none') values = [];
    else if (a === 'one' && values.length > 1) values = values.slice(0, 1);
    onChange({ ...cond, op, values });
  };

  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit(texts, true);
      if (!(e.ctrlKey && e.shiftKey)) onSubmit?.();
    }
  };

  const placeholder = (i: number) => {
    if (arity === 'list') return cls === 'number' ? '1, 2, 3' : 'a, b, c';
    if (cls === 'date') return i === 0 && arity === 'two' ? 'from YYYY-MM-DD' : arity === 'two' ? 'to YYYY-MM-DD' : 'YYYY-MM-DD [HH:MM]';
    if (cls === 'time') return 'HH:MM';
    if (arity === 'two') return i === 0 ? 'from' : 'to';
    return 'value';
  };

  const dateInput = (i: number) =>
    cls === 'date' && arity !== 'period' && arity !== 'list' ? (
      <DatePick value={texts[i] ?? ''} onPick={(d) => {
        const next = [...texts];
        next[i] = d;
        setTexts(next);
        commit(next, true);
      }} />
    ) : null;

  return (
    <div className={`fb-cond${cond.enabled === false ? ' disabled' : ''}${showProblem ? ' invalid' : ''}${draft ? ' draft' : ''}`} role="group" aria-label={`Condition on ${cond.column || 'column'}`}>
      <input
        type="checkbox"
        className="fb-check"
        checked={cond.enabled !== false}
        title="Enable condition"
        aria-label="Enable condition"
        onChange={(e) => onChange({ ...cond, enabled: e.target.checked })}
      />
      <Select
        triggerRef={firstRef}
        size="xs"
        className="fb-col"
        aria-label="Column"
        value={ci}
        placeholder={`${cond.column || 'column'} (missing)`}
        options={columns.map((c, i) => ({ value: i, label: c.name || `column${i + 1}`, hint: c.dbType || undefined }))}
        onChange={(i) => changeColumn(i)}
        menuMinWidth={200}
      />
      <Select
        size="xs"
        className="fb-op"
        aria-label="Operator"
        value={cond.op}
        options={(ops.includes(cond.op) ? ops : [cond.op, ...ops]).map((op) => ({ value: op, label: OPERATOR_INFO[op].label }))}
        onChange={(op) => changeOp(op)}
        searchable={false}
        menuMinWidth={160}
      />
      {arity === 'one' || arity === 'list' ? (
        <span className="fb-value">
          <input
            ref={valueRef}
            className="input xs"
            aria-label="Value"
            value={texts[0] ?? ''}
            placeholder={placeholder(0)}
            spellCheck={false}
            onChange={(e) => setText(0, e.target.value)}
            onBlur={() => commit(texts, true)}
            onKeyDown={keyDown}
          />
          {dateInput(0)}
        </span>
      ) : arity === 'two' ? (
        <span className="fb-value two">
          <input ref={valueRef} className="input xs" aria-label="From" value={texts[0] ?? ''} placeholder={placeholder(0)} spellCheck={false}
            onChange={(e) => setText(0, e.target.value)} onBlur={() => commit(texts, true)} onKeyDown={keyDown} />
          {dateInput(0)}
          <span className="fb-and">and</span>
          <input className="input xs" aria-label="To" value={texts[1] ?? ''} placeholder={placeholder(1)} spellCheck={false}
            onChange={(e) => setText(1, e.target.value)} onBlur={() => commit(texts, true)} onKeyDown={keyDown} />
          {dateInput(1)}
        </span>
      ) : arity === 'period' ? (
        <span className="fb-value period">
          <input ref={valueRef} className="input xs narrow" type="number" min={1} aria-label="Count" value={texts[0] ?? ''} onChange={(e) => setText(0, e.target.value)}
            onBlur={() => commit(texts, true)} onKeyDown={keyDown} />
          <Select
            size="xs"
            aria-label="Unit"
            value={texts[1] || 'days'}
            options={PERIOD_UNITS.map((u) => ({ value: u as string, label: u }))}
            onChange={(u) => {
              const next = [texts[0] ?? '7', u];
              setTexts(next);
              commit(next, true);
            }}
          />
        </span>
      ) : null}
      {cls === 'string' && arity !== 'none' && (
        <button
          className={`icon-btn xs fb-case${cond.caseSensitive ? ' on' : ''}`}
          title={cond.caseSensitive ? 'Case-sensitive (click for insensitive)' : 'Case-insensitive (click for case-sensitive)'}
          aria-label="Match case"
          aria-pressed={!!cond.caseSensitive}
          onClick={() => onChange({ ...cond, caseSensitive: !cond.caseSensitive })}
        >
          <CaseSensitive size={14} />
        </button>
      )}
      {serverMode && cond.op === 'regex' && <span className="fb-hint" title="Regular expressions are applied in the grid on top of the server result">in grid</span>}
      {showProblem && <span className="fb-problem" role="note">{problem}</span>}
      {draft && <span className="fb-hint fb-draft-hint" title="This condition is not applied until it is complete">incomplete</span>}
      <button className="icon-btn xs fb-remove" title="Remove condition" aria-label="Remove condition" onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

function toTexts(c: FilterCondition): string[] {
  const a = arityOf(c.op);
  if (a === 'list') return [listText(c.values)];
  if (a === 'period') return [c.values[0] === undefined ? '7' : String(c.values[0]), String(c.values[1] ?? 'days')];
  return c.values.map((v) => (v === null || v === undefined ? '' : String(v)));
}

/** Calendar button that opens the native date picker and writes YYYY-MM-DD. */
function DatePick({ value, onPick }: { value: string; onPick(d: string): void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="fb-date">
      <button
        type="button"
        className="icon-btn xs"
        title="Pick a date"
        aria-label="Pick a date"
        onClick={() => {
          const el = ref.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
          }
        }}
      >
        <CalendarDays size={13} />
      </button>
      <input
        ref={ref}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        className="fb-date-native"
        value={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ''}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      />
    </span>
  );
}

export const OPERATOR_LABEL = (op: FilterCondition['op']) => OPERATOR_INFO[op].label;

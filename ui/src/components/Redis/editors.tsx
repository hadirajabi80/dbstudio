// Value editors of the key browser (docs/PLAN-M2.md 5.3): string (code editor, JSON pretty, hex view for binary),
// hash and sorted set (pair tables with a pending buffer: edit, add, delete, Ctrl+S saves), list (paged by index,
// edit in place, push left/right, remove), set (members, add, remove), stream (entries newest first, add / delete
// entries, consumer groups with consumers, pending entries and ACK) and RedisJSON (JSON editor).
import { displayShortcut } from '../../commands/keys';
import { Check, ChevronDown, ChevronRight, Plus, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import type {
  RedisHashValue, RedisJsonValue, RedisKeyValue, RedisListValue, RedisSetValue, RedisStreamGroupDetail, RedisStreamValue, RedisStringValue,
  RedisZsetValue,
} from '../../api/types';
import { formatBytes, formatCount, formatScore, prettyJson } from '../../redis/format';
import { useUi } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { CodeEditor } from './CodeEditor';
import { errorText } from './store';

export interface EditorProps<V extends RedisKeyValue> {
  cid: string;
  db: number;
  value: V;
  readOnly: boolean;
  theme: EffectiveTheme;
  /** Re-reads the key (after a save). */
  reload: () => void;
  /** The editor's save action for Ctrl+S (null when nothing is pending). */
  registerSave: (save: (() => Promise<void>) | null) => void;
  onError: (message: string | null) => void;
}

const toast = (kind: 'success' | 'error' | 'info', text: string, detail?: string) => useUi.getState().toast(kind, text, detail);

function useSaver(registerSave: EditorProps<RedisKeyValue>['registerSave'], dirty: boolean, save: () => Promise<void>) {
  const ref = useRef(save);
  ref.current = save;
  useEffect(() => {
    registerSave(dirty ? () => ref.current() : null);
  }, [dirty, registerSave]);
  useEffect(() => () => registerSave(null), [registerSave]);
}

function PendingBar({ count, saving, onSave, onDiscard }: { count: number; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!count) return null;
  return (
    <div className="redis-pending" role="status">
      <span>{count} pending change{count === 1 ? '' : 's'}</span>
      <span className="flex-1" />
      <button className="btn btn-xs" onClick={onDiscard}><Undo2 size={13} /> Discard</button>
      <button className="btn btn-xs btn-primary" disabled={saving} onClick={onSave} title={`Save (${displayShortcut('Mod+S')})`}><Check size={13} /> Save</button>
    </div>
  );
}

/** An inline value cell: click or Enter edits; Enter commits, Shift+Enter breaks the line, Esc cancels. */
function EditableCell({ value, disabled, onCommit, label, mono = true, numeric }: { value: string; disabled: boolean; onCommit: (v: string) => void; label: string; mono?: boolean; numeric?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (editing && !disabled) {
    return (
      <textarea
        className={`input redis-cell-input ${mono ? 'mono' : ''}`}
        aria-label={`Edit ${label}`}
        dir={numeric ? undefined : 'auto'}
        autoFocus
        rows={Math.min(8, Math.max(1, draft.split('\n').length))}
        value={draft}
        inputMode={numeric ? 'decimal' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(value);
            setEditing(false);
          } else if (e.key === 'Enter' && !e.shiftKey && !(e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            setEditing(false);
            if (draft !== value) onCommit(draft);
          }
        }}
      />
    );
  }
  return (
    <div
      className={`redis-cell ${mono ? 'mono' : ''} ${disabled ? '' : 'editable'}`}
      dir={numeric ? undefined : 'auto'}
      tabIndex={disabled ? -1 : 0}
      role={disabled ? undefined : 'button'}
      aria-label={disabled ? undefined : `${label}: ${value}. Press Enter to edit`}
      title={disabled ? value : 'Click or Enter to edit'}
      onClick={() => !disabled && setEditing(true)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === 'F2')) {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }
      }}
    >
      {value === '' ? <span className="muted">(empty)</span> : value}
    </div>
  );
}

function FilterBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="input redis-filter"
      dir="auto"
      type="search"
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onChange(draft.trim());
        if (e.key === 'Escape' && draft) {
          e.stopPropagation();
          setDraft('');
          onChange('');
        }
      }}
      onBlur={() => draft.trim() !== value && onChange(draft.trim())}
    />
  );
}

const matchPattern = (q: string) => (!q ? undefined : /[*?[]/.test(q) ? q : `*${q}*`);

// ------------------------------------------------------------------------------------------------ string

export function StringEditor({ cid, db, value, readOnly, theme, reload, registerSave, onError }: EditorProps<RedisStringValue>) {
  const truncated = typeof value.value !== 'string';
  const text = typeof value.value === 'string' ? value.value : value.value.$trunc;
  const binary = value.encoding === 'hex';
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(text), [text]);
  const pretty = useMemo(() => (value.isJson ? prettyJson(draft) : null), [draft, value.isJson]);
  const dirty = draft !== text;
  const editable = !readOnly && !truncated && !binary;
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.redis.setString(cid, db, value.key, { value: draft });
      onError(null);
      toast('success', 'Value saved', value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [cid, db, value.key, draft, reload, onError]);
  useSaver(registerSave, dirty && editable, save);

  if (binary) {
    const bytes = text.match(/.{1,2}/g) ?? [];
    const rows: string[] = [];
    for (let i = 0; i < bytes.length && rows.length < 512; i += 16) rows.push(`${i.toString(16).padStart(8, '0')}  ${bytes.slice(i, i + 16).join(' ')}`);
    return (
      <div className="redis-editor">
        <div className="redis-editor-bar"><span className="pill pill-muted">Binary · hex · read-only</span><span className="muted">{formatBytes(value.length ?? bytes.length)}</span></div>
        <pre className="redis-hex mono" aria-label="Hex dump">{rows.join('\n')}</pre>
      </div>
    );
  }
  return (
    <div className="redis-editor redis-editor-string">
      <div className="redis-editor-bar">
        {value.isJson && <span className="pill">JSON</span>}
        {truncated && <span className="pill pill-warning">Showing the first {formatBytes(text.length)} of {formatBytes(value.length ?? (value.value as { len: number }).len)} · read-only</span>}
        <span className="muted">{formatBytes(value.length ?? text.length)}</span>
        <span className="flex-1" />
        {value.isJson && editable && (
          <button className="btn btn-xs" disabled={!pretty || pretty === draft} onClick={() => pretty && setDraft(pretty)} title="Reformat the JSON with indentation">Pretty</button>
        )}
        {value.isJson && editable && (
          <button className="btn btn-xs" onClick={() => { try { setDraft(JSON.stringify(JSON.parse(draft))); } catch { onError('The value is not valid JSON.'); } }} title="Compact the JSON to one line">Compact</button>
        )}
        {dirty && <button className="btn btn-xs" onClick={() => setDraft(text)}><Undo2 size={13} /> Revert</button>}
        {editable && <button className="btn btn-xs btn-primary" disabled={!dirty || saving} onClick={() => void save()} title={`Save (${displayShortcut('Mod+S')})`}><Check size={13} /> Save</button>}
      </div>
      <CodeEditor value={draft} onChange={setDraft} language={value.isJson ? 'json' : 'text'} theme={theme} ariaLabel={`Value of ${value.key}`}
        readOnly={!editable} onSave={() => void save()} wordWrap className="redis-value-code" />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ RedisJSON

export function JsonEditor({ cid, db, value, readOnly, theme, reload, registerSave, onError }: EditorProps<RedisJsonValue>) {
  const text = useMemo(() => JSON.stringify(value.json, null, 2), [value.json]);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(text), [text]);
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, v: JSON.parse(draft) as unknown };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [draft]);
  const dirty = draft !== text;
  const save = useCallback(async () => {
    if (!parsed.ok) {
      onError(`Not valid JSON: ${parsed.error}`);
      return;
    }
    setSaving(true);
    try {
      await api.redis.setJson(cid, db, value.key, { path: '$', value: parsed.v });
      onError(null);
      toast('success', 'Document saved', value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [cid, db, value.key, parsed, reload, onError]);
  useSaver(registerSave, dirty && !readOnly, save);
  return (
    <div className="redis-editor redis-editor-string">
      <div className="redis-editor-bar">
        <span className="pill">RedisJSON</span>
        <span className="muted mono">JSON.GET {value.path}</span>
        {!parsed.ok && <span className="text-warning" role="alert">Invalid JSON</span>}
        <span className="flex-1" />
        {dirty && <button className="btn btn-xs" onClick={() => setDraft(text)}><Undo2 size={13} /> Revert</button>}
        {!readOnly && <button className="btn btn-xs btn-primary" disabled={!dirty || saving || !parsed.ok} onClick={() => void save()} title={`Save with JSON.SET (${displayShortcut('Mod+S')})`}><Check size={13} /> Save</button>}
      </div>
      <CodeEditor value={draft} onChange={setDraft} language="json" theme={theme} ariaLabel={`Document ${value.key}`} readOnly={readOnly} onSave={() => void save()} className="redis-value-code" />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ hash / zset

interface PairRow { a: string; b: string; state: 'clean' | 'edited' | 'added' | 'deleted' }

function PairTable({ rows, labels, readOnly, numericB, onEdit, onDelete, onRestore }: {
  rows: PairRow[]; labels: [string, string]; readOnly: boolean; numericB?: boolean;
  onEdit: (a: string, b: string) => void; onDelete: (a: string) => void; onRestore: (a: string) => void;
}) {
  return (
    <table className="redis-table">
      <thead><tr><th style={{ width: '34%' }}>{labels[0]}</th><th>{labels[1]}</th>{!readOnly && <th className="redis-col-actions" aria-label="Actions" />}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.a} className={`redis-row-${r.state}`}>
            <td className="mono redis-cell-key" dir="auto" title={r.a}>{r.a}</td>
            <td><EditableCell value={r.b} label={`${labels[1]} of ${r.a}`} disabled={readOnly || r.state === 'deleted'} numeric={numericB} onCommit={(v) => onEdit(r.a, v)} /></td>
            {!readOnly && (
              <td className="redis-col-actions">
                {r.state === 'deleted'
                  ? <button className="icon-btn" aria-label={`Restore ${r.a}`} title="Restore" onClick={() => onRestore(r.a)}><Undo2 size={14} /></button>
                  : <button className="icon-btn" aria-label={`Delete ${r.a}`} title="Delete" onClick={() => onDelete(r.a)}><Trash2 size={14} /></button>}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddPair({ labels, numericB, onAdd }: { labels: [string, string]; numericB?: boolean; onAdd: (a: string, b: string) => string | null }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const add = () => {
    const e = onAdd(a, b);
    setErr(e);
    if (!e) {
      setA('');
      setB('');
      first.current?.focus();
    }
  };
  return (
    <div className="redis-add-row" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}>
      <input ref={first} className="input mono" dir="auto" aria-label={`New ${labels[0].toLowerCase()}`} placeholder={labels[0]} value={a} onChange={(e) => setA(e.target.value)} />
      <input className="input mono" dir={numericB ? undefined : 'auto'} aria-label={`New ${labels[1].toLowerCase()}`} placeholder={labels[1]} inputMode={numericB ? 'decimal' : undefined} value={b} onChange={(e) => setB(e.target.value)} />
      <button className="btn btn-xs" onClick={add}><Plus size={13} /> Add</button>
      {err && <span className="form-error" role="alert">{err}</span>}
    </div>
  );
}

function usePairs(initial: [string, string][]) {
  const [base, setBase] = useState(initial);
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [added, setAdded] = useState<[string, string][]>([]);
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const reset = (rows: [string, string][]) => {
    setBase(rows);
    setEdits(new Map());
    setAdded([]);
    setDeleted(new Set());
  };
  const rows: PairRow[] = [
    ...added.map(([a, b]) => ({ a, b, state: 'added' as const })),
    ...base.map(([a, b]) => ({ a, b: edits.get(a) ?? b, state: deleted.has(a) ? 'deleted' as const : edits.has(a) ? 'edited' as const : 'clean' as const })),
  ];
  const pending = edits.size + added.length + deleted.size;
  return {
    rows, pending, base, setBase, edits, added, deleted, reset,
    discard: () => { setEdits(new Map()); setAdded([]); setDeleted(new Set()); },
    edit: (a: string, b: string) => {
      if (added.some(([x]) => x === a)) setAdded(added.map(([x, y]) => (x === a ? [x, b] : [x, y])));
      else setEdits(new Map(edits).set(a, b));
    },
    remove: (a: string) => {
      if (added.some(([x]) => x === a)) setAdded(added.filter(([x]) => x !== a));
      else setDeleted(new Set(deleted).add(a));
    },
    restore: (a: string) => { const d = new Set(deleted); d.delete(a); setDeleted(d); },
    add: (a: string, b: string) => setAdded([[a, b], ...added]),
    has: (a: string) => base.some(([x]) => x === a) || added.some(([x]) => x === a),
  };
}

export function HashEditor({ cid, db, value, readOnly, reload, registerSave, onError }: EditorProps<RedisHashValue>) {
  const pairs = usePairs(value.fields.map((f) => [f.field, f.value]));
  const [cursor, setCursor] = useState(value.cursor);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const { reset } = pairs;
  // a reload of the key replaces the page set
  useEffect(() => {
    reset(value.fields.map((f) => [f.field, f.value]));
    setCursor(value.cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fetchPage = async (from: string, match: string, append: boolean) => {
    setLoading(true);
    try {
      const v = await api.redis.getKey(cid, value.key, { db, cursor: from, field: matchPattern(match), count: 200 }) as RedisHashValue;
      const rows = v.fields.map((f) => [f.field, f.value] as [string, string]);
      if (append) pairs.setBase([...pairs.base, ...rows.filter(([f]) => !pairs.base.some(([x]) => x === f))]);
      else pairs.reset(rows);
      setCursor(v.cursor);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const set: Record<string, string> = Object.fromEntries([...pairs.edits, ...pairs.added]);
      await api.redis.editHash(cid, db, value.key, { set: Object.keys(set).length ? set : undefined, del: pairs.deleted.size ? [...pairs.deleted] : undefined });
      onError(null);
      toast('success', `Saved ${pairs.pending} change${pairs.pending === 1 ? '' : 's'}`, value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [cid, db, value.key, pairs, reload, onError]);
  useSaver(registerSave, pairs.pending > 0 && !readOnly, save);

  return (
    <div className="redis-editor">
      <div className="redis-editor-bar">
        <FilterBox value={filter} onChange={(q) => { setFilter(q); void fetchPage('0', q, false); }} placeholder="Filter fields (HSCAN MATCH)" label="Filter fields" />
        <span className="muted">{formatCount(pairs.base.length)} of {formatCount(value.length)} fields</span>
      </div>
      {!readOnly && <AddPair labels={['Field', 'Value']} onAdd={(a, b) => (!a ? 'Enter a field name.' : pairs.has(a) ? `Field ${a} exists: edit its value instead.` : (pairs.add(a, b), null))} />}
      <PendingBar count={pairs.pending} saving={saving} onSave={() => void save()} onDiscard={pairs.discard} />
      <div className="redis-table-wrap">
        <PairTable rows={pairs.rows} labels={['Field', 'Value']} readOnly={readOnly} onEdit={pairs.edit} onDelete={pairs.remove} onRestore={pairs.restore} />
        {cursor !== '0' && <button className="link-btn redis-more" disabled={loading} onClick={() => void fetchPage(cursor, filter, true)}>{loading ? 'Loading…' : 'Load more fields'}</button>}
        {!pairs.rows.length && <div className="muted redis-empty">{filter ? 'No field matches.' : 'No fields.'}</div>}
      </div>
    </div>
  );
}

export function ZsetEditor({ cid, db, value, readOnly, reload, registerSave, onError }: EditorProps<RedisZsetValue>) {
  const toRows = (v: RedisZsetValue) => v.members.map((m) => [m.member, formatScore(m.score)] as [string, string]);
  const pairs = usePairs(toRows(value));
  const [cursor, setCursor] = useState(value.cursor);
  const [filter, setFilter] = useState('');
  const [desc, setDesc] = useState(false);
  const [saving, setSaving] = useState(false);
  const { reset } = pairs;
  useEffect(() => {
    reset(toRows(value));
    setCursor(value.cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fetchPage = async (from: string, match: string, append: boolean) => {
    try {
      const v = await api.redis.getKey(cid, value.key, { db, cursor: from, field: matchPattern(match), count: 200 }) as RedisZsetValue;
      if (append) pairs.setBase([...pairs.base, ...toRows(v)]);
      else pairs.reset(toRows(v));
      setCursor(v.cursor);
    } catch (e) {
      onError(errorText(e));
    }
  };
  const score = (s: string) => (s === '+inf' ? Number.MAX_VALUE : s === '-inf' ? -Number.MAX_VALUE : Number(s));
  const rows = useMemo(() => {
    const r = [...pairs.rows];
    r.sort((x, y) => (x.state === 'added' ? -1 : y.state === 'added' ? 1 : (score(x.b) - score(y.b)) * (desc ? -1 : 1)));
    return r;
  }, [pairs.rows, desc]);

  const save = useCallback(async () => {
    const add = [...pairs.edits, ...pairs.added].map(([member, s]) => ({ member, score: score(s) }));
    if (add.some((m) => !Number.isFinite(m.score))) {
      onError('Every score must be a number (or +inf / -inf).');
      return;
    }
    setSaving(true);
    try {
      await api.redis.editZset(cid, db, value.key, { add: add.length ? add : undefined, remove: pairs.deleted.size ? [...pairs.deleted] : undefined });
      onError(null);
      toast('success', 'Sorted set saved', value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [cid, db, value.key, pairs, reload, onError]);
  useSaver(registerSave, pairs.pending > 0 && !readOnly, save);

  return (
    <div className="redis-editor">
      <div className="redis-editor-bar">
        <FilterBox value={filter} onChange={(q) => { setFilter(q); void fetchPage('0', q, false); }} placeholder="Filter members (ZSCAN MATCH)" label="Filter members" />
        <button className="btn btn-xs" onClick={() => setDesc(!desc)} aria-pressed={desc} title="Sort by score">Score {desc ? '↓' : '↑'}</button>
        <span className="muted">{formatCount(pairs.base.length)} of {formatCount(value.length)} members</span>
      </div>
      {!readOnly && <AddPair labels={['Member', 'Score']} numericB onAdd={(a, b) => (!a ? 'Enter a member.' : !Number.isFinite(score(b)) || b.trim() === '' ? 'The score must be a number.' : (pairs.has(a) ? pairs.edit(a, b) : pairs.add(a, b), null))} />}
      <PendingBar count={pairs.pending} saving={saving} onSave={() => void save()} onDiscard={pairs.discard} />
      <div className="redis-table-wrap">
        <PairTable rows={rows} labels={['Member', 'Score']} numericB readOnly={readOnly} onEdit={pairs.edit} onDelete={pairs.remove} onRestore={pairs.restore} />
        {cursor !== '0' && <button className="link-btn redis-more" onClick={() => void fetchPage(cursor, filter, true)}>Load more members</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ list

export function ListEditor({ cid, db, value, readOnly, reload, onError }: EditorProps<RedisListValue>) {
  const [side, setSide] = useState<'left' | 'right'>('right');
  const [push, setPush] = useState('');
  const page = 200;
  const go = async (start: number) => {
    try {
      const v = await api.redis.getKey(cid, value.key, { db, start, stop: start + page - 1 });
      setView(v as RedisListValue);
    } catch (e) {
      onError(errorText(e));
    }
  };
  const [view, setView] = useState(value);
  useEffect(() => setView(value), [value]);
  const act = async (fn: () => Promise<void>, ok: string) => {
    try {
      await fn();
      onError(null);
      toast('success', ok, value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <div className="redis-editor">
      <div className="redis-editor-bar">
        <span className="muted">Items {formatCount(view.start)}–{formatCount(view.stop)} of {formatCount(view.length)}</span>
        <span className="flex-1" />
        <button className="btn btn-xs" disabled={view.start <= 0} onClick={() => void go(Math.max(0, view.start - page))}>‹ Previous</button>
        <button className="btn btn-xs" disabled={view.stop >= view.length - 1} onClick={() => void go(view.start + page)}>Next ›</button>
      </div>
      {!readOnly && (
        <div className="redis-add-row" onKeyDown={(e) => { if (e.key === 'Enter' && push) { e.preventDefault(); void act(() => api.redis.editList(cid, db, value.key, { push: { side, values: [push] } }), `Pushed to the ${side}`).then(() => setPush('')); } }}>
          <div className="segmented" role="group" aria-label="Push side">
            <button className={side === 'left' ? 'on' : ''} aria-pressed={side === 'left'} onClick={() => setSide('left')}>LPUSH</button>
            <button className={side === 'right' ? 'on' : ''} aria-pressed={side === 'right'} onClick={() => setSide('right')}>RPUSH</button>
          </div>
          <input className="input mono" dir="auto" aria-label="New element" placeholder="Element" value={push} onChange={(e) => setPush(e.target.value)} />
          <button className="btn btn-xs" disabled={!push} onClick={() => void act(() => api.redis.editList(cid, db, value.key, { push: { side, values: [push] } }), `Pushed to the ${side}`).then(() => setPush(''))}><Plus size={13} /> Push</button>
        </div>
      )}
      <div className="redis-table-wrap">
        <table className="redis-table">
          <thead><tr><th style={{ width: 80 }}>Index</th><th>Element</th>{!readOnly && <th className="redis-col-actions" aria-label="Actions" />}</tr></thead>
          <tbody>
            {view.items.map((it) => (
              <tr key={it.index}>
                <td className="mono muted">{it.index}</td>
                <td><EditableCell value={it.value} label={`element ${it.index}`} disabled={readOnly}
                  onCommit={(v) => void act(() => api.redis.editList(cid, db, value.key, { setIndex: { index: it.index, value: v } }), `Element ${it.index} saved (LSET)`)} /></td>
                {!readOnly && (
                  <td className="redis-col-actions">
                    <button className="icon-btn" aria-label={`Remove element ${it.index}`} title="Remove (LREM 1)"
                      onClick={() => void act(() => api.redis.editList(cid, db, value.key, { remove: { value: it.value, count: 1 } }), 'Element removed')}><Trash2 size={14} /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ set

export function SetEditor({ cid, db, value, readOnly, reload, registerSave, onError }: EditorProps<RedisSetValue>) {
  const [members, setMembers] = useState(value.members);
  const [cursor, setCursor] = useState(value.cursor);
  const [filter, setFilter] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setMembers(value.members);
    setCursor(value.cursor);
    setAdded([]);
    setRemoved(new Set());
  }, [value]);
  const fetchPage = async (from: string, match: string, append: boolean) => {
    try {
      const v = await api.redis.getKey(cid, value.key, { db, cursor: from, field: matchPattern(match), count: 200 }) as RedisSetValue;
      setMembers(append ? [...members, ...v.members.filter((m) => !members.includes(m))] : v.members);
      setCursor(v.cursor);
    } catch (e) {
      onError(errorText(e));
    }
  };
  const pending = added.length + removed.size;
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.redis.editSet(cid, db, value.key, { add: added.length ? added : undefined, remove: removed.size ? [...removed] : undefined });
      onError(null);
      toast('success', 'Set saved', value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [cid, db, value.key, added, removed, reload, onError]);
  useSaver(registerSave, pending > 0 && !readOnly, save);
  const add = () => {
    if (!draft || members.includes(draft) || added.includes(draft)) return;
    setAdded([draft, ...added]);
    setDraft('');
  };
  return (
    <div className="redis-editor">
      <div className="redis-editor-bar">
        <FilterBox value={filter} onChange={(q) => { setFilter(q); void fetchPage('0', q, false); }} placeholder="Filter members (SSCAN MATCH)" label="Filter members" />
        <span className="muted">{formatCount(members.length)} of {formatCount(value.length)} members</span>
      </div>
      {!readOnly && (
        <div className="redis-add-row" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}>
          <input className="input mono" dir="auto" aria-label="New member" placeholder="Member" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-xs" onClick={add}><Plus size={13} /> Add</button>
        </div>
      )}
      <PendingBar count={pending} saving={saving} onSave={() => void save()} onDiscard={() => { setAdded([]); setRemoved(new Set()); }} />
      <div className="redis-table-wrap">
        <table className="redis-table">
          <thead><tr><th>Member</th>{!readOnly && <th className="redis-col-actions" aria-label="Actions" />}</tr></thead>
          <tbody>
            {added.map((m) => (
              <tr key={`+${m}`} className="redis-row-added"><td className="mono" dir="auto">{m}</td>
                <td className="redis-col-actions"><button className="icon-btn" aria-label={`Remove ${m}`} onClick={() => setAdded(added.filter((x) => x !== m))}><X size={14} /></button></td></tr>
            ))}
            {members.map((m) => (
              <tr key={m} className={removed.has(m) ? 'redis-row-deleted' : ''}>
                <td className="mono" dir="auto">{m}</td>
                {!readOnly && (
                  <td className="redis-col-actions">
                    {removed.has(m)
                      ? <button className="icon-btn" aria-label={`Restore ${m}`} onClick={() => { const r = new Set(removed); r.delete(m); setRemoved(r); }}><Undo2 size={14} /></button>
                      : <button className="icon-btn" aria-label={`Delete ${m}`} onClick={() => setRemoved(new Set(removed).add(m))}><Trash2 size={14} /></button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {cursor !== '0' && <button className="link-btn redis-more" onClick={() => void fetchPage(cursor, filter, true)}>Load more members</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ stream

function relTime(id: string): string {
  const ms = Number(id.split('-')[0]);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('en-GB', { hour12: false }) : '';
}

function GroupRow({ cid, db, keyName, group, readOnly, onChanged, onError }: {
  cid: string; db: number; keyName: string; group: RedisStreamValue['groups'][number]; readOnly: boolean; onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RedisStreamGroupDetail | null>(null);
  const load = useCallback(async () => {
    try {
      setDetail(await api.redis.streamGroup(cid, db, keyName, group.name));
    } catch (e) {
      onError(errorText(e));
    }
  }, [cid, db, keyName, group.name, onError]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const ack = async (ids: string[]) => {
    try {
      await api.redis.editStream(cid, db, keyName, { ack: { group: group.name, ids } });
      toast('success', `Acknowledged ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}`, group.name);
      await load();
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  };
  const destroy = async () => {
    const ok = await useUi.getState().askConfirm({
      title: 'Destroy consumer group', danger: true, confirmLabel: 'Destroy group',
      message: `XGROUP DESTROY removes the group ${group.name} with its ${group.consumers} consumer(s) and ${group.pending} pending entr${group.pending === 1 ? 'y' : 'ies'}.`,
    });
    if (!ok) return;
    try {
      await api.redis.editStream(cid, db, keyName, { groupDestroy: group.name });
      toast('success', `Destroyed group ${group.name}`);
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <>
      <tr>
        <td>
          <button className="link-btn redis-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {group.name}
          </button>
        </td>
        <td className="tabular">{group.consumers}</td>
        <td className={`tabular ${group.pending ? 'text-warning' : ''}`}>{group.pending}</td>
        <td className="mono">{group.lastDeliveredId}</td>
        <td className="tabular">{group.lag ?? '–'}</td>
        {!readOnly && <td className="redis-col-actions"><button className="icon-btn" aria-label={`Destroy group ${group.name}`} title="Destroy group" onClick={() => void destroy()}><Trash2 size={14} /></button></td>}
      </tr>
      {open && (
        <tr className="redis-group-detail">
          <td colSpan={readOnly ? 5 : 6}>
            {!detail ? <span className="muted">Loading…</span> : (
              <div className="redis-group-grid">
                <section>
                  <h4>Consumers</h4>
                  {detail.consumers.length ? (
                    <table className="redis-table compact">
                      <thead><tr><th>Name</th><th>Pending</th><th>Idle</th></tr></thead>
                      <tbody>{detail.consumers.map((c) => <tr key={c.name}><td className="mono">{c.name}</td><td className="tabular">{c.pending}</td><td className="tabular">{Math.round(c.idleMs / 1000)}s</td></tr>)}</tbody>
                    </table>
                  ) : <p className="muted">No consumers yet.</p>}
                </section>
                <section>
                  <h4>Pending entries {detail.pending.length ? `(${detail.pending.length})` : ''}</h4>
                  {detail.pending.length ? (
                    <table className="redis-table compact">
                      <thead><tr><th>ID</th><th>Consumer</th><th>Idle</th><th>Deliveries</th>{!readOnly && <th />}</tr></thead>
                      <tbody>{detail.pending.map((p) => (
                        <tr key={p.id}><td className="mono">{p.id}</td><td className="mono">{p.consumer}</td><td className="tabular">{Math.round(p.idleMs / 1000)}s</td><td className="tabular">{p.deliveries}</td>
                          {!readOnly && <td><button className="btn btn-xs" onClick={() => void ack([p.id])}>ACK</button></td>}</tr>
                      ))}</tbody>
                    </table>
                  ) : <p className="muted">Nothing pending.</p>}
                  {!readOnly && detail.pending.length > 1 && <button className="btn btn-xs" onClick={() => void ack(detail.pending.map((p) => p.id))}>ACK all shown</button>}
                </section>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function StreamEditor({ cid, db, value, readOnly, reload, onError }: EditorProps<RedisStreamValue>) {
  const [entries, setEntries] = useState(value.entries);
  const [tab, setTab] = useState<'entries' | 'groups'>('entries');
  const [fields, setFields] = useState<[string, string][]>([['', '']]);
  const [newGroup, setNewGroup] = useState({ name: '', id: '$' });
  useEffect(() => setEntries(value.entries), [value.entries]);
  const columns = useMemo(() => [...new Set(entries.flatMap((e) => Object.keys(e.fields)))].slice(0, 12), [entries]);
  const older = async () => {
    const last = entries.at(-1);
    if (!last) return;
    try {
      const v = await api.redis.getKey(cid, value.key, { db, stop: `(${last.id}`, count: 100 }) as RedisStreamValue;
      setEntries([...entries, ...v.entries]);
    } catch (e) {
      onError(errorText(e));
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      onError(null);
      toast('success', ok, value.key);
      reload();
    } catch (e) {
      onError(errorText(e));
    }
  };
  const addEntry = () => {
    const f = Object.fromEntries(fields.filter(([k]) => k));
    if (!Object.keys(f).length) return onError('Add at least one field.');
    void act(() => api.redis.editStream(cid, db, value.key, { add: f }), 'Entry added (XADD)').then(() => setFields([['', '']]));
  };
  const hasMore = entries.length < value.length && entries.at(-1)?.id !== value.firstId;
  return (
    <div className="redis-editor">
      <div className="redis-editor-bar">
        <div className="segmented" role="tablist" aria-label="Stream view">
          <button role="tab" aria-selected={tab === 'entries'} className={tab === 'entries' ? 'on' : ''} onClick={() => setTab('entries')}>Entries ({formatCount(value.length)})</button>
          <button role="tab" aria-selected={tab === 'groups'} className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>Consumer groups ({value.groups.length})</button>
        </div>
        <span className="muted mono">{value.firstId ?? '–'} … {value.lastId ?? '–'}</span>
      </div>
      {tab === 'entries' ? (
        <>
          {!readOnly && (
            <div className="redis-add-row redis-stream-add">
              {fields.map(([k, v], i) => (
                <span key={i} className="redis-pair">
                  <input className="input mono" dir="auto" aria-label={`Entry field ${i + 1}`} placeholder="field" value={k} onChange={(e) => setFields(fields.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
                  <input className="input mono" dir="auto" aria-label={`Entry value ${i + 1}`} placeholder="value" value={v} onChange={(e) => setFields(fields.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } }} />
                </span>
              ))}
              <button className="icon-btn" aria-label="Add field" title="Add field" onClick={() => setFields([...fields, ['', '']])}><Plus size={14} /></button>
              <button className="btn btn-xs" onClick={addEntry}>XADD *</button>
            </div>
          )}
          <div className="redis-table-wrap">
            <table className="redis-table">
              <thead><tr><th>ID</th>{columns.map((c) => <th key={c} className="mono">{c}</th>)}{!readOnly && <th className="redis-col-actions" aria-label="Actions" />}</tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono" title={relTime(e.id)}>{e.id}</td>
                    {columns.map((c) => <td key={c} className="mono redis-cell-clip" dir="auto" title={e.fields[c]}>{e.fields[c] ?? ''}</td>)}
                    {!readOnly && (
                      <td className="redis-col-actions">
                        <button className="icon-btn" aria-label={`Delete entry ${e.id}`} title="XDEL"
                          onClick={() => void act(() => api.redis.editStream(cid, db, value.key, { delete: [e.id] }), `Deleted ${e.id}`)}><Trash2 size={14} /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {hasMore && <button className="link-btn redis-more" onClick={() => void older()}>Load older entries</button>}
            {!entries.length && <div className="muted redis-empty">The stream has no entries.</div>}
          </div>
        </>
      ) : (
        <div className="redis-table-wrap">
          {!readOnly && (
            <div className="redis-add-row">
              <input className="input mono" dir="auto" aria-label="New group name" placeholder="group name" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
              <input className="input mono" aria-label="Start ID" title="$ = only new entries, 0 = from the beginning" value={newGroup.id} onChange={(e) => setNewGroup({ ...newGroup, id: e.target.value })} />
              <button className="btn btn-xs" disabled={!newGroup.name}
                onClick={() => void act(() => api.redis.editStream(cid, db, value.key, { groupCreate: { name: newGroup.name, id: newGroup.id || '$' } }), `Created group ${newGroup.name}`).then(() => setNewGroup({ name: '', id: '$' }))}>
                <Plus size={13} /> Create group
              </button>
            </div>
          )}
          <table className="redis-table">
            <thead><tr><th>Group</th><th>Consumers</th><th>Pending</th><th>Last delivered</th><th>Lag</th>{!readOnly && <th className="redis-col-actions" aria-label="Actions" />}</tr></thead>
            <tbody>
              {value.groups.map((g) => <GroupRow key={g.name} cid={cid} db={db} keyName={value.key} group={g} readOnly={readOnly} onChanged={reload} onError={onError} />)}
            </tbody>
          </table>
          {!value.groups.length && <div className="muted redis-empty">No consumer groups.</div>}
        </div>
      )}
    </div>
  );
}

export function ValueEditor(props: EditorProps<RedisKeyValue>): ReactNode {
  const v = props.value;
  switch (v.type) {
    case 'string': return <StringEditor {...props} value={v} />;
    case 'hash': return <HashEditor {...props} value={v} />;
    case 'list': return <ListEditor {...props} value={v} />;
    case 'set': return <SetEditor {...props} value={v} />;
    case 'zset': return <ZsetEditor {...props} value={v} />;
    case 'stream': return <StreamEditor {...props} value={v} />;
    case 'rejson': return <JsonEditor {...props} value={v} />;
    default: return null;
  }
}

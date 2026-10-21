// Redis dialogs (docs/PLAN-M2.md 5.2, 5.3): new key (every type), rename, TTL, delete keys matching a pattern (job
// with progress and cancel; the user types the number of keys), flush database (typed confirmation).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { engineSocket } from '../../api/ws';
import type { RedisCreateKeyRequest, RedisKeyType } from '../../api/types';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { formatCount, formatTtl, parseDuration, TYPE_LABEL } from '../../redis/format';
import { errorText } from './store';
import './redis.css';

const CREATE_TYPES: RedisKeyType[] = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'rejson'];

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/** Rows editor of field/value (hash, stream entry) or member/score (zset) pairs. */
function PairsInput({ rows, onChange, labels, numericSecond }: { rows: [string, string][]; onChange: (r: [string, string][]) => void; labels: [string, string]; numericSecond?: boolean }) {
  return (
    <div className="redis-pairs">
      {rows.map(([a, b], i) => (
        <div className="redis-pair" key={i}>
          <input className="input mono" aria-label={`${labels[0]} ${i + 1}`} placeholder={labels[0]} value={a} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input className="input mono" aria-label={`${labels[1]} ${i + 1}`} placeholder={labels[1]} inputMode={numericSecond ? 'decimal' : undefined} value={b}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button type="button" className="icon-btn" aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1} onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="link-btn" onClick={() => onChange([...rows, ['', '']])}>+ Add row</button>
    </div>
  );
}

export function NewKeyDialog({ cid, db, initialPrefix = '', onClose, onCreated }: { cid: string; db: number; initialPrefix?: string; onClose: () => void; onCreated: (key: string) => void }) {
  const [key, setKey] = useState(initialPrefix);
  const [type, setType] = useState<RedisKeyType>('string');
  const [ttl, setTtl] = useState('');
  const [value, setValue] = useState('');
  const [pairs, setPairs] = useState<[string, string][]>([['', '']]);
  const [items, setItems] = useState('');
  const { busy, error, run, setError } = useBusy();

  const submit = () => run(async () => {
    if (!key) throw new Error('Enter a key name.');
    const seconds = ttl.trim() ? parseDuration(ttl) : null;
    if (ttl.trim() && seconds === null) throw new Error('TTL must be a duration such as 90, 15m, 2h or 1d.');
    const lines = items.split('\n').map((x) => x.trim()).filter(Boolean);
    const filled = pairs.filter(([a]) => a !== '');
    const base = { key, db, ttl: seconds };
    let req: RedisCreateKeyRequest;
    switch (type) {
      case 'string': req = { ...base, type, value }; break;
      case 'hash': req = { ...base, type, fields: Object.fromEntries(filled) }; break;
      case 'stream': req = { ...base, type, fields: Object.fromEntries(filled) }; break;
      case 'list': req = { ...base, type, values: lines }; break;
      case 'set': req = { ...base, type, members: lines }; break;
      case 'zset': {
        const members = filled.map(([member, score]) => ({ member, score: Number(score) }));
        if (members.some((m) => !Number.isFinite(m.score))) throw new Error('Every score must be a number.');
        req = { ...base, type, members };
        break;
      }
      case 'rejson': {
        let json: unknown;
        try {
          json = JSON.parse(value || '{}');
        } catch {
          throw new Error('The document is not valid JSON.');
        }
        req = { ...base, type, json };
        break;
      }
      default: throw new Error('Pick a type.');
    }
    if ((type === 'hash' || type === 'stream' || type === 'zset') && !filled.length) throw new Error('Add at least one row.');
    if ((type === 'list' || type === 'set') && !lines.length) throw new Error('Add at least one element (one per line).');
    await api.redis.createKey(cid, req);
    onCreated(key);
    onClose();
  });

  return (
    <Dialog title={`New key · db${db}`} onClose={onClose} width={560} onSubmit={type === 'string' || type === 'rejson' ? undefined : () => void submit()}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>Add key</button>
      </>}>
      <div className="form-grid redis-form">
        <label className="form-label" htmlFor="redis-new-key">Key</label>
        <input id="redis-new-key" className="input mono" value={key} onChange={(e) => { setKey(e.target.value); setError(null); }} placeholder="user:1001:profile" />
        <label className="form-label" id="redis-new-type">Type</label>
        <Select aria-labelledby="redis-new-type" value={type} onChange={(v) => setType(v as RedisKeyType)}
          options={CREATE_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        <label className="form-label" htmlFor="redis-new-ttl">TTL</label>
        <input id="redis-new-ttl" className="input" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="none (e.g. 3600, 15m, 1d)" />
        {(type === 'string' || type === 'rejson') && (
          <>
            <label className="form-label" htmlFor="redis-new-value">{type === 'rejson' ? 'Document' : 'Value'}</label>
            <textarea id="redis-new-value" className="input mono redis-textarea" rows={6} value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={type === 'rejson' ? '{ "name": "Widget" }' : ''} spellCheck={false} />
          </>
        )}
        {(type === 'hash' || type === 'stream' || type === 'zset') && (
          <>
            <span className="form-label">{type === 'zset' ? 'Members' : type === 'stream' ? 'First entry' : 'Fields'}</span>
            <PairsInput rows={pairs} onChange={setPairs} labels={type === 'zset' ? ['Member', 'Score'] : ['Field', 'Value']} numericSecond={type === 'zset'} />
          </>
        )}
        {(type === 'list' || type === 'set') && (
          <>
            <label className="form-label" htmlFor="redis-new-items">{type === 'list' ? 'Elements' : 'Members'}</label>
            <textarea id="redis-new-items" className="input mono redis-textarea" rows={6} value={items} onChange={(e) => setItems(e.target.value)} placeholder="one per line" spellCheck={false} />
          </>
        )}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Dialog>
  );
}

export function RenameKeyDialog({ cid, db, keyName, onClose, onRenamed }: { cid: string; db: number; keyName: string; onClose: () => void; onRenamed: (key: string) => void }) {
  const [name, setName] = useState(keyName);
  const [overwrite, setOverwrite] = useState(false);
  const { busy, error, run } = useBusy();
  const submit = () => run(async () => {
    if (!name || name === keyName) throw new Error('Enter a new name.');
    await api.redis.renameKey(cid, db, keyName, { newKey: name, overwrite });
    onRenamed(name);
    onClose();
  });
  return (
    <Dialog title="Rename key" onClose={onClose} onSubmit={() => void submit()}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>Rename</button></>}>
      <div className="form-grid redis-form">
        <label className="form-label" htmlFor="redis-rename">New name</label>
        <input id="redis-rename" className="input mono" value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        <span />
        <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite an existing key (RENAME instead of RENAMENX)</label>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Dialog>
  );
}

const TTL_PRESETS: [string, number][] = [['1 min', 60], ['1 hour', 3600], ['1 day', 86_400], ['1 week', 604_800]];

export function TtlDialog({ cid, db, keyName, ttl, onClose, onSaved }: { cid: string; db: number; keyName: string; ttl: number; onClose: () => void; onSaved: (ttl: number) => void }) {
  const [text, setText] = useState(ttl > 0 ? String(ttl) : '');
  const { busy, error, run } = useBusy();
  const save = (seconds: number | null) => run(async () => {
    await api.redis.setTtl(cid, db, keyName, { seconds });
    onSaved(seconds ?? -1);
    onClose();
  });
  const submit = () => {
    const s = parseDuration(text);
    if (s === null) return void run(async () => { throw new Error('Enter a duration such as 90, 15m, 2h or 1d.'); });
    void save(s);
  };
  return (
    <Dialog title="Set TTL" onClose={onClose} onSubmit={submit}
      footer={<>
        <button className="btn" disabled={busy || ttl < 0} onClick={() => void save(null)} title="PERSIST">Remove TTL</button>
        <span className="flex-1" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>Set TTL</button>
      </>}>
      <p className="muted redis-dialog-key"><code>{keyName}</code> · {ttl >= 0 ? `expires in ${formatTtl(ttl)}` : 'no expiry'}</p>
      <div className="form-grid redis-form">
        <label className="form-label" htmlFor="redis-ttl">Expire in</label>
        <input id="redis-ttl" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="seconds, or 15m, 2h, 1d" />
        <span />
        <div className="chip-row">
          {TTL_PRESETS.map(([label, s]) => <button key={label} type="button" className="chip" onClick={() => setText(String(s))}>{label}</button>)}
        </div>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Dialog>
  );
}

/**
 * Delete keys matching a pattern: counts the matches first (SCAN), asks the user to type that count, then runs the
 * delete-pattern job with progress and Cancel.
 */
export function DeletePatternDialog({ cid, db, pattern: initial, onClose, onDone }: { cid: string; db: number; pattern: string; onClose: () => void; onDone: (deleted: number) => void }) {
  const [pattern, setPattern] = useState(initial);
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [typed, setTyped] = useState('');
  const [job, setJob] = useState<{ id: string; done: number; total: number | null; message: string | null } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const { error, run, setError } = useBusy();
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => offRef.current?.(), []);

  const countMatches = () => run(async () => {
    setCounting(true);
    setCount(null);
    setTyped('');
    try {
      let cursor = '0';
      let n = 0;
      do {
        const r = await api.redis.scan(cid, { db, pattern, cursor, count: 1000 });
        n += r.keys.length;
        cursor = r.cursor;
      } while (cursor !== '0' && n < 1_000_000);
      setCount(n);
    } finally {
      setCounting(false);
    }
  });
  useEffect(() => {
    void countMatches();
    // count once for the initial pattern
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const armed = count !== null && count > 0 && typed.replace(/[,\s]/g, '') === String(count) && !job;
  const start = () => run(async () => {
    const { jobId } = await api.redis.deletePattern(cid, { db, pattern });
    setJob({ id: jobId, done: 0, total: count, message: null });
    offRef.current = engineSocket.onJob(jobId, (ev) => {
      if (ev.type === 'job.progress') setJob((j) => (j ? { ...j, done: ev.done, total: ev.total ?? j.total, message: ev.message } : j));
      else {
        offRef.current?.();
        if (ev.status === 'ok') {
          const deleted = (ev.result as { deleted?: number } | null)?.deleted ?? 0;
          setResult(`Deleted ${formatCount(deleted)} keys.`);
          onDone(deleted);
        } else if (ev.status === 'cancelled') setResult('Cancelled: keys deleted so far stay deleted.');
        else setError(ev.error ?? 'The job failed.');
        setJob(null);
      }
    });
  });
  const pct = job?.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <Dialog title="Delete keys matching a pattern" onClose={onClose} width={520} className="confirm-danger"
      footer={<>
        {job ? <button className="btn" onClick={() => void api.cancelJob(job.id)}>Cancel job</button> : <button className="btn" data-autofocus onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>}
        {!result && <button className={armed ? 'btn btn-danger' : 'btn btn-danger-outline'} disabled={!armed} onClick={() => void start()}>Delete {count !== null ? formatCount(count) : ''} keys</button>}
      </>}>
      <div className="form-grid redis-form">
        <label className="form-label" htmlFor="redis-dp-pattern">Pattern</label>
        <div className="redis-row">
          <input id="redis-dp-pattern" className="input mono flex-1" value={pattern} disabled={!!job} onChange={(e) => { setPattern(e.target.value); setCount(null); }} />
          <button className="btn" disabled={counting || !!job || !pattern} onClick={() => void countMatches()}>Count</button>
        </div>
      </div>
      <p className="confirm-message" role="status">
        {counting ? 'Counting matching keys…' : count === null ? 'Count the matching keys first.' : count === 0 ? 'No key matches this pattern.'
          : <>This permanently deletes <b>{formatCount(count)}</b> key{count === 1 ? '' : 's'} from db{db} (SCAN + UNLINK). Type <b>{count}</b> to confirm.</>}
      </p>
      {count !== null && count > 0 && !job && !result && (
        <input className="input" aria-label="Type the number of keys to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={String(count)} />
      )}
      {job && (
        <div className="redis-progress" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label="Delete progress">
          <div className="redis-progress-bar" style={{ width: `${pct ?? 5}%` }} />
          <span className="muted">{job.message ?? 'Starting…'}</span>
        </div>
      )}
      {result && <p className="text-accent" role="status">{result}</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </Dialog>
  );
}

export function FlushDbDialog({ cid, db, keys, onClose, onDone }: { cid: string; db: number; keys: number | null; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useBusy();
  const name = `db${db}`;
  const submit = () => run(async () => {
    const r = await api.redis.commands(cid, { db, raw: ['FLUSHDB'] });
    const first = r.results[0];
    if (!first?.ok) throw new Error(String(first?.value ?? 'FLUSHDB failed'));
    onDone();
    onClose();
  });
  return (
    <Dialog title={`Flush ${name}`} onClose={onClose} className="confirm-danger"
      footer={<><button className="btn" data-autofocus onClick={onClose}>Cancel</button>
        <button className={typed === name ? 'btn btn-danger' : 'btn btn-danger-outline'} disabled={typed !== name || busy} onClick={() => void submit()}>Flush database</button></>}>
      <p className="confirm-message">FLUSHDB removes every key of {name}{keys !== null ? ` (${formatCount(keys)} keys)` : ''}. This cannot be undone. Type <b>{name}</b> to confirm.</p>
      <input className="input mono" aria-label="Type the database name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} />
      {error && <div className="form-error" role="alert">{error}</div>}
    </Dialog>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return useMemo(() => v, [v]);
}

// Kafka dialogs (docs/PLAN-M2.md 7.3, 7.5): create topic, add partitions, typed confirmations (delete / purge topic,
// delete group), offset reset with a dry-run preview and typed confirmation, schema viewer.
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, isApiError } from '../../api/client';
import type { KafkaOffsetResetRequest, KafkaOffsetResetRow, KafkaSchemaVersion } from '../../api/types';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { formatCount, fromLocalInput, toLocalInput } from './format';
import './kafka.css';

function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="form-error kafka-dialog-error" role="alert">{error}</div> : null;
}

// ---------------------------------------------------------------- create topic

/** Parses `key=value` lines (blank lines and `#` comments ignored). */
export function parseConfigLines(text: string): { configs: Record<string, string>; error: string | null } {
  const configs: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { configs, error: `Line ${i + 1}: use name=value` };
    configs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { configs, error: null };
}

export function CreateTopicDialog({ cid, brokers, onClose, onCreated }: { cid: string; brokers: number; onClose(): void; onCreated(name: string): void }) {
  const [name, setName] = useState('');
  const [partitions, setPartitions] = useState('3');
  const [rf, setRf] = useState(String(Math.min(3, Math.max(1, brokers))));
  const [configs, setConfigs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = /^[A-Za-z0-9._-]{1,249}$/.test(name) && name !== '.' && name !== '..';
  const submit = async () => {
    const parsed = parseConfigLines(configs);
    if (parsed.error) return setError(parsed.error);
    if (!nameOk) return setError('Topic names use letters, digits, ".", "_" and "-".');
    setBusy(true);
    setError(null);
    try {
      await api.kafka.createTopic(cid, { name, partitions: Number(partitions) || 1, replicationFactor: Number(rf) || 1, configs: parsed.configs });
      onCreated(name);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Create topic" onClose={onClose} onSubmit={() => void submit()} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !nameOk} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create'}</button>
      </>
    }>
      <div className="form-grid">
        <label className="form-label" htmlFor="kf-new-name">Name<span className="req">*</span></label>
        <input id="kf-new-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" aria-invalid={!!name && !nameOk} />
        <label className="form-label" htmlFor="kf-new-parts">Partitions</label>
        <input id="kf-new-parts" className="input" inputMode="numeric" value={partitions} onChange={(e) => setPartitions(e.target.value.replace(/\D/g, ''))} />
        <label className="form-label" htmlFor="kf-new-rf">Replication factor</label>
        <input id="kf-new-rf" className="input" inputMode="numeric" value={rf} onChange={(e) => setRf(e.target.value.replace(/\D/g, ''))} />
        <label className="form-label" htmlFor="kf-new-configs">Configs</label>
        <textarea id="kf-new-configs" className="input kafka-textarea" rows={4} value={configs} onChange={(e) => setConfigs(e.target.value)}
          placeholder={'cleanup.policy=compact\nretention.ms=604800000'} />
      </div>
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- add partitions

export function AddPartitionsDialog({ cid, topic, current, onClose, onDone }: { cid: string; topic: string; current: number; onClose(): void; onDone(): void }) {
  const [count, setCount] = useState(String(current + 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(count);
  const ok = Number.isInteger(n) && n > current;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await api.kafka.addPartitions(cid, topic, { count: n });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Add partitions to ${topic}`} onClose={onClose} onSubmit={() => void submit()} width={440} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !ok} onClick={() => void submit()}>Add partitions</button>
      </>
    }>
      <p className="muted">The topic has {current} partition{current === 1 ? '' : 's'}. Partitions cannot be removed later, and keyed messages may map to
        different partitions afterwards.</p>
      <div className="form-grid">
        <label className="form-label" htmlFor="kf-parts">New total</label>
        <input id="kf-parts" className="input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} aria-invalid={!ok} />
      </div>
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- typed confirmation

export function TypedConfirmDialog({ title, message, name, action, onClose, onConfirm }: {
  title: string; message: string; name: string; action: string; onClose(): void; onConfirm(): Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed === name;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} onSubmit={() => void submit()} width={460} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={!ok || busy} onClick={() => void submit()}>{busy ? 'Working…' : action}</button>
      </>
    }>
      <p className="confirm-message">{message}</p>
      <label className="kafka-typed">
        <span>Type <code className="mono">{name}</code> to confirm</span>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Type ${name} to confirm`} />
      </label>
      <ErrorLine error={error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- offset reset

type ResetKind = KafkaOffsetResetRequest['to']['kind'];
const RESET_KINDS: { value: ResetKind; label: string }[] = [
  { value: 'earliest', label: 'Earliest' }, { value: 'latest', label: 'Latest' }, { value: 'offset', label: 'Specific offset' },
  { value: 'timestamp', label: 'Timestamp' }, { value: 'shiftBy', label: 'Shift by' },
];

export function ResetOffsetsDialog({ cid, groupId, topics, readOnly, onClose, onApplied }: {
  cid: string; groupId: string; topics: string[]; readOnly: boolean; onClose(): void; onApplied(): void;
}) {
  const [topic, setTopic] = useState<string>(topics.length === 1 ? topics[0] : '');
  const [kind, setKind] = useState<ResetKind>('earliest');
  const [value, setValue] = useState('');
  const [when, setWhen] = useState(toLocalInput(new Date(Date.now() - 3600_000).toISOString()));
  const [rows, setRows] = useState<KafkaOffsetResetRow[] | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<{ clientId: string; host: string }[] | null>(null);

  useEffect(() => setRows(null), [topic, kind, value, when]);

  const request = (dryRun: boolean): KafkaOffsetResetRequest | string => {
    const to: KafkaOffsetResetRequest['to'] = { kind };
    if (kind === 'offset' || kind === 'shiftBy') {
      const n = Number(value);
      if (value.trim() === '' || !Number.isInteger(n) || (kind === 'offset' && n < 0)) return kind === 'offset' ? 'Enter an offset ≥ 0.' : 'Enter a whole number (negative rewinds).';
      to.value = n;
    } else if (kind === 'timestamp') {
      const iso = fromLocalInput(when);
      if (!iso) return 'Enter a date and time.';
      to.value = iso;
    }
    return { ...(topic ? { topic } : {}), to, dryRun };
  };

  const run = async (dryRun: boolean) => {
    const req = request(dryRun);
    if (typeof req === 'string') return setError(req);
    setBusy(true);
    setError(null);
    setActive(null);
    try {
      const r = await api.kafka.resetOffsets(cid, groupId, req);
      if (dryRun) setRows(r);
      else {
        onApplied();
        onClose();
      }
    } catch (e) {
      setError(errorMessage(e));
      if (isApiError(e, 'GROUP_ACTIVE')) {
        const members = (e.detail as { members?: { clientId: string; host: string }[] } | undefined)?.members;
        setActive(members ?? []);
      }
    } finally {
      setBusy(false);
    }
  };

  const total = useMemo(() => rows?.reduce((s, r) => s + (r.to - (r.from ?? r.to)), 0) ?? 0, [rows]);
  const topicOptions = [{ value: '', label: 'All committed partitions' }, ...topics.map((t) => ({ value: t, label: t }))];

  return (
    <Dialog title={`Reset offsets · ${groupId}`} onClose={onClose} width={640} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(true)}>{busy && !rows ? 'Previewing…' : 'Preview (dry run)'}</button>
        <button type="button" className="btn btn-danger" disabled={busy || !rows || typed !== groupId || readOnly}
          title={readOnly ? 'The connection is read-only' : !rows ? 'Preview first' : typed !== groupId ? 'Type the group id to confirm' : undefined}
          onClick={() => void run(false)}>Apply</button>
      </>
    }>
      <div className="form-grid">
        <span className="form-label">Topic</span>
        <Select aria-label="Topic" value={topic} options={topicOptions} onChange={setTopic} />
        <span className="form-label">Reset to</span>
        <Select aria-label="Reset to" value={kind} options={RESET_KINDS} onChange={(v) => setKind(v)} />
        {(kind === 'offset' || kind === 'shiftBy') && (
          <>
            <label className="form-label" htmlFor="kf-reset-value">{kind === 'offset' ? 'Offset' : 'Shift by'}</label>
            <input id="kf-reset-value" className="input" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d-]/g, ''))}
              placeholder={kind === 'offset' ? '0' : '-100'} />
          </>
        )}
        {kind === 'timestamp' && (
          <>
            <label className="form-label" htmlFor="kf-reset-ts">Timestamp</label>
            <input id="kf-reset-ts" type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} />
          </>
        )}
      </div>
      <ErrorLine error={error} />
      {active && active.length > 0 && (
        <ul className="kafka-members-list" aria-label="Active members">
          {active.map((m, i) => <li key={i}><span className="mono">{m.clientId}</span> <span className="muted">{m.host}</span></li>)}
        </ul>
      )}
      {rows && (
        <>
          <div className="kafka-preview-head">
            Dry run: {rows.length} partition{rows.length === 1 ? '' : 's'}, {total >= 0 ? '+' : ''}{formatCount(total)} offsets
          </div>
          <div className="kafka-table-wrap kafka-preview">
            <table className="kafka-table" aria-label="Offset reset preview">
              <thead><tr><th>Topic</th><th className="num">Partition</th><th className="num">From</th><th className="num">To</th><th className="num">Δ</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.topic}:${r.partition}`}>
                    <td>{r.topic}</td><td className="num">{r.partition}</td><td className="num">{r.from ?? '—'}</td><td className="num">{r.to}</td>
                    <td className="num">{r.from === null ? '—' : r.to - r.from}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="kafka-typed">
            <span>Type <code className="mono">{groupId}</code> to apply</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`Type ${groupId} to apply`} />
          </label>
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- schema viewer

export function SchemaDialog({ cid, subject, onClose }: { cid: string; subject: string; onClose(): void }) {
  const [v, setV] = useState<KafkaSchemaVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.kafka.schemaVersion(cid, subject).then(setV, (e) => setError(errorMessage(e)));
  }, [cid, subject]);
  const text = useMemo(() => {
    if (!v) return '';
    if (v.schemaType === 'AVRO' || v.schemaType === 'JSON') {
      try {
        return JSON.stringify(JSON.parse(v.schema), null, 2);
      } catch {
        return v.schema;
      }
    }
    return v.schema;
  }, [v]);
  return (
    <Dialog title={`Schema · ${subject}`} onClose={onClose} width={680} footer={
      <>
        <button type="button" className="btn" disabled={!v} onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      </>
    }>
      {v && <div className="kafka-schema-meta">{v.schemaType} · version {v.version} · id {v.id}{v.references.length ? ` · ${v.references.length} reference(s)` : ''}</div>}
      {!v && !error && <div className="muted">Loading…</div>}
      <ErrorLine error={error} />
      {v && <pre className="kafka-pre" tabIndex={0}>{text}</pre>}
    </Dialog>
  );
}

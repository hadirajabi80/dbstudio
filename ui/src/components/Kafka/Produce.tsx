// Produce (docs/PLAN-M2.md 7.4, also "Produce similar"): key and value editors with formats (string / json / hex /
// avro / protobuf / jsonschema against a Schema Registry subject + version), headers table, partition (auto/explicit),
// key schema, compression, "Repeat N times" (cap 1000) with ${i} substitution. READ_ONLY on read-only connections.
import { displayShortcut } from '../../commands/keys';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { KafkaProduceFormat, KafkaProduceMessage, KafkaProduceRequest, KafkaProduceResult } from '../../api/types';
import type { ViewTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { Select } from '../common/Select';
import { formatTimestamp, substitute } from './format';
import { DEFAULT_DRAFT, openTopic, patchTab, type ProduceDraft, type ProduceTabState } from './open';
import { Banner, ViewHeader } from './parts';
import { hasRegistry, isReadOnly, kafkaConn, loadSubjects, useKafka } from './store';
import { ValueEditor } from './ValueEditor';

export const MAX_REPEAT = 1000;
const PRODUCE_FORMATS: { value: KafkaProduceFormat; label: string }[] = [
  { value: 'string', label: 'String' }, { value: 'json', label: 'JSON' }, { value: 'hex', label: 'Hex' },
  { value: 'avro', label: 'Avro (SR)' }, { value: 'protobuf', label: 'Protobuf (SR)' }, { value: 'jsonschema', label: 'JSON Schema (SR)' },
];
const isSchema = (f: KafkaProduceFormat) => f === 'avro' || f === 'protobuf' || f === 'jsonschema';

/** Builds the request (repeat + ${i}); returns an error text for invalid input. */
export function buildProduceRequest(d: ProduceDraft): KafkaProduceRequest | string {
  const n = Math.floor(d.repeat);
  if (!Number.isFinite(n) || n < 1 || n > MAX_REPEAT) return `Repeat must be between 1 and ${MAX_REPEAT}.`;
  if (isSchema(d.valueFormat) && !d.subject.trim()) return 'Choose the Schema Registry subject of the value.';
  if (isSchema(d.keyFormat) && !d.keySubject.trim()) return 'Choose the Schema Registry subject of the key.';
  if (d.headers.some((h) => !h.key.trim())) return 'Every header needs a key.';
  if (d.valueFormat === 'json' || isSchema(d.valueFormat)) {
    try {
      JSON.parse(substitute(d.value, 1));
    } catch (e) {
      return `The value is not valid JSON: ${(e as Error).message}`;
    }
  }
  const version = d.version.trim() === '' || d.version === 'latest' ? 'latest' : Number(d.version);
  if (version !== 'latest' && (!Number.isInteger(version) || version < 1)) return 'Version must be a number or "latest".';
  const messages: KafkaProduceMessage[] = [];
  for (let i = 1; i <= n; i++) {
    messages.push({
      key: d.key === '' ? null : substitute(d.key, i),
      value: substitute(d.value, i),
      headers: d.headers.map((h) => ({ key: h.key, value: substitute(h.value, i) })),
      partition: d.partition,
    });
  }
  return {
    messages, keyFormat: d.keyFormat, valueFormat: d.valueFormat, compression: d.compression,
    schema: isSchema(d.valueFormat) ? { subject: d.subject.trim(), version } : null,
    keySchema: isSchema(d.keyFormat) ? { subject: d.keySubject.trim(), version: 'latest' } : null,
  };
}

export function ProduceView({ tab, theme }: { tab: ViewTab; theme: EffectiveTheme }) {
  const cid = tab.connectionId ?? '';
  const st = (tab.state ?? {}) as ProduceTabState;
  const d: ProduceDraft = { ...DEFAULT_DRAFT, ...st.draft };
  const set = (p: Partial<ProduceDraft>) => patchTab(tab.id, { draft: { ...d, ...p } });
  const [partitions, setPartitions] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<KafkaProduceResult[] | null>(null);
  const subjects = useKafka((s) => s.conns[cid]?.subjects);
  const ro = isReadOnly(cid);
  const registry = hasRegistry(cid);

  useEffect(() => {
    api.kafka.topic(cid, st.topic).then((t) => setPartitions(t.partitions.length), (e) => setError(errorMessage(e)));
    if (registry && !kafkaConn(cid).subjects.data) void loadSubjects(cid);
  }, [cid, st.topic, registry]);

  const subjectOptions = useMemo(() => (subjects?.data ?? []).map((s) => ({ value: s.subject, label: s.subject, hint: s.schemaType })), [subjects?.data]);

  const send = async () => {
    const req = buildProduceRequest(d);
    if (typeof req === 'string') return setError(req);
    setBusy(true);
    setError(null);
    try {
      const r = await api.kafka.produce(cid, st.topic, req);
      setResults(r);
      toast('success', `Produced ${r.length} message${r.length === 1 ? '' : 's'} to ${st.topic}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const partitionOptions = [{ value: -1, label: 'Auto (partitioner)' }, ...Array.from({ length: partitions ?? 0 }, (_, i) => ({ value: i, label: `Partition ${i}` }))];
  return (
    <div className="kafka-view" data-testid="kafka-produce">
      <ViewHeader title={`Produce to ${st.topic}`} readOnly={ro}>
        <button type="button" className="btn btn-xs" onClick={() => openTopic(cid, st.topic, 'messages', { fetchSeq: Date.now() })}>Browse topic</button>
        <button type="button" className="btn btn-xs btn-primary" disabled={busy || ro} title={ro ? 'The connection is read-only' : `Produce (${displayShortcut('Mod+Enter')} in the value)`} onClick={() => void send()}>
          {busy ? 'Producing…' : d.repeat > 1 ? `Produce ${d.repeat}×` : 'Produce'}
        </button>
      </ViewHeader>
      {ro && <Banner tone="warn">This connection is read-only: producing is disabled.</Banner>}
      {error && <Banner>{error}</Banner>}
      <div className="kafka-scroll kafka-produce">
        <div className="form-grid kafka-produce-grid">
          <span className="form-label">Partition</span>
          <Select aria-label="Partition" value={d.partition ?? -1} options={partitionOptions} onChange={(v) => set({ partition: v < 0 ? null : v })} />
          <span className="form-label">Key format</span>
          <div className="kafka-row">
            <Select aria-label="Key format" value={d.keyFormat} options={PRODUCE_FORMATS.map((f) => ({ ...f, disabled: isSchema(f.value) && !registry }))} onChange={(v) => set({ keyFormat: v })} />
            {isSchema(d.keyFormat) && <Select aria-label="Key subject" value={d.keySubject} options={subjectOptions} onChange={(v) => set({ keySubject: v })} />}
          </div>
          <label className="form-label" htmlFor={`kp-key-${tab.id}`}>Key</label>
          <input id={`kp-key-${tab.id}`} className="input mono" value={d.key} placeholder="empty = null key" onChange={(e) => set({ key: e.target.value })} data-primary-focus />
          <span className="form-label">Value format</span>
          <div className="kafka-row">
            <Select aria-label="Value format" value={d.valueFormat} options={PRODUCE_FORMATS.map((f) => ({ ...f, disabled: isSchema(f.value) && !registry }))} onChange={(v) => set({ valueFormat: v })} />
            {isSchema(d.valueFormat) && (
              <>
                <Select aria-label="Value subject" value={d.subject} options={subjectOptions} onChange={(v) => set({ subject: v })} searchable="auto" />
                <input className="input kafka-num" aria-label="Schema version" value={d.version} onChange={(e) => set({ version: e.target.value })} placeholder="latest" />
              </>
            )}
          </div>
          <span className="form-label">Value</span>
          <ValueEditor value={d.value} onChange={(v) => set({ value: v })} language={d.valueFormat === 'string' || d.valueFormat === 'hex' ? 'text' : 'json'}
            ariaLabel="Value" theme={theme} onSubmit={() => void send()} />
          <span className="form-label">Headers</span>
          <div className="kafka-headers-edit">
            {d.headers.map((h, i) => (
              <div key={i} className="kafka-row">
                <input className="input mono" aria-label={`Header ${i + 1} key`} placeholder="key" value={h.key}
                  onChange={(e) => set({ headers: d.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                <input className="input mono flex-1" aria-label={`Header ${i + 1} value`} placeholder="value" value={h.value}
                  onChange={(e) => set({ headers: d.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <button type="button" className="icon-btn" aria-label={`Remove header ${i + 1}`} onClick={() => set({ headers: d.headers.filter((_, j) => j !== i) })}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-xs" onClick={() => set({ headers: [...d.headers, { key: '', value: '' }] })}><Plus size={12} aria-hidden /> Add header</button>
          </div>
          <span className="form-label">Compression</span>
          <Select aria-label="Compression" value={d.compression} onChange={(v) => set({ compression: v })}
            options={(['none', 'gzip', 'snappy', 'lz4', 'zstd'] as const).map((c) => ({ value: c, label: c }))} />
          <label className="form-label" htmlFor={`kp-repeat-${tab.id}`}>Repeat</label>
          <div className="kafka-row">
            <input id={`kp-repeat-${tab.id}`} className="input kafka-num" inputMode="numeric" value={d.repeat}
              onChange={(e) => set({ repeat: Math.min(MAX_REPEAT, Number(e.target.value.replace(/\D/g, '')) || 1) })} />
            <span className="muted">times (max {MAX_REPEAT}); <code className="mono">{'${i}'}</code> in key, value or headers becomes 1…N</span>
          </div>
        </div>
        {results && (
          <div className="kafka-table-wrap kafka-results">
            <table className="kafka-table" aria-label="Produced messages">
              <thead><tr><th className="num">#</th><th className="num">Partition</th><th className="num">Offset</th><th>Timestamp</th></tr></thead>
              <tbody>
                {results.slice(0, 200).map((r, i) => (
                  <tr key={i}><td className="num">{i + 1}</td><td className="num">{r.partition}</td><td className="num">{r.offset}</td><td>{formatTimestamp(r.timestamp)}</td></tr>
                ))}
              </tbody>
            </table>
            {results.length > 200 && <div className="muted">…and {results.length - 200} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}

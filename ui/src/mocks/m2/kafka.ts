// Kafka mock routes and stream emitters (docs/PLAN-M2.md section 7; owner M2-K) for `npm run dev:mock` and the MSW tests:
// an in-memory cluster (3 brokers, controller 1) with topics, partitions, offsets, timestamps, configs, consumer groups
// and Schema Registry subjects. Fetch jobs stream their messages on a `kafka.fetch` stream; `kafka.tail` streams emit a
// new `orders` message every ~700 ms. Read-only connections answer 403 READ_ONLY on every write.
import { http, HttpResponse, type RequestHandler } from 'msw';
import type {
  KafkaConfigEntry, KafkaDecoded, KafkaFetchRequest, KafkaGroupDetail, KafkaGroupSummary, KafkaMessage, KafkaOffsetResetRequest, KafkaOffsetResetRow,
  KafkaProduceRequest, KafkaSchemaVersion, KafkaTopicDetail, KafkaTopicSummary, KafkaValueFormat,
} from '../../api/types';
import { M2_PREFIX, type M2MockContext } from './index';

interface MockRecord { offset: number; ts: number; key: string | null; value: string | null; headers: { key: string; value: string }[]; schemaId?: number }
interface MockPartition { low: number; records: MockRecord[]; replicas: number[]; isr: number[]; leader: number | null }
interface MockTopic { name: string; internal: boolean; partitions: MockPartition[]; configs: Record<string, string> }
interface MockGroup { id: string; state: KafkaGroupSummary['state']; members: KafkaGroupDetail['members']; offsets: Map<string, number> }
interface MockSubject { subject: string; id: number; type: 'AVRO' | 'PROTOBUF' | 'JSON'; schema: string }

class HttpError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

const BROKERS = [
  { id: 1, host: 'kafka-1.dev', port: 9092, rack: 'eu-west-1a' },
  { id: 2, host: 'kafka-2.dev', port: 9092, rack: 'eu-west-1b' },
  { id: 3, host: 'kafka-3.dev', port: 9092, rack: 'eu-west-1c' },
];
const DEFAULT_TOPIC_CONFIGS: Record<string, string> = {
  'cleanup.policy': 'delete', 'retention.ms': '604800000', 'segment.bytes': '1073741824', 'max.message.bytes': '1048588', 'min.insync.replicas': '1',
  'compression.type': 'producer',
};
const BROKER_CONFIGS: Record<string, string> = {
  'log.retention.hours': '168', 'num.partitions': '3', 'default.replication.factor': '3', 'inter.broker.protocol.version': '3.8-IV0',
  'auto.create.topics.enable': 'false', 'message.max.bytes': '1048588',
};

export const PAYMENTS_AVRO = JSON.stringify({
  type: 'record', name: 'Payment', namespace: 'shop',
  fields: [{ name: 'id', type: 'long' }, { name: 'amount', type: 'double' }, { name: 'currency', type: { type: 'enum', name: 'Currency', symbols: ['EUR', 'USD'] } }],
});

/** The mock cluster; exported for tests. */
export function createKafkaFixture(now = Date.now()) {
  const topics = new Map<string, MockTopic>();
  const groups = new Map<string, MockGroup>();
  const subjects: MockSubject[] = [
    { subject: 'payments-value', id: 1, type: 'AVRO', schema: PAYMENTS_AVRO },
    { subject: 'events-proto-value', id: 2, type: 'PROTOBUF', schema: 'syntax = "proto3";\npackage shop;\nmessage Event { string name = 1; int64 at = 2; }' },
  ];
  const addTopic = (name: string, n: number, rf = 3, internal = name.startsWith('__')): MockTopic => {
    const t: MockTopic = {
      name, internal, configs: {},
      partitions: Array.from({ length: n }, (_, i) => {
        const replicas = Array.from({ length: rf }, (_, r) => ((i + r) % 3) + 1);
        return { low: 0, records: [], replicas, isr: [...replicas], leader: replicas[0] };
      }),
    };
    topics.set(name, t);
    return t;
  };
  const append = (t: MockTopic, p: number, rec: Omit<MockRecord, 'offset'>) => {
    const part = t.partitions[p];
    const r = { ...rec, offset: part.low + part.records.length };
    part.records.push(r);
    return r;
  };

  const orders = addTopic('orders', 3);
  for (let i = 0; i < 300; i++) {
    const cust = `cust-${i % 17}`;
    append(orders, i % 3, {
      ts: now - (300 - i) * 60_000, key: cust,
      value: JSON.stringify({ id: 10_000 + i, customer: cust, total: Math.round(((i * 37) % 500) * 100) / 100 + 0.5, note: i % 10 === 0 ? 'rush' : 'normal', items: [{ sku: `SKU-${i % 9}`, qty: 1 + (i % 4) }] }),
      headers: [{ key: 'traceparent', value: `00-${(i + 1).toString(16).padStart(32, '0')}-01` }, { key: 'source', value: 'web' }],
    });
  }
  orders.configs['retention.ms'] = '1209600000';
  const payments = addTopic('payments', 2);
  payments.partitions[1].isr = [payments.partitions[1].replicas[0]];
  for (let i = 0; i < 40; i++) {
    append(payments, i % 2, { ts: now - (40 - i) * 120_000, key: `pay-${i}`, value: JSON.stringify({ id: i, amount: 10 + i * 1.25, currency: i % 3 ? 'EUR' : 'USD' }), headers: [], schemaId: 1 });
  }
  const events = addTopic('events', 1, 1);
  for (let i = 0; i < 25; i++) append(events, 0, { ts: now - (25 - i) * 30_000, key: null, value: `user ${i % 5} clicked button-${i % 3}`, headers: [] });
  addTopic('compacted-users', 1, 3).configs['cleanup.policy'] = 'compact';
  const co = addTopic('__consumer_offsets', 5, 3, true);
  co.configs['cleanup.policy'] = 'compact';
  addTopic('_schemas', 1, 3, true);

  const group = (id: string, state: MockGroup['state'], offsets: [string, number, number][], members: KafkaGroupDetail['members'] = []) =>
    groups.set(id, { id, state, members, offsets: new Map(offsets.map(([t, p, o]) => [`${t}:${p}`, o])) });
  group('billing', 'Empty', [['orders', 0, 60], ['orders', 1, 95], ['orders', 2, 100], ['payments', 0, 20], ['payments', 1, 12]]);
  group('shipping', 'Stable', [['orders', 0, 100], ['orders', 1, 99], ['orders', 2, 97]], [
    { memberId: 'shipper-1-6f0c2a', clientId: 'shipper-1', host: '/10.0.4.11', assignments: [{ topic: 'orders', partitions: [0, 1] }] },
    { memberId: 'shipper-2-81bd77', clientId: 'shipper-2', host: '/10.0.4.12', assignments: [{ topic: 'orders', partitions: [2] }] },
  ]);
  group('analytics', 'Empty', [['events', 0, 0]]);
  return { topics, groups, subjects, addTopic, append };
}

type Fixture = ReturnType<typeof createKafkaFixture>;

// ---------------------------------------------------------------- decoding

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

function decode(text: string | null, format: KafkaValueFormat, schemaId: number | undefined, subjects: MockSubject[], full: boolean): KafkaDecoded {
  if (text === null) return { format, text: null };
  const cut = (s: string) => (!full && s.length > 32 * 1024 ? { $trunc: s.slice(0, 32 * 1024), len: s.length } : s);
  const sub = schemaId ? subjects.find((s) => s.id === schemaId) : undefined;
  if (format === 'hex') return { format: 'hex', text: cut(hex(text)), hex: hex(text) };
  if (format === 'int32' || format === 'int64') return { format, text: hex(text), hex: hex(text), error: `${format} needs exactly ${format === 'int32' ? 4 : 8} bytes, got ${new TextEncoder().encode(text).length}.` };
  if (format === 'avro' || format === 'protobuf' || format === 'jsonschema') {
    if (!sub) return { format, text: hex(text), hex: hex(text), error: 'Not in the Schema Registry wire format (magic byte 0 + schema id).' };
    return { format, text: cut(text), json: JSON.parse(text), schemaId: sub.id, schemaSubject: sub.subject };
  }
  if (format === 'auto' && sub) return { format: sub.type === 'AVRO' ? 'avro' : sub.type === 'PROTOBUF' ? 'protobuf' : 'jsonschema', text: cut(text), json: JSON.parse(text), schemaId: sub.id, schemaSubject: sub.subject };
  if (format === 'json' || (format === 'auto' && /^\s*[[{]/.test(text))) {
    try {
      return { format: 'json', text: cut(text), json: JSON.parse(text) };
    } catch (e) {
      return format === 'json' ? { format: 'json', text: cut(text), error: `Invalid JSON: ${(e as Error).message}` } : { format: 'string', text: cut(text) };
    }
  }
  return { format: 'string', text: cut(text) };
}

function toMessage(f: Fixture, topic: string, partition: number, r: MockRecord, keyFormat: KafkaValueFormat, valueFormat: KafkaValueFormat, full = false): KafkaMessage {
  return {
    topic, partition, offset: r.offset, timestamp: new Date(r.ts).toISOString(), timestampType: 'create',
    key: decode(r.key, keyFormat === 'auto' ? 'string' : keyFormat, undefined, f.subjects, full),
    value: decode(r.value, valueFormat, r.schemaId, f.subjects, full),
    headers: r.headers.map((h) => ({ key: h.key, value: { format: 'string', text: h.value } })),
    size: (r.key?.length ?? 0) + (r.value?.length ?? 0) + r.headers.reduce((s, h) => s + h.key.length + h.value.length, 0),
  };
}

// ---------------------------------------------------------------- handlers

export function createKafkaHandlers(ctx: M2MockContext): RequestHandler[] {
  const f = createKafkaFixture();
  const P = `${M2_PREFIX}/kafka/:cid`;
  const pendingFetch = new Map<string, KafkaMessage[]>();
  let tokenSeq = 0;

  ctx.streams.register('kafka.fetch', ({ params, push, end, signal }) => {
    const items = pendingFetch.get(String(params.token)) ?? [];
    pendingFetch.delete(String(params.token));
    let i = 0;
    const step = () => {
      if (signal.aborted) return;
      push(items.slice(i, i + 200));
      i += 200;
      if (i < items.length) setTimeout(step, 10);
      else end('completed');
    };
    setTimeout(step, 20);
  });

  ctx.streams.register('kafka.tail', ({ params, push, signal, end }) => {
    const t = f.topics.get(String(params.topic ?? ''));
    if (!t) return end(`Topic '${String(params.topic)}' was not found.`);
    const parts = Array.isArray(params.partitions) && params.partitions.length ? (params.partitions as number[]) : t.partitions.map((_, i) => i);
    const kf = (params.keyFormat as KafkaValueFormat) ?? 'string';
    const vf = (params.valueFormat as KafkaValueFormat) ?? 'auto';
    const filter = typeof params.filter === 'string' && params.filter ? params.filter.toLowerCase() : null;
    let n = 0;
    const timer = setInterval(() => {
      const p = parts[n % parts.length];
      n++;
      const value = t.name === 'orders'
        ? JSON.stringify({ id: 20_000 + n, customer: `cust-${n % 17}`, total: (n * 13) % 400 + 0.99, note: n % 4 === 0 ? 'rush' : 'normal', live: true })
        : `live event ${n}`;
      const rec = f.append(t, p, { ts: Date.now(), key: `cust-${n % 17}`, value, headers: [{ key: 'source', value: 'mock-tail' }] });
      const m = toMessage(f, t.name, p, rec, kf, vf);
      if (filter && !(m.value.text && JSON.stringify(m.value.text).toLowerCase().includes(filter))) return;
      push([m]);
    }, 700);
    signal.addEventListener('abort', () => clearInterval(timer));
  });

  const route = <T,>(fn: (a: { cid: string; p: Record<string, string>; body: T; url: URL }) => unknown) =>
    async ({ params, request }: { params: Record<string, string | readonly string[] | undefined>; request: Request }) => {
      const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, decodeURIComponent(String(v ?? ''))]));
      const client = ctx.clients.get(p.cid);
      if (!('connectionId' in client)) return err(client.status, client.code, client.message);
      let body = {} as T;
      if (request.method !== 'GET' && request.headers.get('content-type')?.includes('json')) body = (await request.json().catch(() => ({}))) as T;
      try {
        const r = await fn({ cid: p.cid, p, body, url: new URL(request.url) });
        if (r instanceof Response) return r;
        return r === undefined ? new HttpResponse(null, { status: 204 }) : ctx.ok(r as never);
      } catch (e) {
        if (e instanceof HttpError) return err(e.status, e.code, e.message, e.detail);
        throw e;
      }
    };

  const readOnly = (cid: string, action: string) => {
    const c = ctx.engine.conn(cid);
    if (c?.readOnly) throw new HttpError(403, 'READ_ONLY', `The connection '${c.name}' is read-only: ${action} is not allowed.`, { action });
  };
  const topic = (name: string) => {
    const t = f.topics.get(name);
    if (!t) throw new HttpError(404, 'NOT_FOUND', `Topic '${name}' was not found.`);
    return t;
  };
  const group = (id: string) => {
    const g = f.groups.get(id);
    if (!g) throw new HttpError(404, 'NOT_FOUND', `Consumer group '${id}' was not found.`);
    return g;
  };
  const high = (p: MockPartition) => p.low + p.records.length;
  const summary = (t: MockTopic): KafkaTopicSummary => ({
    name: t.name, partitions: t.partitions.length, replicationFactor: Math.max(...t.partitions.map((p) => p.replicas.length)), internal: t.internal,
    underReplicated: t.partitions.filter((p) => p.isr.length < p.replicas.length).length, messages: t.partitions.reduce((s, p) => s + p.records.length, 0), size: null,
  });
  const configsOf = (t: MockTopic): KafkaConfigEntry[] => Object.entries({ ...DEFAULT_TOPIC_CONFIGS, ...t.configs }).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    const dyn = name in t.configs;
    return { name, value, source: dyn ? 'dynamic_topic_config' : 'default_config', isDefault: !dyn, isReadOnly: false, isSensitive: false, synonyms: [] };
  });
  const lagOf = (g: MockGroup) => {
    let lag = 0;
    for (const [k, off] of g.offsets) {
      const [t, p] = k.split(':');
      const part = f.topics.get(t)?.partitions[Number(p)];
      if (part) lag += Math.max(0, high(part) - off);
    }
    return lag;
  };
  const groupSummary = (g: MockGroup): KafkaGroupSummary => ({
    groupId: g.id, state: g.state, protocol: g.members.length ? 'range' : null, members: g.members.length,
    topics: [...new Set([...g.offsets.keys()].map((k) => k.split(':')[0]))].sort(), lagTotal: lagOf(g), coordinator: { id: 1, host: 'kafka-1.dev:9092' },
  });

  return [
    http.get(`${P}/cluster`, route(() => {
      const parts = [...f.topics.values()].flatMap((t) => t.partitions);
      return {
        clusterId: 'MkU3OEVBNTcwNTJENDM2Qk', controller: { id: 1, host: 'kafka-1.dev:9092' },
        brokers: BROKERS.map((b) => ({ ...b, isController: b.id === 1, configsAvailable: true })), topicCount: f.topics.size, partitionCount: parts.length,
        underReplicated: parts.filter((p) => p.isr.length < p.replicas.length).length, offlinePartitions: parts.filter((p) => p.leader === null).length, version: '3.8',
      };
    })),
    http.get(`${P}/brokers/:id/configs`, route(({ p }) => {
      if (!BROKERS.some((b) => String(b.id) === p.id)) throw new HttpError(422, 'PROVIDER_ERROR', `Broker ${p.id} is unknown.`);
      return [...Object.entries(BROKER_CONFIGS).map(([name, value]) => ({ name, value, source: 'static_broker_config', isDefault: false, isReadOnly: true, isSensitive: false, synonyms: [] })),
        { name: 'ssl.keystore.password', value: null, source: 'static_broker_config', isDefault: false, isReadOnly: true, isSensitive: true, synonyms: [] }]
        .sort((a, b) => a.name.localeCompare(b.name));
    })),
    http.get(`${P}/topics`, route(({ url }) => {
      const internal = url.searchParams.get('includeInternal') === 'true';
      return [...f.topics.values()].filter((t) => internal || !t.internal).sort((a, b) => a.name.localeCompare(b.name)).map(summary);
    })),
    http.post(`${P}/topics`, route<{ name?: string; partitions?: number; replicationFactor?: number; configs?: Record<string, string> }>(({ cid, body }) => {
      const name = String(body.name ?? '').trim();
      if (!/^[A-Za-z0-9._-]{1,249}$/.test(name)) throw new HttpError(400, 'VALIDATION', 'Topic names use letters, digits, ".", "_" and "-".', { field: 'name' });
      readOnly(cid, `creating topic '${name}'`);
      if (f.topics.has(name)) throw new HttpError(409, 'VALIDATION', `Topic '${name}' already exists.`, { field: 'name' });
      const rf = body.replicationFactor ?? 1;
      if (rf > BROKERS.length) throw new HttpError(400, 'VALIDATION', `Replication factor: ${rf} larger than available brokers: ${BROKERS.length}.`);
      const t = f.addTopic(name, Math.max(1, body.partitions ?? 1), rf);
      Object.assign(t.configs, body.configs ?? {});
    })),
    http.get(`${P}/topics/:topic`, route(({ p }) => {
      const t = topic(p.topic);
      return {
        name: t.name, internal: t.internal, configs: configsOf(t),
        partitions: t.partitions.map((x, id) => ({ id, leader: x.leader, replicas: x.replicas, isr: x.isr, lowOffset: x.low, highOffset: high(x), messages: x.records.length, size: null })),
      } satisfies KafkaTopicDetail;
    })),
    http.put(`${P}/topics/:topic/configs`, route<{ set?: Record<string, string>; delete?: string[] }>(({ cid, p, body }) => {
      const t = topic(p.topic);
      readOnly(cid, `changing the configs of topic '${t.name}'`);
      for (const [k, v] of Object.entries(body.set ?? {})) t.configs[k] = v;
      for (const k of body.delete ?? []) delete t.configs[k];
    })),
    http.post(`${P}/topics/:topic/partitions`, route<{ count?: number }>(({ cid, p, body }) => {
      const t = topic(p.topic);
      if (!body.count || body.count <= t.partitions.length) throw new HttpError(400, 'VALIDATION', `The new partition count must exceed the current ${t.partitions.length}.`, { field: 'count' });
      readOnly(cid, `adding partitions to topic '${t.name}'`);
      while (t.partitions.length < body.count) t.partitions.push({ low: 0, records: [], replicas: [1], isr: [1], leader: 1 });
    })),
    http.delete(`${P}/topics/:topic`, route(({ cid, p }) => {
      readOnly(cid, `deleting topic '${p.topic}'`);
      topic(p.topic);
      f.topics.delete(p.topic);
    })),
    http.post(`${P}/topics/:topic/purge`, route<{ partitions?: number[] | null }>(({ cid, p, body }) => {
      readOnly(cid, `purging topic '${p.topic}'`);
      const t = topic(p.topic);
      const ids = body.partitions?.length ? body.partitions : t.partitions.map((_, i) => i);
      return {
        partitions: ids.map((id) => {
          const part = t.partitions[id];
          part.low = high(part);
          part.records = [];
          return { partition: id, lowOffset: part.low };
        }),
      };
    })),
    http.post(`${P}/topics/:topic/messages`, route<KafkaFetchRequest>(({ cid, p, body }) => {
      const t = topic(p.topic);
      const start = body.start ?? { kind: 'latest', count: 100 };
      if (start.kind === 'offset' && typeof start.offset !== 'number') throw new HttpError(400, 'VALIDATION', 'start.offset is required.', { field: 'start.offset' });
      const limit = body.limit ?? 200;
      const ids = body.partitions?.length ? body.partitions : t.partitions.map((_, i) => i);
      const search = body.search?.text ? body.search : null;
      const kf = body.keyFormat ?? 'string';
      const vf = body.valueFormat ?? 'auto';
      let scanned = 0;
      let picked: KafkaMessage[] = [];
      for (const id of ids) {
        const part = t.partitions[id];
        if (!part) throw new HttpError(400, 'VALIDATION', `Topic '${t.name}' has no partition ${id}.`, { field: 'partitions' });
        let recs = part.records;
        if (start.kind === 'latest') recs = recs.slice(-start.count);
        else if (start.kind === 'offset') recs = recs.filter((r) => r.offset >= start.offset);
        else if (start.kind === 'timestamp') recs = recs.filter((r) => r.ts >= Date.parse(start.iso));
        scanned += recs.length;
        for (const r of recs) {
          const m = toMessage(f, t.name, id, r, kf, vf);
          const text = typeof m.value.text === 'string' ? m.value.text : m.value.text?.$trunc ?? '';
          if (search && !(search.caseSensitive ? text.includes(search.text) : text.toLowerCase().includes(search.text.toLowerCase()))) continue;
          picked.push(m);
        }
      }
      picked.sort((a, b) => (start.kind === 'latest' ? b.timestamp.localeCompare(a.timestamp) : a.timestamp.localeCompare(b.timestamp)));
      const truncated = picked.length > limit;
      picked = picked.slice(0, limit);
      const token = `f${++tokenSeq}`;
      pendingFetch.set(token, picked);
      const s = ctx.streams.start({ kind: 'kafka.fetch', connectionId: cid, params: { token } });
      if (!('streamId' in s)) throw new HttpError(s.status, s.code, s.message);
      const jobId = ctx.jobs.start('kafka.fetch', async (report) => {
        report(scanned, scanned, `${picked.length} matched, ${scanned} scanned`);
        await new Promise((r) => setTimeout(r, 40 + Math.ceil(picked.length / 200) * 12));
        return { fetched: picked.length, scanned, partitionsDone: ids, timedOut: false, truncated };
      });
      return HttpResponse.json({ jobId, streamId: s.streamId }, { status: 202 });
    })),
    http.get(`${P}/topics/:topic/messages/:partition/:offset`, route(({ p, url }) => {
      const t = topic(p.topic);
      const part = t.partitions[Number(p.partition)];
      const r = part?.records.find((x) => x.offset === Number(p.offset));
      if (!r) throw new HttpError(404, 'NOT_FOUND', `Message ${p.partition}/${p.offset} of '${t.name}' is not available.`);
      return toMessage(f, t.name, Number(p.partition), r, (url.searchParams.get('keyFormat') as KafkaValueFormat) ?? 'string',
        (url.searchParams.get('valueFormat') as KafkaValueFormat) ?? 'auto', true);
    })),
    http.post(`${P}/topics/:topic/produce`, route<KafkaProduceRequest>(({ cid, p, body }) => {
      const t = topic(p.topic);
      readOnly(cid, `producing to topic '${t.name}'`);
      if (!body.messages?.length) throw new HttpError(400, 'VALIDATION', 'messages must contain at least one message.', { field: 'messages' });
      if (body.messages.length > 1000) throw new HttpError(400, 'VALIDATION', 'At most 1000 messages per request.', { field: 'messages' });
      const schema = body.schema ? f.subjects.find((s) => s.subject === body.schema!.subject) : undefined;
      if ((body.valueFormat === 'avro' || body.valueFormat === 'protobuf' || body.valueFormat === 'jsonschema') && !schema) {
        throw new HttpError(body.schema ? 404 : 400, body.schema ? 'NOT_FOUND' : 'VALIDATION', body.schema ? `Schema Registry: subject '${body.schema.subject}' not found` : 'schema.subject is required.', { field: 'schema.subject' });
      }
      return body.messages.map((m, i) => {
        if (body.valueFormat === 'json' && m.value !== null) {
          try {
            JSON.parse(m.value);
          } catch (e) {
            throw new HttpError(400, 'VALIDATION', `messages[${i}].value is not valid JSON: ${(e as Error).message}`, { field: `messages[${i}].value` });
          }
        }
        const pid = m.partition ?? (m.key ? [...m.key].reduce((s, c) => s + c.charCodeAt(0), 0) % t.partitions.length : i % t.partitions.length);
        const rec = f.append(t, pid, { ts: Date.now(), key: m.key, value: m.value, headers: m.headers ?? [], schemaId: schema?.id });
        return { partition: pid, offset: rec.offset, timestamp: new Date(rec.ts).toISOString() };
      });
    })),
    http.get(`${P}/groups`, route(() => [...f.groups.values()].sort((a, b) => a.id.localeCompare(b.id)).map(groupSummary))),
    http.get(`${P}/groups/:groupId`, route(({ p }) => {
      const g = group(p.groupId);
      const memberOf = new Map<string, string>();
      for (const m of g.members) for (const a of m.assignments) for (const x of a.partitions) memberOf.set(`${a.topic}:${x}`, m.memberId);
      const keys = [...new Set([...g.offsets.keys(), ...memberOf.keys()])].sort();
      return {
        groupId: g.id, state: g.state, protocol: g.members.length ? 'range' : null, coordinator: { id: 1, host: 'kafka-1.dev:9092' }, members: g.members,
        partitions: keys.map((k) => {
          const [tn, pn] = k.split(':');
          const part = f.topics.get(tn)?.partitions[Number(pn)];
          const committed = g.offsets.get(k) ?? null;
          const h = part ? high(part) : 0;
          return { topic: tn, partition: Number(pn), committed, high: h, low: part?.low ?? 0, lag: committed === null ? null : Math.max(0, h - committed), memberId: memberOf.get(k) ?? null };
        }),
      } satisfies KafkaGroupDetail;
    })),
    http.post(`${P}/groups/:groupId/offsets`, route<KafkaOffsetResetRequest>(({ cid, p, body }) => {
      const g = f.groups.get(p.groupId) ?? { id: p.groupId, state: 'Empty' as const, members: [], offsets: new Map<string, number>() };
      if (!body.to?.kind) throw new HttpError(400, 'VALIDATION', 'to is required.', { field: 'to' });
      if (!body.dryRun) {
        readOnly(cid, `resetting the offsets of group '${g.id}'`);
        if (g.members.length || g.state === 'Stable') {
          throw new HttpError(409, 'GROUP_ACTIVE', `Consumer group '${g.id}' is ${g.state} with ${g.members.length} members: stop its consumers before resetting offsets.`,
            { state: g.state, members: g.members.map((m) => ({ memberId: m.memberId, clientId: m.clientId, host: m.host })) });
        }
      }
      const keys = body.partitions?.length ? body.partitions.map((x) => `${x.topic}:${x.partition}`)
        : body.topic ? topic(body.topic).partitions.map((_, i) => `${body.topic}:${i}`) : [...g.offsets.keys()];
      if (!keys.length) throw new HttpError(400, 'VALIDATION', 'The group has no committed offsets: choose a topic.', { field: 'topic' });
      const rows: KafkaOffsetResetRow[] = keys.sort().map((k) => {
        const [tn, pn] = k.split(':');
        const part = topic(tn).partitions[Number(pn)];
        const lo = part.low;
        const hi = high(part);
        const from = g.offsets.get(k) ?? null;
        const v = Number(body.to.value);
        const clamp = (n: number) => Math.min(hi, Math.max(lo, n));
        const to = body.to.kind === 'earliest' ? lo : body.to.kind === 'latest' ? hi : body.to.kind === 'offset' ? clamp(v)
          : body.to.kind === 'shiftBy' ? clamp((from ?? hi) + v) : clamp(part.records.find((r) => r.ts >= Date.parse(String(body.to.value)))?.offset ?? hi);
        return { topic: tn, partition: Number(pn), from, to };
      });
      if (!body.dryRun) {
        for (const r of rows) g.offsets.set(`${r.topic}:${r.partition}`, r.to);
        f.groups.set(g.id, g);
      }
      return rows;
    })),
    http.delete(`${P}/groups/:groupId`, route(({ cid, p }) => {
      readOnly(cid, `deleting consumer group '${p.groupId}'`);
      const g = group(p.groupId);
      if (g.members.length) throw new HttpError(409, 'GROUP_ACTIVE', `Consumer group '${g.id}' is ${g.state}: stop its consumers before deleting the group.`);
      f.groups.delete(g.id);
    })),
    http.get(`${P}/schemas/subjects`, route(({ cid }) => {
      const url = ctx.engine.conn(cid)?.props.schemaRegistryUrl;
      if (!url) throw new HttpError(400, 'NOT_SUPPORTED', 'No Schema Registry is configured for this connection.', { field: 'schemaRegistryUrl' });
      return f.subjects.map((s) => ({ subject: s.subject, versions: [1], latestVersion: 1, schemaType: s.type }));
    })),
    http.get(`${P}/schemas/subjects/:subject/versions/:version`, route(({ p }) => {
      const s = f.subjects.find((x) => x.subject === p.subject);
      if (!s) throw new HttpError(404, 'NOT_FOUND', `Schema Registry: subject '${p.subject}' not found`);
      return { subject: s.subject, version: 1, id: s.id, schemaType: s.type, schema: s.schema, references: [] } satisfies KafkaSchemaVersion;
    })),
  ];
}

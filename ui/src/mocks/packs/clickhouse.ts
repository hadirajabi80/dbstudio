// ClickHouse mock pack (plan-batch3 WP-CH): provider entry, sample connection (folder "Batch 3"), catalog extras (a
// materialized view, a dictionary, a SQL UDF) and the /clickhouse/{cid}/… module routes with fake parts, partitions,
// mutations and merges. The mock engine gives the connection the SQLite shop tables in schema "main" (mocks/engine.ts).
// Read-only connections answer 403 READ_ONLY on every write. WP-CH owns this file.
import { http, HttpResponse, type RequestHandler } from 'msw';
import type { CatalogColumnTuple, CatalogObject, ConnectionProfile, ProviderInfo } from '../../api/types';
import type { ChMerge, ChMutation, ChPart, ChPartition, ChPartsResponse } from '../../api/types.clickhouse';
import type { M2MockContext } from '../m2';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"). */
export const clickhouseConnections: ConnectionProfile[] = [
  { id: 'c_clickhouse', name: 'ClickHouse Shop', providerId: 'clickhouse', color: null, folder: 'Batch 3', readOnly: false,
      props: { host: 'clickhouse-dev', port: 8123, protocol: 'http', database: 'shop', user: 'shop', compression: true },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
];

export const clickhouseProvider: ProviderInfo = {
  id: 'clickhouse',
  displayName: 'ClickHouse',
  dialect: 'clickhouse',
  kind: 'relational',
  formSpec: {
    fields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'localhost' },
      { key: 'port', label: 'Port', type: 'number', default: 8123, help: 'HTTP interface: 8123 (http) or 8443 (https).' },
      { key: 'protocol', label: 'Protocol', type: 'select', default: 'http', options: [{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }] },
      { key: 'database', label: 'Database', type: 'text', default: 'default' },
      { key: 'user', label: 'User', type: 'text', default: 'default' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'compression', label: 'Compression', type: 'bool', default: true },
      { key: 'skipCertificateValidation', label: 'Skip certificate validation', type: 'bool', default: false, visibleWhen: { protocol: 'https' } },
      { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 15 },
      { key: 'sessionTimeout', label: 'Session timeout (s)', type: 'number', default: 3600 },
      { key: 'settings', label: 'Settings', type: 'text', placeholder: 'max_threads=4, join_use_nulls=1', help: 'Server settings applied to every query: key=value, separated by commas or new lines' },
      { key: 'commandTimeout', label: 'Command timeout (s)', type: 'number', default: 0 },
    ],
  },
};

const col = (n: string, t: string, nullable = false, pk = false): CatalogColumnTuple => [n, t, nullable ? 1 : 0, pk ? 1 : 0, 0, null];

/** Catalog objects added to the mock shop schema of the ClickHouse connection. */
export const clickhouseExtraObjects: CatalogObject[] = [
  { t: 'view', n: 'customer_orders', c: [col('customer_id', 'UInt32'), col('name', 'String'), col('order_id', 'UInt64'), col('total', 'Decimal(12, 2)')] },
  { t: 'mview', n: 'daily_sales', cm: 'Materialized view TO daily_sales_agg', c: [col('day', 'Date'), col('orders', 'UInt64'), col('revenue', 'Decimal(38, 2)')] },
  { t: 'type', n: 'product_dict', cm: 'Dictionary: HASHED() from shop.products', c: [col('id', 'UInt64', false, true), col('name', 'String'), col('price', 'Decimal(10, 2)')] },
  { t: 'func', n: 'tax', cm: 'SQL user-defined function: (amount) -> amount * 0.19', p: [['', 'Float64', 'return', 0], ['amount', 'Decimal(12, 2)', 'in', 0]] },
];

// ---------------------------------------------------------------------------------------------- fake system tables

const P = '*/api/v1/clickhouse';
const MONTHS = ['202607', '202608', '202609', '202610'];

function partsOf(table: string): ChPart[] {
  const out: ChPart[] = [];
  let block = 1;
  MONTHS.forEach((m, mi) => {
    const rows = [41_250, 38_900, 52_310, 12_480][mi] * (table === 'orders' ? 1 : 3);
    const n = mi === MONTHS.length - 1 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const r = Math.round(rows / n);
      const comp = r * 23;
      const level = n === 1 ? 2 : 0;
      const name = n === 1 ? `${m}_${block}_${block + 5}_${level}` : `${m}_${block}_${block}_0`;
      out.push({
        name, partition: m, partitionId: m, active: true, partType: r > 20_000 ? 'Wide' : 'Compact', rows: r, marks: Math.ceil(r / 8192) + 1,
        bytesOnDisk: comp + 4096, dataCompressedBytes: comp, dataUncompressedBytes: comp * 6, level, minBlock: block, maxBlock: n === 1 ? block + 5 : block,
        modificationTime: `2026-${m.slice(4)}-28T0${i}:12:00Z`, disk: 'default',
      });
      block += n === 1 ? 6 : 1;
    }
  });
  // an outdated part kept until old_parts_lifetime passes
  out.push({ ...out[0], name: `${MONTHS[0]}_1_3_1`, active: false, rows: 20_000, bytesOnDisk: 470_000, dataCompressedBytes: 466_000, dataUncompressedBytes: 2_796_000, level: 1, maxBlock: 3 });
  return out;
}

function partitionsOf(parts: ChPart[]): ChPartition[] {
  const map = new Map<string, ChPartition>();
  for (const p of parts) {
    if (!p.active) continue;
    const x = map.get(p.partition) ?? { partition: p.partition, partitionId: p.partitionId, parts: 0, rows: 0, bytesOnDisk: 0, dataCompressedBytes: 0, dataUncompressedBytes: 0,
      minTime: `${p.partition.slice(0, 4)}-${p.partition.slice(4)}-01T00:00:00Z`, maxTime: `${p.partition.slice(0, 4)}-${p.partition.slice(4)}-28T23:59:59Z`, lastModified: null };
    x.parts++;
    x.rows += p.rows;
    x.bytesOnDisk += p.bytesOnDisk;
    x.dataCompressedBytes += p.dataCompressedBytes;
    x.dataUncompressedBytes += p.dataUncompressedBytes;
    if (!x.lastModified || (p.modificationTime && p.modificationTime > x.lastModified)) x.lastModified = p.modificationTime;
    map.set(p.partition, x);
  }
  return [...map.values()];
}

interface ChMockState {
  dropped: Set<string>;
  mutations: ChMutation[];
}

const states = new Map<string, ChMockState>();
function state(cid: string): ChMockState {
  let s = states.get(cid);
  if (!s) {
    s = {
      dropped: new Set(),
      mutations: [
        { database: 'main', table: 'orders', mutationId: 'mutation_7.txt', command: "UPDATE status = 'shipped' WHERE order_date < '2026-09-01'", createTime: '2026-10-14T08:55:00Z',
          isDone: false, partsToDo: 3, isKilled: false, latestFailReason: null, latestFailTime: null },
        { database: 'main', table: 'orders', mutationId: 'mutation_6.txt', command: 'DELETE WHERE total = 0', createTime: '2026-10-13T17:20:00Z',
          isDone: true, partsToDo: 0, isKilled: false, latestFailReason: null, latestFailTime: null },
        { database: 'main', table: 'customers', mutationId: 'mutation_3.txt', command: 'UPDATE email = lower(email) WHERE 1', createTime: '2026-10-12T10:02:00Z',
          isDone: false, partsToDo: 1, isKilled: false, latestFailReason: 'Code: 341. DB::Exception: Exception happened during execution of mutation (UNFINISHED)', latestFailTime: '2026-10-14T08:59:00Z' },
      ],
    };
    states.set(cid, s);
  }
  return s;
}

const MERGES: ChMerge[] = [
  { database: 'main', table: 'orders', elapsedSec: 12.4, progress: 0.62, numParts: 3, resultPartName: '202610_7_9_1', partitionId: '202610', totalSizeBytesCompressed: 863_000,
    rowsRead: 7_740, rowsWritten: 7_700, memoryUsage: 4_194_304, isMutation: false, mergeType: 'Regular' },
  { database: 'main', table: 'orders', elapsedSec: 3.1, progress: 0.18, numParts: 1, resultPartName: '202609_3_3_0_7', partitionId: '202609', totalSizeBytesCompressed: 1_203_130,
    rowsRead: 9_400, rowsWritten: 9_380, memoryUsage: 2_097_152, isMutation: true, mergeType: null },
];

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

export function createClickHouseHandlers(ctx: M2MockContext): RequestHandler[] {
  const guard = (cid: string, action: string): Response | null => {
    const c = ctx.engine.conn(cid);
    if (!c) return err(404, 'NOT_FOUND', `Connection '${cid}' was not found.`);
    if (c.providerId !== 'clickhouse') return err(400, 'VALIDATION', `Connection '${c.name}' is not a ClickHouse connection.`, { field: 'connectionId' });
    if (action && c.readOnly) return err(403, 'READ_ONLY', `The connection '${c.name}' is read-only: ${action} is not allowed.`, { action });
    return null;
  };
  const body = async <T,>(request: Request) => (await request.json().catch(() => ({}))) as Partial<T>;
  const cidOf = (params: Record<string, unknown>) => decodeURIComponent(String(params.cid ?? ''));

  return [
    http.get(`${P}/:cid/parts`, ({ params, request }) => {
      const cid = cidOf(params);
      const bad = guard(cid, '');
      if (bad) return bad;
      const url = new URL(request.url);
      const database = url.searchParams.get('database') ?? 'main';
      const table = url.searchParams.get('table') ?? '';
      if (!table) return err(400, 'VALIDATION', 'table is required.', { field: 'table' });
      const s = state(cid);
      const merge = table === 'orders' || table === 'order_lines' || table === 'customers';
      const parts = merge ? partsOf(table).filter((p) => !s.dropped.has(`${table}:${p.partitionId}`)) : [];
      const res: ChPartsResponse = {
        database, table,
        engine: merge ? (table === 'order_lines' ? 'SummingMergeTree' : 'MergeTree') : 'Memory',
        partitionKey: merge ? 'toYYYYMM(order_date)' : null,
        sortingKey: merge ? (table === 'orders' ? 'customer_id, id' : 'id') : null,
        primaryKey: merge ? (table === 'orders' ? 'customer_id, id' : 'id') : null,
        samplingKey: null,
        ttl: table === 'orders' ? 'toDateTime(order_date) + toIntervalYear(3)' : null,
        totalRows: parts.filter((p) => p.active).reduce((a, p) => a + p.rows, 0),
        totalBytes: parts.filter((p) => p.active).reduce((a, p) => a + p.bytesOnDisk, 0),
        partitions: partitionsOf(parts),
        parts,
      };
      return ctx.ok(res as never);
    }),
    http.get(`${P}/:cid/mutations`, ({ params, request }) => {
      const cid = cidOf(params);
      const bad = guard(cid, '');
      if (bad) return bad;
      const url = new URL(request.url);
      const table = url.searchParams.get('table');
      const db = url.searchParams.get('database');
      const list = state(cid).mutations.filter((m) => (!table || m.table === table) && (!db || m.database === db));
      return ctx.ok(list as never);
    }),
    http.post(`${P}/:cid/mutations/kill`, async ({ params, request }) => {
      const cid = cidOf(params);
      const bad = guard(cid, 'killing a mutation');
      if (bad) return bad;
      const b = await body<{ database: string; table: string; mutationId: string }>(request);
      const m = state(cid).mutations.find((x) => x.mutationId === b.mutationId && x.table === b.table);
      if (!m) return err(404, 'NOT_FOUND', `Mutation '${b.mutationId ?? ''}' was not found.`);
      if (m.isDone) return ctx.ok({ ok: false, message: `Mutation ${m.mutationId} is already done.` } as never);
      m.isKilled = true;
      m.isDone = true;
      m.partsToDo = 0;
      return ctx.ok({ ok: true, message: `Mutation ${m.mutationId} of ${m.database}.${m.table} was killed.` } as never);
    }),
    http.get(`${P}/:cid/merges`, ({ params, request }) => {
      const cid = cidOf(params);
      const bad = guard(cid, '');
      if (bad) return bad;
      const table = new URL(request.url).searchParams.get('table');
      const jitter = (Date.now() / 1000) % 10;
      return ctx.ok(MERGES.filter((m) => !table || m.table === table).map((m) => ({
        ...m, elapsedSec: m.elapsedSec + jitter, progress: Math.min(0.99, m.progress + jitter / 30),
      })) as never);
    }),
    http.post(`${P}/:cid/optimize`, async ({ params, request }) => {
      const cid = cidOf(params);
      const bad = guard(cid, 'OPTIMIZE TABLE');
      if (bad) return bad;
      const b = await body<{ database: string; table: string; partition?: string | null; final?: boolean; deduplicate?: boolean }>(request);
      const what = `${b.database}.${b.table}${b.partition ? ` PARTITION ${b.partition}` : ''}${b.final ? ' FINAL' : ''}${b.deduplicate ? ' DEDUPLICATE' : ''}`;
      return ctx.ok({ ok: true, message: `OPTIMIZE TABLE ${what} finished.` } as never);
    }),
    http.post(`${P}/:cid/partitions/:op`, async ({ params, request }) => {
      const cid = cidOf(params);
      const op = String(params.op);
      if (op !== 'drop' && op !== 'detach') return err(404, 'NOT_FOUND', `Unknown partition operation '${op}'.`);
      const bad = guard(cid, `${op === 'drop' ? 'dropping' : 'detaching'} a partition`);
      if (bad) return bad;
      const b = await body<{ database: string; table: string; partitionId: string }>(request);
      if (!b.partitionId) return err(400, 'VALIDATION', 'partitionId is required.', { field: 'partitionId' });
      state(cid).dropped.add(`${b.table}:${b.partitionId}`);
      return ctx.ok({ ok: true, message: `Partition ${b.partitionId} of ${b.database}.${b.table} was ${op === 'drop' ? 'dropped' : 'detached'}.` } as never);
    }),
  ];
}

export const clickhousePack: MockProviderPack = {
  providers: [clickhouseProvider],
  // fresh copies per mock engine: tests flip readOnly on the engine's connection objects
  get connections() {
    return clickhouseConnections.map((c) => ({ ...c, props: { ...c.props } }));
  },
  extraObjects: { clickhouse: clickhouseExtraObjects },
  handlers: createClickHouseHandlers,
};

/** Test helper: forget the mock state (dropped partitions, killed mutations). */
export function resetClickHouseMock(): void {
  states.clear();
}

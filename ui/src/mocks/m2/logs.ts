// Logs mock routes and stream emitters (docs/PLAN-M2.md section 8). Owned by package M2-L.
//   GET  /logs/:cid/sources   per provider (by the connection's providerId; `engine` = the engine log; SQLite: [])
//   POST /logs/:cid/query     server-side filtering by levels / q / from / to / before / limit (+ archive)
//   POST /logs/:cid/kill      READ_ONLY on read-only connections; killed sessions vanish from later snapshots
//   POST /logs/:cid/export    path null → the file; else a job whose result is LogExportResult
// Streams: `logs.tail` (a few entries per second; Redis MONITOR / Mongo changes are live-only and MONITOR ends after
// 10 minutes) and `activity.poll` (one snapshot every intervalMs with a blocking chain).
import { http, HttpResponse, type RequestHandler } from 'msw';
import type {
  ActivityRow, LogEntry, LogExportRequest, LogKillRequest, LogLevel, LogQuery, LogQueryResponse, LogSourceInfo,
} from '../../api/types';
import { exportFileName, formatEntries } from '../../components/Logs/model';
import { M2_PREFIX, type M2MockContext } from './index';

const P = M2_PREFIX;
const ENGINE = 'engine';
const MONITOR_LIMIT_MS = 10 * 60_000;

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

type Src = LogSourceInfo & { archives?: { index: number; date: string | null; sizeBytes: number }[] };
const ALL: string[] = ['debug', 'info', 'warn', 'error', 'fatal'];
const src = (id: string, title: string, o: Partial<Src> = {}): Src => ({
  id, title, kind: 'log', supportsTail: true, supportsRange: true, levels: ALL, available: true, ...o,
});
const activity = (o: Partial<Src> = {}): Src => src('activity', 'Activity', { kind: 'activity', supportsTail: false, supportsRange: false, levels: [], ...o });

const day = 86_400_000;
const archives = () => Array.from({ length: 7 }, (_, i) => ({ index: i, date: i ? new Date(Date.now() - i * 7 * day).toISOString() : null, sizeBytes: 40_000 + i * 12_345 }));

/** Sources per provider id ('engine' = the engine log). */
export function mockLogSources(providerId: string): Src[] {
  switch (providerId) {
    case ENGINE:
      return [src('engine', 'Engine log')];
    case 'sqlserver':
      return [
        src('errorlog', 'Error log', { levels: ['info', 'warn', 'error'], archives: archives() }),
        src('agentlog', 'SQL Agent log', { levels: ['info', 'warn', 'error'], archives: archives().slice(0, 4) }),
        src('system_health', 'system_health (XE)', {
          supportsTail: true, available: false, reason: 'VIEW SERVER STATE permission was denied on object \'server\', database \'master\'.',
          needs: 'GRANT VIEW SERVER STATE TO [app];',
        }),
        activity(),
      ];
    case 'oracle':
      return [
        src('alert', 'Alert log'),
        src('audit', 'Unified audit trail', { available: false, reason: 'ORA-00942: table or view does not exist (UNIFIED_AUDIT_TRAIL).', needs: 'GRANT AUDIT_VIEWER TO APP;' }),
        activity(),
      ];
    case 'postgresql':
      return [src('serverlog', 'Server log'), src('pg_stat_statements', 'Top statements (pg_stat_statements)', { supportsTail: false, levels: ['info'] }), activity()];
    case 'redis':
      return [
        src('slowlog', 'Slow log', { levels: ['info', 'warn'] }),
        src('latency', 'Latency monitor', {
          levels: ['info', 'warn'], reason: 'latency-monitor-threshold is 0, so the latency monitor records nothing.', needs: 'CONFIG SET latency-monitor-threshold 100',
        }),
        src('monitor', 'MONITOR (live)', { supportsRange: false, levels: ['info'] }),
        activity(),
      ];
    case 'mongodb':
      return [
        src('getLog', 'Server log (getLog)'),
        src('profiler:shop', 'Profiler: shop', { levels: ['info', 'warn'], reason: 'Profiling is off (level 0) for shop.', needs: 'db.setProfilingLevel(1, { slowms: 100 })' }),
        src('changes', 'Change stream (live)', { supportsRange: false, levels: ['info'] }),
        activity(),
      ];
    case 'kafka':
      return [src('client', 'Client log (librdkafka)'), activity()];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- entry fixtures

type Tpl = { level: LogLevel; source: string; message: string; detail?: string; fields?: Record<string, string> };

const TEMPLATES: Record<string, Tpl[]> = {
  engine: [
    { level: 'info', source: 'Microsoft.Hosting.Lifetime', message: 'Now listening on: http://127.0.0.1:52341' },
    { level: 'debug', source: 'DbStudio.Core.Catalog', message: 'Catalog snapshot for c_prod/Shop: 412 objects in 184 ms' },
    { level: 'info', source: 'DbStudio.Core.Sessions', message: 'Session opened on Prod SQL (Shop)', fields: { connectionId: 'c_prod', sessionId: 's_17' } },
    { level: 'warn', source: 'DbStudio.Core.Execution', message: 'Slow statement: 2.4 s on Shop (SQLite)', fields: { executionId: 'x_93', elapsedMs: '2412' } },
    { level: 'error', source: 'DbStudio.Core.Sessions', message: 'Session broken: The connection was closed unexpectedly', detail: 'System.IO.IOException: Unable to read data from the transport connection.\n   at Microsoft.Data.SqlClient.SNI.SNITCPHandle.Receive(...)\n   at DbStudio.Core.Services.AdoSessionBase.ExecuteAsync(...)' },
    { level: 'debug', source: 'DbStudio.Host.Ws', message: 'WebSocket client cl_4f2 connected (2 subscribers)' },
    { level: 'info', source: 'DbStudio.Core.Services.StreamManager', message: 'Stream st_0007 ended (closed); delivered 1204, dropped 0' },
  ],
  errorlog: [
    { level: 'info', source: 'Server', message: 'SQL Server is starting at normal priority base (=7). This is an informational message only. No user action is required.' },
    { level: 'info', source: 'Backup', message: 'Database backed up. Database: Shop, creation date(time): 2026/10/18(02:00:01), pages dumped: 41234, first LSN: 1024:88:37, last LSN: 1024:112:1, number of dump devices: 1.' },
    { level: 'warn', source: 'Logon', message: "Login failed for user 'app'. Reason: Password did not match that for the login provided. [CLIENT: 10.0.4.17]", fields: { state: '8', client: '10.0.4.17' } },
    { level: 'error', source: 'spid52', message: 'Error: 1105, Severity: 17, State: 2.', detail: "Could not allocate space for object 'dbo.Orders'.'PK_Orders' in database 'Shop' because the 'PRIMARY' filegroup is full.", fields: { error: '1105', severity: '17', state: '2' } },
    { level: 'info', source: 'spid14s', message: 'Recovery is complete. This is an informational message only. No user action is required.' },
    { level: 'warn', source: 'spid61', message: 'SQL Server has encountered 3 occurrence(s) of I/O requests taking longer than 15 seconds to complete on file [D:\\Data\\Shop.mdf] in database id 7.' },
    { level: 'info', source: 'spid5s', message: "CHECKDB for database 'Shop' finished without errors on 2026-10-17 03:00:00.123 (local time)." },
    { level: 'error', source: 'spid73', message: 'Transaction (Process ID 73) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.', fields: { error: '1205', severity: '13' } },
    { level: 'info', source: 'Logon', message: "Login succeeded for user 'report'. Connection made using SQL Server authentication. [CLIENT: 10.0.4.30]" },
  ],
  agentlog: [
    { level: 'info', source: 'SQLAgent', message: "Job 'Nightly backup' completed successfully (duration 00:04:12)." },
    { level: 'warn', source: 'SQLAgent', message: '[396] An idle CPU condition has not been defined - OnIdle job schedules will have no effect' },
    { level: 'error', source: 'SQLAgent', message: "[298] SQLServer Error: 18456, Login failed for user 'NT SERVICE\\SQLSERVERAGENT'. [SQLSTATE 28000]" },
    { level: 'info', source: 'SQLAgent', message: "Job 'Index maintenance' started by schedule 3 (Sunday 01:00)." },
  ],
  alert: [
    { level: 'info', source: 'rdbms', message: 'Thread 1 advanced to log sequence 4211 (LGWR switch)' },
    { level: 'info', source: 'rdbms', message: 'Completed checkpoint up to RBA [0x106b.2.10], SCN: 88736421' },
    { level: 'warn', source: 'rdbms', message: 'WARNING: Heavy swapping observed on system in last 5 mins.' },
    { level: 'error', source: 'rdbms', message: 'ORA-01555 caused by SQL statement below (SQL ID: 7h35uxf5uhmm1, Query Duration=1824 sec, SCN: 0x0000.0a3f2c11):', detail: 'SELECT o.* FROM orders o JOIN order_lines l ON l.order_id = o.id', fields: { message_level: '1', sql_id: '7h35uxf5uhmm1' } },
    { level: 'info', source: 'rdbms', message: 'Starting background process SMCO' },
    { level: 'error', source: 'rdbms', message: 'ORA-00600: internal error code, arguments: [kdsgrp1], [], [], [], [], [], [], [], [], [], [], []', fields: { message_level: '1' } },
  ],
  serverlog: [
    { level: 'info', source: 'checkpointer', message: 'checkpoint starting: time' },
    { level: 'info', source: 'checkpointer', message: 'checkpoint complete: wrote 1234 buffers (7.5%); 0 WAL file(s) added, 0 removed, 1 recycled; write=26.954 s, sync=0.004 s, total=26.970 s' },
    { level: 'error', source: 'client backend', message: 'duplicate key value violates unique constraint "orders_pkey"', detail: 'DETAIL:  Key (id)=(1042) already exists.\nSTATEMENT:  INSERT INTO orders (id, customer_id) VALUES ($1, $2)', fields: { pid: '4321', sqlstate: '23505', user: 'app', database: 'shop' } },
    { level: 'fatal', source: 'client backend', message: 'password authentication failed for user "app"', fields: { pid: '4400', sqlstate: '28P01' } },
    { level: 'warn', source: 'client backend', message: 'there is no transaction in progress', fields: { pid: '4390', sqlstate: '25P01' } },
    { level: 'info', source: 'autovacuum worker', message: 'automatic vacuum of table "shop.public.orders": index scans: 1, pages: 0 removed, 812 remain' },
    { level: 'debug', source: 'autovacuum launcher', message: 'autovacuum: processing database "shop"' },
  ],
  pg_stat_statements: [
    { level: 'info', source: 'shop', message: 'SELECT * FROM orders WHERE customer_id = $1', fields: { calls: '18234', total_ms: '9123.4', mean_ms: '0.50', rows: '182340' } },
    { level: 'info', source: 'shop', message: 'UPDATE stock SET qty = qty - $1 WHERE product_id = $2', fields: { calls: '4021', total_ms: '22044.1', mean_ms: '5.48', rows: '4021' } },
  ],
  slowlog: [
    { level: 'warn', source: '10.0.0.5:51234', message: 'KEYS user:*', fields: { id: '0', durationUs: '12045', client: '10.0.0.5:51234', name: 'worker' } },
    { level: 'info', source: '10.0.0.7:40112', message: 'HGETALL session:7f3a9c', fields: { durationUs: '2210' } },
    { level: 'info', source: '10.0.0.5:51234', message: 'ZRANGEBYSCORE leaderboard 0 +inf WITHSCORES LIMIT 0 500', fields: { durationUs: '4120' } },
  ],
  latency: [
    { level: 'warn', source: 'command', message: 'command: latest 12 ms, max 48 ms', fields: { event: 'command', latest: '12', max: '48' } },
    { level: 'info', source: 'fork', message: 'fork: latest 3 ms, max 9 ms', fields: { event: 'fork' } },
  ],
  monitor: [
    { level: 'info', source: '10.0.0.5:51234 [0]', message: '"GET" "user:1001"' },
    { level: 'info', source: '10.0.0.7:40112 [0]', message: '"HSET" "session:7f3a9c" "lastSeen" "1760781600"' },
    { level: 'info', source: '10.0.0.5:51234 [0]', message: '"EXPIRE" "session:7f3a9c" "1800"' },
  ],
  getLog: [
    { level: 'info', source: 'NETWORK', message: 'Connection accepted', fields: { remote: '10.0.0.9:50122', connectionCount: '14' } },
    { level: 'warn', source: 'COMMAND', message: 'Slow query', fields: { ns: 'shop.orders', durationMillis: '154', planSummary: 'COLLSCAN' } },
    { level: 'info', source: 'NETWORK', message: 'Connection ended', fields: { remote: '10.0.0.9:50122' } },
    { level: 'error', source: 'CONTROL', message: 'Failed to refresh key cache', detail: '{"error":"ReadConcernMajorityNotAvailableYet"}' },
    { level: 'debug', source: 'STORAGE', message: 'WiredTiger message', fields: { message: '[1760781600:1][4242:0x7f], WT_SESSION.checkpoint: saving checkpoint snapshot min: 41' } },
  ],
  'profiler:shop': [
    { level: 'warn', source: 'shop.orders', message: 'find shop.orders 154 ms', fields: { millis: '154', planSummary: 'COLLSCAN', docsExamined: '120344' } },
    { level: 'info', source: 'shop.products', message: 'aggregate shop.products 22 ms', fields: { millis: '22', planSummary: 'IXSCAN { category: 1 }' } },
  ],
  changes: [
    { level: 'info', source: 'shop.orders', message: 'insert shop.orders { _id: ObjectId("6712f0c2a1b2c3d4e5f60718") }' },
    { level: 'info', source: 'shop.orders', message: 'update shop.orders { _id: ObjectId("6712f0c2a1b2c3d4e5f60718") } set status' },
  ],
  client: [
    { level: 'info', source: 'rdkafka#producer-1', message: '[thrd:main]: Telemetry: Using broker 127.0.0.1:9092/1' },
    { level: 'warn', source: 'rdkafka#consumer-2', message: '[thrd:127.0.0.1:9093/2]: 127.0.0.1:9093/2: Connection setup timed out in state CONNECT (after 30029ms in state CONNECT)' },
    { level: 'error', source: 'rdkafka#consumer-2', message: '[thrd:127.0.0.1:9093/2]: 127.0.0.1:9093/2: Connect to ipv4#127.0.0.1:9093 failed: Connection refused (after 0ms in state CONNECT)' },
  ],
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/** Fixture size: 1,500 entries spread over 7 days, denser towards now (~115 in the last hour). */
export const MOCK_LOG_SIZE = 1500;

interface Store {
  entries: LogEntry[];
  nextSeq: number;
  /** Next template index for live entries. */
  live: number;
}

function generate(sourceId: string, archive: number, now: number): Store {
  const tpls = TEMPLATES[sourceId] ?? TEMPLATES.engine;
  const r = rng(hash(`${sourceId}|${archive}`));
  const n = sourceId === 'getLog' ? 1024 : sourceId === 'pg_stat_statements' || sourceId === 'latency' ? 40 : MOCK_LOG_SIZE;
  const base = archive * 1_000_000;
  const shift = archive * 7 * day;
  const entries: LogEntry[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const t = tpls[Math.floor(r() * tpls.length)];
    const ts = new Date(now - shift - Math.round(k * k * 265 + r() * 200)).toISOString();
    entries.push({ ts, level: t.level, source: t.source, message: t.message, detail: t.detail ?? null, ...(t.fields ? { fields: { ...t.fields } } : {}), seq: base + (n - k) });
  }
  return { entries, nextSeq: base + n + 1, live: 0 };
}

const LIVE_ONLY = new Set(['monitor', 'changes']);

function matches(e: LogEntry, levels: Set<string> | null, q: string | null, from: number | null, to: number | null): boolean {
  if (levels && !levels.has(e.level)) return false;
  if (q && !`${e.message}\u0001${e.source}\u0001${e.detail ?? ''}`.toLowerCase().includes(q)) return false;
  const t = e.ts ? Date.parse(e.ts) : null;
  if (from != null && t != null && t < from) return false;
  if (to != null && t != null && t > to) return false;
  return true;
}

// ---------------------------------------------------------------- activity fixtures

function sessionRows(providerId: string, connectionId: string, streams: M2MockContext['streams']): ActivityRow[] {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const jitter = () => Math.round(Math.random() * 2000);
  switch (providerId) {
    case 'sqlserver': {
      const k = (id: string) => ({ killStatement: `KILL ${id}` });
      return [
        { id: '52', kind: 'session', user: 'app', host: 'web-01', app: '.Net SqlClient Data Provider', database: 'Shop', state: 'sleeping', command: 'AWAITING COMMAND', since: ago(1_200_000), durationMs: 1_200_000, canKill: true, fields: k('52') },
        { id: '57', kind: 'session', user: 'etl', host: 'etl-02', app: 'SSIS-Package', database: 'Shop', state: 'running', command: 'UPDATE', text: 'UPDATE dbo.Orders SET Status = 2 WHERE OrderDate < @p0', since: ago(95_000), durationMs: 95_000 + jitter(), cpu: 81_234, reads: 552_301, canKill: true, fields: { ...k('57'), locks: '1204' } },
        { id: '61', kind: 'session', user: 'app', host: 'web-02', app: 'Shop.Web', database: 'Shop', state: 'suspended', command: 'UPDATE', waitType: 'LCK_M_U', blockedBy: '57', text: 'UPDATE dbo.Orders SET ShippedAt = SYSUTCDATETIME() WHERE Id = @id', since: ago(64_000), durationMs: 64_000 + jitter(), cpu: 12, reads: 40, canKill: true, fields: k('61') },
        { id: '64', kind: 'session', user: 'report', host: 'bi-01', app: 'Power BI', database: 'Shop', state: 'suspended', command: 'SELECT', waitType: 'LCK_M_S', blockedBy: '57', text: 'SELECT * FROM dbo.Orders WHERE Id = @id', since: ago(31_000), durationMs: 31_000 + jitter(), cpu: 3, reads: 12, canKill: true, fields: k('64') },
        { id: '70', kind: 'session', user: 'app', host: 'web-01', app: 'Shop.Web', database: 'Shop', state: 'suspended', command: 'INSERT', waitType: 'LCK_M_IX', blockedBy: '61', text: 'INSERT INTO dbo.OrderEvents (OrderId, Kind) VALUES (@id, 3)', since: ago(12_000), durationMs: 12_000 + jitter(), canKill: true, fields: k('70') },
        { id: '75', kind: 'session', user: 'app', host: 'web-03', app: 'Shop.Web', database: 'Shop', state: 'running', command: 'SELECT', text: 'SELECT TOP (100) * FROM dbo.Products ORDER BY Name', since: ago(350), durationMs: 350, cpu: 20, reads: 310, canKill: true, fields: k('75') },
        { id: '80', kind: 'session', user: 'sa', host: 'dba-laptop', app: 'Rowlit', database: 'master', state: 'sleeping', command: 'AWAITING COMMAND', since: ago(5_000), canKill: true, fields: k('80') },
        { id: 'lock:OBJECT:Shop.dbo.Orders:57', kind: 'lock', database: 'Shop', state: 'GRANT', canKill: false, fields: { resource: 'OBJECT: Shop.dbo.Orders', mode: 'IX', count: '1', owner: '57' } },
        { id: 'lock:KEY:Shop.dbo.Orders:61', kind: 'lock', database: 'Shop', state: 'WAIT', blockedBy: '57', canKill: false, fields: { resource: 'KEY: Shop.dbo.Orders (8194443284a0)', mode: 'U', count: '1', owner: '61' } },
      ];
    }
    case 'oracle': {
      const k = (id: string) => ({ killStatement: `ALTER SYSTEM KILL SESSION '${id}' IMMEDIATE` });
      return [
        { id: '123,4567', kind: 'session', user: 'APP', host: 'web-01', app: 'JDBC Thin Client', database: 'SHOP', state: 'ACTIVE', command: 'UPDATE', text: 'UPDATE orders SET status = :1 WHERE id = :2', durationMs: 48_000 + jitter(), waitType: 'enq: TX - row lock contention', blockedBy: '98,1201', canKill: true, fields: k('123,4567') },
        { id: '98,1201', kind: 'session', user: 'ETL', host: 'etl-02', app: 'sqlplus@etl-02', database: 'SHOP', state: 'INACTIVE', command: 'UPDATE', text: 'UPDATE orders SET status = 2 WHERE order_date < SYSDATE - 30', durationMs: 300_000, canKill: true, fields: k('98,1201') },
        { id: '140,22', kind: 'session', user: 'REPORT', host: 'bi-01', app: 'Toad.exe', database: 'SHOP', state: 'ACTIVE', command: 'SELECT', text: 'SELECT COUNT(*) FROM order_lines', durationMs: 4_200 + jitter(), waitType: 'db file scattered read', canKill: true, fields: k('140,22') },
      ];
    }
    case 'postgresql': {
      const k = (id: string) => ({ killStatement: `SELECT pg_terminate_backend(${id})`, cancelStatement: `SELECT pg_cancel_backend(${id})` });
      return [
        { id: '4321', kind: 'session', user: 'app', host: '10.0.0.5', app: 'shop-api', database: 'shop', state: 'idle in transaction', command: 'UPDATE', text: 'UPDATE stock SET qty = qty - 1 WHERE product_id = 42', durationMs: 180_000, waitType: 'Client: ClientRead', canKill: true, fields: k('4321') },
        { id: '4390', kind: 'session', user: 'app', host: '10.0.0.6', app: 'shop-api', database: 'shop', state: 'active', command: 'UPDATE', text: 'UPDATE stock SET qty = qty - 3 WHERE product_id = 42', durationMs: 41_000 + jitter(), waitType: 'Lock: transactionid', blockedBy: '4321', canKill: true, fields: k('4390') },
        { id: '4402', kind: 'session', user: 'report', host: '10.0.0.30', app: 'metabase', database: 'shop', state: 'active', command: 'SELECT', text: 'SELECT date_trunc(\'day\', created_at), count(*) FROM orders GROUP BY 1', durationMs: 7_800 + jitter(), canKill: true, fields: k('4402') },
        { id: '4410', kind: 'session', user: 'postgres', host: '127.0.0.1', app: 'Rowlit', database: 'shop', state: 'idle', durationMs: 2_000, canKill: true, fields: k('4410') },
      ];
    }
    case 'redis':
      return [
        { id: '12', kind: 'client', host: '10.0.0.5:51234', app: 'worker', database: '0', state: 'active', command: 'blpop', durationMs: 3_600_000, canKill: true, fields: { killStatement: 'CLIENT KILL ID 12', flags: 'b', idle: '0' } },
        { id: '15', kind: 'client', host: '10.0.0.7:40112', app: 'shop-api', database: '0', state: 'idle', command: 'get', durationMs: 86_400_000, canKill: true, fields: { killStatement: 'CLIENT KILL ID 15', idle: '12' } },
        { id: '21', kind: 'client', host: '127.0.0.1:60110', app: 'dbstudio', database: '0', state: 'active', command: 'client|list', durationMs: 4_000, canKill: true, fields: { killStatement: 'CLIENT KILL ID 21' } },
      ];
    case 'mongodb':
      return [
        { id: '12345', kind: 'op', user: 'app', host: '10.0.0.9:50122', app: 'shop-api', database: 'shop.orders', state: 'active', command: 'find', text: '{ "find": "orders", "filter": { "status": "open" } }', durationMs: 154_000, canKill: true, fields: { killStatement: 'db.killOp(12345)', opid: '12345', planSummary: 'COLLSCAN' } },
        { id: '12350', kind: 'op', user: 'etl', host: '10.0.0.12:50500', app: 'mongosh', database: 'shop.products', state: 'active', command: 'aggregate', text: '{ "aggregate": "products", "pipeline": [ { "$group": { "_id": "$category" } } ] }', durationMs: 2_300 + jitter(), waitType: 'waitingForLock', blockedBy: '12345', canKill: true, fields: { killStatement: 'db.killOp(12350)' } },
      ];
    case 'kafka':
      return [
        ...streams.list().filter((s) => s.connectionId === connectionId).map((s): ActivityRow => ({
          id: s.streamId, kind: 'op', state: s.state, command: s.kind, since: s.openedAt, durationMs: Date.now() - Date.parse(s.openedAt), canKill: true,
          text: `delivered ${s.delivered}, dropped ${s.dropped}`, fields: { killStatement: `Close stream ${s.streamId}` },
        })),
        { id: 'j_fetch01', kind: 'op', state: 'running', command: 'kafka.fetch', text: 'orders: timestamp search over 12 partitions', durationMs: 8_200 + jitter(), canKill: true, fields: { killStatement: 'Cancel job j_fetch01' } },
        { id: 'group:shop-billing', kind: 'op', state: 'Stable', command: 'consumer group', text: '3 members, lag 1,204', canKill: false },
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- handlers

export function createLogsHandlers(ctx: M2MockContext): RequestHandler[] {
  const { engine, streams, jobs, ok } = ctx;
  const stores = new Map<string, Store>();
  const killed = new Map<string, Set<string>>();
  const cancelled = new Map<string, Set<string>>();

  const providerOf = (cid: string): string | null => (cid === ENGINE ? ENGINE : engine.conn(cid)?.providerId ?? null);
  /** Source info for (cid, sourceId); `engine` is accepted under any cid. */
  const sourceOf = (cid: string, sourceId: string): { info: Src; key: string } | null => {
    if (sourceId === ENGINE) return { info: mockLogSources(ENGINE)[0], key: ENGINE };
    const p = providerOf(cid);
    const info = p ? mockLogSources(p).find((s) => s.id === sourceId && s.kind === 'log') : undefined;
    return info ? { info, key: `${cid}|${sourceId}` } : null;
  };
  const storeOf = (key: string, sourceId: string, archive = 0): Store => {
    const k = `${key}|${archive}`;
    let s = stores.get(k);
    if (!s) {
      s = generate(sourceId, archive, Date.now());
      if (LIVE_ONLY.has(sourceId)) s.entries = [];
      stores.set(k, s);
    }
    return s;
  };

  function query(cid: string, body: Partial<LogQuery>): Response | LogQueryResponse {
    if (!providerOf(cid)) return err(404, 'NOT_FOUND', `Connection '${cid}' was not found.`);
    if (!body.sourceId) return err(400, 'VALIDATION', 'sourceId is required.', { field: 'sourceId' });
    const limit = body.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) return err(400, 'VALIDATION', 'limit must be between 1 and 5000.', { field: 'limit' });
    const s = sourceOf(cid, body.sourceId);
    if (!s) return err(404, 'NOT_FOUND', `Unknown log source '${body.sourceId}'.`);
    if (!s.info.available) return err(403, 'PRIVILEGE', s.info.reason ?? 'Permission denied.', { needs: s.info.needs });
    if (!s.info.supportsRange) return err(400, 'VALIDATION', `${s.info.title} is live only; open a logs.tail stream.`, { field: 'sourceId' });
    const store = storeOf(s.key, s.info.id, body.archive ?? 0);
    const levels = body.levels?.length ? new Set(body.levels) : null;
    const q = body.q?.trim().toLowerCase() || null;
    const from = body.from ? Date.parse(body.from) : null;
    const to = body.to ? Date.parse(body.to) : null;
    const before = body.before ?? null;
    const hits = store.entries.filter((e) => (before == null || e.seq < before) && matches(e, levels, q, from, to));
    const entries = hits.slice(Math.max(0, hits.length - limit));
    return { entries, hasMore: hits.length > entries.length, truncated: s.info.id === 'getLog' };
  }

  function snapshot(cid: string): ActivityRow[] {
    const p = providerOf(cid) ?? '';
    const gone = killed.get(cid) ?? new Set<string>();
    const idle = cancelled.get(cid) ?? new Set<string>();
    return sessionRows(p, cid, streams)
      .filter((r) => !gone.has(r.id) && !(r.fields?.owner && gone.has(r.fields.owner)))
      .map((r) => {
        let row = r.blockedBy && gone.has(r.blockedBy) ? { ...r, blockedBy: undefined, waitType: undefined, state: r.kind === 'lock' ? 'GRANT' : 'running' } : r;
        if (idle.has(row.id)) row = { ...row, state: 'idle', durationMs: undefined, waitType: undefined };
        return row;
      });
  }

  // logs.tail: a few entries per second (MONITOR is auto-stopped after 10 minutes, like the engine).
  streams.register('logs.tail', ({ connectionId, params, push, end, signal }) => {
    const sourceId = String(params.sourceId ?? '');
    const s = sourceOf(connectionId, sourceId);
    if (!s || !s.info.available || !s.info.supportsTail) {
      end(!s ? `Unknown log source '${sourceId}'` : !s.info.available ? `PRIVILEGE: ${s.info.needs ?? 'permission denied'}` : 'This source cannot be tailed');
      return;
    }
    const store = storeOf(s.key, s.info.id);
    const tpls = TEMPLATES[s.info.id] ?? TEMPLATES.engine;
    const levels = Array.isArray(params.levels) && params.levels.length ? new Set(params.levels as string[]) : null;
    const q = typeof params.q === 'string' && params.q.trim() ? params.q.trim().toLowerCase() : null;
    const tick = () => {
      const n = 1 + Math.floor(Math.random() * 3);
      const items: LogEntry[] = [];
      for (let i = 0; i < n; i++) {
        const t = tpls[store.live++ % tpls.length];
        const e: LogEntry = { ts: new Date().toISOString(), level: t.level, source: t.source, message: t.message, detail: t.detail ?? null, ...(t.fields ? { fields: { ...t.fields } } : {}), seq: store.nextSeq++ };
        store.entries.push(e);
        if (store.entries.length > 50_000) store.entries.splice(0, store.entries.length - 50_000);
        if (matches(e, levels, q, null, null)) items.push(e);
      }
      push(items);
    };
    // `after`: resume after the caller's newest entry (entries it does not have yet come first).
    const after = typeof params.after === 'number' ? params.after : null;
    const backlog = after != null ? store.entries.filter((e) => e.seq > after && matches(e, levels, q, null, null)) : [];
    const first = setTimeout(() => {
      if (backlog.length) push(backlog);
      tick();
    }, 40);
    const timer = setInterval(tick, 400);
    // MONITOR: a final marker entry (fields.autoStopped), then the stream completes (like the engine).
    const limitMs = Math.max(1, Number(params.maxMinutes) || 10) * 60_000;
    const stop = s.info.id === 'monitor' ? setTimeout(() => {
      push([{ ts: new Date().toISOString(), level: 'warn', source: 'monitor', message: `MONITOR stopped after ${limitMs / 60_000} minutes to protect the server. Extend to keep watching.`, detail: null, fields: { autoStopped: 'true' }, seq: store.nextSeq++ }]);
      end('completed');
    }, Math.min(limitMs, MONITOR_LIMIT_MS)) : null;
    signal.addEventListener('abort', () => {
      clearTimeout(first);
      clearInterval(timer);
      if (stop) clearTimeout(stop);
    });
  });

  // activity.poll: a full snapshot every intervalMs (first one right away).
  streams.register('activity.poll', ({ connectionId, params, push, end, signal }) => {
    const p = providerOf(connectionId);
    if (!p || !mockLogSources(p).some((x) => x.kind === 'activity')) {
      end('Activity is not available for this connection');
      return;
    }
    const interval = Math.max(250, Number(params.intervalMs) || 2000);
    const tick = () => push([{ ts: new Date().toISOString(), sessions: snapshot(connectionId) }]);
    const first = setTimeout(tick, 30);
    const timer = setInterval(tick, interval);
    signal.addEventListener('abort', () => {
      clearTimeout(first);
      clearInterval(timer);
    });
  });

  return [
    http.get(`${P}/logs/:cid/sources`, ({ params }) => {
      const cid = String(params.cid);
      const p = providerOf(cid);
      if (!p) return err(404, 'NOT_FOUND', `Connection '${cid}' was not found.`);
      return ok(mockLogSources(p));
    }),

    http.post(`${P}/logs/:cid/query`, async ({ params, request }) => {
      const body = (await request.json().catch(() => ({}))) as Partial<LogQuery>;
      const r = query(String(params.cid), body);
      return r instanceof Response ? r : ok(r as never);
    }),

    http.post(`${P}/logs/:cid/kill`, async ({ params, request }) => {
      const cid = String(params.cid);
      const conn = engine.conn(cid);
      if (!conn) return err(404, 'NOT_FOUND', `Connection '${cid}' was not found.`);
      const body = (await request.json().catch(() => ({}))) as Partial<LogKillRequest>;
      if (!body.id) return err(400, 'VALIDATION', 'id is required.', { field: 'id' });
      if (conn.readOnly) return err(403, 'READ_ONLY', `'${conn.name}' is read-only: killing sessions is not allowed.`);
      const row = snapshot(cid).find((r) => r.id === body.id);
      if (!row) return ok({ killed: false, message: `${body.id} is no longer running.` });
      if (!row.canKill) return err(400, 'VALIDATION', `${body.id} cannot be killed.`, { field: 'id' });
      if (body.mode === 'cancel') {
        if (!cancelled.has(cid)) cancelled.set(cid, new Set());
        cancelled.get(cid)!.add(row.id);
        return ok({ killed: true, message: `Query of backend ${row.id} cancelled.` });
      }
      if (!killed.has(cid)) killed.set(cid, new Set());
      killed.get(cid)!.add(row.id);
      if (conn.providerId === 'kafka' && row.id.startsWith('st_')) streams.stop(row.id, 'ended', 'closed');
      return ok({ killed: true, message: `${row.fields?.killStatement ?? `Kill ${row.id}`}: done.` });
    }),

    http.post(`${P}/logs/:cid/export`, async ({ params, request }) => {
      const cid = String(params.cid);
      const body = (await request.json().catch(() => ({}))) as Partial<LogExportRequest>;
      if (body.format && !['txt', 'csv', 'json'].includes(body.format)) return err(400, 'VALIDATION', 'format must be txt, csv or json.', { field: 'format' });
      const r = query(cid, { ...body, limit: Math.min(body.limit ?? 5000, 5000) });
      if (r instanceof Response) return r;
      const format = body.format ?? 'txt';
      const content = formatEntries((r as LogQueryResponse).entries, format);
      const filename = exportFileName(body.sourceId ?? 'log', format);
      if (!body.path) {
        return new HttpResponse(content, {
          status: 200,
          headers: { 'Content-Type': format === 'json' ? 'application/x-ndjson' : format === 'csv' ? 'text/csv' : 'text/plain', 'Content-Disposition': `attachment; filename="${filename}"` },
        });
      }
      const path = body.path;
      const count = (r as LogQueryResponse).entries.length;
      const jobId = jobs.start('logs.export', async (report) => {
        report(count, count, `Wrote ${count} entries`);
        return { path, entries: count };
      });
      return ok({ jobId }, { status: 202 });
    }),
  ];
}

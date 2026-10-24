// In-memory fake of the Rowlit engine: connections, catalog, sessions, streaming execution, history.
// Used by `npm run dev:mock` (through MSW + FakeSocket) and by component tests.
import type {
  CatalogObject, CatalogSchema, CatalogSnapshot, CellValue, ColumnInfo, ConnectionInput, ConnectionProfile, DatabasesResponse,
  DdlResponse, Dialect, ExecuteRequest, HistoryEntry, ObjectDetails, ObjectRef, SchemasResponse, SessionInfo, Settings, TxMode, WsEvent,
} from '../api/types';
import { DEFAULT_SETTINGS } from '../store/settings';
import { catalogObject, columnInfos, EXTRA_OBJECTS, generateRows, initialConnections, pgShopTables, PROVIDERS, SHOP_TABLES, type FixtureTable } from './fixtures';
import { MOCK_PACKS } from './packs';

type Listener = (ev: WsEvent) => void;

interface MockSession extends SessionInfo {
  cancel: boolean;
  lastResults: { executionId: string; sets: { columns: ColumnInfo[]; rows: CellValue[][] }[] } | null;
}

interface SchemaState {
  name: string;
  version: number;
  objects: CatalogObject[];
  tables: Map<string, FixtureTable>;
}

const DIALECT: Record<string, Dialect> = {
  sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite', postgresql: 'pgsql',
  // Batch 3 packs: the dialect of their providers
  ...Object.fromEntries(MOCK_PACKS.flatMap((p) => p.providers).filter((p) => p.dialect).map((p) => [p.id, p.dialect as Dialect])),
};
const packShop = (pid: string | undefined) => (pid ? MOCK_PACKS.map((p) => p.shop?.[pid]).find((x) => x) : undefined);

/** The PostgreSQL shop tables (built once: their rows are cached per table object). */
let pgTables: FixtureTable[] | null = null;
const pgShop = () => (pgTables ??= pgShopTables());
const ts = () => new Date().toISOString();
let idSeq = 0;
const nextId = (p: string) => `${p}_${(++idSeq).toString(36)}${Date.now().toString(36)}`;

const rowCache = new Map<FixtureTable, CellValue[][]>();
function tableRows(t: FixtureTable): CellValue[][] {
  let r = rowCache.get(t);
  if (!r) {
    r = generateRows(t);
    rowCache.set(t, r);
  }
  return r;
}

export interface MockEngineOptions {
  /** Delay before REST responses resolve (ms). */
  latency?: number;
  /** Rows per exec.rows frame. */
  frameRows?: number;
  /** Delay between frames (ms); 0 = as fast as possible. */
  frameDelay?: number;
}

export class MockEngine {
  connections: ConnectionProfile[] = initialConnections();
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  sessions = new Map<string, MockSession>();
  history: HistoryEntry[] = [];
  private listeners = new Set<Listener>();
  private catalogs = new Map<string, Map<string, SchemaState>>();
  private historySeq = 0;
  opts: Required<MockEngineOptions>;

  constructor(opts: MockEngineOptions = {}) {
    this.opts = { latency: opts.latency ?? 0, frameRows: opts.frameRows ?? 500, frameDelay: opts.frameDelay ?? 4 };
  }

  // ---------- events ----------
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(ev: Omit<WsEvent, 'ts'> & { type: WsEvent['type'] }): void {
    const full = { ...ev, ts: ts() } as WsEvent;
    for (const l of [...this.listeners]) l(full);
  }

  providers() {
    return PROVIDERS;
  }

  // ---------- connections ----------
  conn(id: string): ConnectionProfile | undefined {
    return this.connections.find((c) => c.id === id);
  }
  createConnection(input: ConnectionInput): ConnectionProfile {
    const { password, ...rest } = input;
    const c: ConnectionProfile = { ...rest, id: nextId('c'), hasPassword: !!password, createdAt: ts(), lastUsedAt: null };
    this.connections.push(c);
    return c;
  }
  updateConnection(id: string, input: ConnectionInput): ConnectionProfile | null {
    const cur = this.conn(id);
    if (!cur) return null;
    const { password, ...rest } = input;
    const next: ConnectionProfile = { ...cur, ...rest, hasPassword: password === null ? cur.hasPassword : password !== '' };
    this.connections = this.connections.map((c) => (c.id === id ? next : c));
    this.catalogs.delete(id);
    return next;
  }
  deleteConnection(id: string) {
    this.connections = this.connections.filter((c) => c.id !== id);
  }
  test(profile: { providerId: string; props: Record<string, unknown> }) {
    const p = profile.props;
    const host = String(p.server ?? p.host ?? p.path ?? '');
    if (!host || /fail|nowhere/i.test(host)) {
      return { ok: false, serverInfo: null, elapsedMs: 31, error: { code: 'PROVIDER_ERROR', message: `Cannot open ${host || 'connection'}: host not found`, providerCode: 53 } };
    }
    return { ok: true, serverInfo: this.serverInfo(profile.providerId, p), elapsedMs: 42, error: null };
  }
  serverInfo(providerId: string, props: Record<string, unknown>) {
    if (providerId === 'sqlserver') return { version: 'Microsoft SQL Server 2022 (RTM-CU15) - 16.0.4145.4 (X64)', productVersion: '16.0.4145.4', serverName: String(props.server ?? 'HOST'), user: String(props.user ?? 'sa'), database: String(props.database || 'master') };
    if (providerId === 'oracle') return { version: 'Oracle Database 23ai Free Release 23.0.0.0.0', productVersion: '23.5.0.24.07', serverName: String(props.host ?? 'ora'), user: String(props.user ?? 'SHOP').toUpperCase(), database: 'FREEPDB1' };
    if (providerId === 'postgresql') {
      return {
        version: 'PostgreSQL 17.2 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 12.2.0, 64-bit', productVersion: '17.2',
        serverName: String(props.host ?? 'localhost'), user: String(props.user ?? 'postgres'), database: String(props.database || 'postgres'),
      };
    }
    const ps = packShop(providerId);
    if (ps?.serverInfo) return { ...ps.serverInfo, serverName: String(props.host ?? 'localhost'), user: String(props.user ?? ''), database: String(props.database || ps.schema) };
    return { version: 'SQLite 3.46.1', productVersion: '3.46.1', serverName: null, user: null, database: 'main' };
  }

  // ---------- catalog ----------
  private schemasFor(cid: string): Map<string, SchemaState> {
    let m = this.catalogs.get(cid);
    if (m) return m;
    m = new Map();
    const c = this.conn(cid);
    const pid = c?.providerId ?? 'sqlite';
    const make = (name: string, tables: FixtureTable[], extra: CatalogObject[], upper = false) => {
      const tmap = new Map<string, FixtureTable>();
      for (const t of tables) tmap.set((upper ? t.name.toUpperCase() : t.name).toLowerCase(), t);
      m!.set(name, { name, version: 1, objects: [...tables.map((t) => catalogObject(t, name, upper)), ...extra], tables: tmap });
    };
    if (pid === 'sqlserver') {
      make('dbo', SHOP_TABLES, EXTRA_OBJECTS.sqlserver);
      make('Sales', SHOP_TABLES.filter((t) => t.name === 'orders' || t.name === 'order_lines'), []);
      make('audit', [], []);
    } else if (pid === 'oracle') {
      make('SHOP', SHOP_TABLES, EXTRA_OBJECTS.oracle, true);
      make('HR', SHOP_TABLES.filter((t) => t.name === 'countries'), [], true);
    } else if (pid === 'postgresql') {
      make('public', pgShop(), EXTRA_OBJECTS.postgresql);
      make('sales', pgShop().filter((t) => t.name === 'orders' || t.name === 'order_lines'), []);
    } else {
      // Batch 3 providers (mocks/packs) get the SQLite shop plus their pack's catalog extras
      const packExtra = MOCK_PACKS.map((p) => p.extraObjects[pid]).find((x) => x);
      const ps = packShop(pid);
      const tables = ps?.type
        ? SHOP_TABLES.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, type: ps.type!(c.type) })) }))
        : SHOP_TABLES;
      make(ps?.schema ?? 'main', tables, packExtra ?? EXTRA_OBJECTS.sqlite, !!ps?.upperCase);
      for (const extra of ps?.schemas ?? []) make(extra, [], [], !!ps?.upperCase);
    }
    this.catalogs.set(cid, m);
    return m;
  }
  defaultSchema(cid: string): string {
    const pid = this.conn(cid)?.providerId;
    return pid === 'sqlserver' ? 'dbo' : pid === 'oracle' ? 'SHOP' : pid === 'postgresql' ? 'public' : packShop(pid)?.schema ?? 'main';
  }
  databases(cid: string): DatabasesResponse {
    const pid = this.conn(cid)?.providerId;
    if (pid === 'sqlserver') return { databases: ['master', 'Shop', 'Staging'], current: 'Shop' };
    if (pid === 'oracle') return { databases: [], current: 'SHOP' };
    if (pid === 'postgresql') return { databases: ['analytics', 'postgres', 'shop'], current: String(this.conn(cid)?.props.database || 'shop') };
    const ps = packShop(pid);
    if (ps) {
      const list = ps.databases ?? [ps.schema];
      const wanted = String(this.conn(cid)?.props.database ?? '');
      return { databases: list, current: list.includes(wanted) ? wanted : list[0] ?? ps.schema };
    }
    return { databases: ['main'], current: 'main' };
  }
  schemas(cid: string, database: string | null): SchemasResponse {
    const m = this.schemasFor(cid);
    const pid = this.conn(cid)?.providerId;
    const list = (pid === 'sqlserver' && database && database !== 'Shop') || (pid === 'postgresql' && database && database !== 'shop')
      ? [...m.values()].filter((s) => s.name === this.defaultSchema(cid))
      : [...m.values()];
    // PostgreSQL: position on the search_path (array_position(current_schemas(true), …): pg_catalog is 1).
    const sp = (name: string) => (pid === 'postgresql' && name === 'public' ? { searchPathIndex: 2 } : {});
    return { database, defaultSchema: this.defaultSchema(cid), schemas: list.map((s) => ({ name: s.name, loaded: false, objectCount: s.objects.length, ...sp(s.name) })) };
  }
  catalog(cid: string, database: string | null, schemas: string[] | null): CatalogSnapshot {
    const m = this.schemasFor(cid);
    const names = schemas?.length ? schemas : [this.defaultSchema(cid)];
    const out: CatalogSchema[] = [];
    for (const n of names) {
      const s = m.get(n);
      if (s) out.push({ name: s.name, version: s.version, objects: s.objects });
    }
    return {
      connectionId: cid, dialect: DIALECT[this.conn(cid)?.providerId ?? 'sqlite'], database, defaultSchema: this.defaultSchema(cid),
      version: Math.max(1, ...out.map((s) => s.version)), databases: this.databases(cid).databases, schemas: out,
      ...(this.conn(cid)?.providerId === 'postgresql' ? { searchPath: ['public'] } : {}),
    };
  }
  schemaVersion(cid: string, schemas: string[] | null): number {
    const m = this.schemasFor(cid);
    return (schemas?.length ? schemas : [this.defaultSchema(cid)]).reduce((a, n) => a + (m.get(n)?.version ?? 0), 0);
  }
  private findTable(cid: string, schema: string | null, name: string): { schema: SchemaState; table: FixtureTable } | null {
    const m = this.schemasFor(cid);
    const key = name.replace(/^["[`]|["\]`]$/g, '').toLowerCase();
    const order = schema ? [m.get(schema), ...m.values()] : [m.get(this.defaultSchema(cid)), ...m.values()];
    for (const s of order) {
      if (!s) continue;
      const t = s.tables.get(key);
      if (t) return { schema: s, table: t };
    }
    return null;
  }
  ddl(cid: string, ref: ObjectRef): DdlResponse {
    if (this.conn(cid)?.providerId === 'postgresql') {
      const pg = pgObjectDdl(ref);
      if (pg) return pg;
    }
    const f = this.findTable(cid, ref.schema, ref.name);
    if (f) return { ddl: f.table.ddl, source: 'stored' };
    if (ref.type === 'trigger') return { ddl: 'CREATE TRIGGER trg_orders_audit AFTER UPDATE ON orders\nBEGIN\n  INSERT INTO audit_log(order_id, changed_at) VALUES (NEW.id, CURRENT_TIMESTAMP);\nEND;', source: 'stored' };
    if (ref.type === 'proc') return { ddl: `CREATE PROCEDURE ${ref.schema}.${ref.name} @Id int\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SELECT * FROM dbo.customers WHERE id = @Id;\nEND`, source: 'stored' };
    if (ref.type === 'package') return { ddl: `CREATE OR REPLACE PACKAGE ${ref.name} AS\n  PROCEDURE create_order(p_cust IN NUMBER, p_total IN NUMBER);\n  FUNCTION get_total(p_id NUMBER) RETURN NUMBER;\nEND ${ref.name};\n/`, source: 'stored' };
    return { ddl: `-- ${ref.type} ${ref.name}\n-- (definition not available in the mock engine)`, source: 'generated' };
  }
  details(cid: string, ref: ObjectRef): ObjectDetails {
    const f = this.findTable(cid, ref.schema, ref.name);
    const pid = this.conn(cid)?.providerId;
    const upper = pid === 'oracle';
    const pg = pid === 'postgresql';
    const n = (s: string) => (upper ? s.toUpperCase() : s);
    const t = f?.table;
    const boolDefault = pg ? 'true' : '1';
    const routine = pg && (ref.type === 'proc' || ref.type === 'func' || ref.type === 'tablefunc')
      ? this.schemasFor(cid).get(ref.schema ?? 'public')?.objects.find((o) => o.n === ref.name && o.t === ref.type)
      : null;
    return {
      ref,
      columns: (t?.columns ?? []).map((c, i) => ({
        name: n(c.name), type: c.type, nullable: c.nullable, default: c.identity ? null : c.kind === 'bool' ? boolDefault : null, isPk: !!c.pk,
        isIdentity: !!c.identity, isComputed: false, comment: c.comment ?? null, ordinal: i + 1,
      })),
      indexes: t ? [
        ...(t.columns.some((c) => c.pk) ? [{ name: n(`pk_${t.name}`), unique: true, columns: t.columns.filter((c) => c.pk).map((c) => n(c.name)), type: 'btree', isPrimaryKey: true }] : []),
        ...t.columns.filter((c) => c.fk).map((c) => ({ name: n(`ix_${t.name}_${c.name}`), unique: false, columns: [n(c.name)], type: 'btree', isPrimaryKey: false })),
      ] : [],
      foreignKeys: (t?.columns ?? []).filter((c) => c.fk).map((c) => ({ name: n(`fk_${t!.name}_${c.fk!.table}`), columns: [n(c.name)], refSchema: f!.schema.name, refTable: n(c.fk!.table), refColumns: [n(c.fk!.column)] })),
      referencedBy: t ? SHOP_TABLES.flatMap((o) => o.columns.filter((c) => c.fk?.table === t.name).map((c) => ({ schema: f!.schema.name, table: n(o.name), constraint: n(`fk_${o.name}_${t.name}`), columns: [n(c.name)] }))) : [],
      triggers: t?.name === 'orders' ? [pg ? 'trg_orders_check' : 'trg_orders_audit'] : [],
      parameters: routine
        ? (routine.p ?? []).map(([name, typeText, direction, hasDefault]) => ({ name, typeText, direction, hasDefault: hasDefault === 1 }))
        : ref.type === 'proc' || ref.type === 'func' ? [{ name: '@Id', typeText: 'int', direction: 'in', hasDefault: false }] : [],
      rowCountEstimate: t ? t.rowCount : null,
      // PostgreSQL does not record creation / modification times.
      created: pg ? null : '2025-01-03T10:00:00',
      modified: pg ? null : '2026-09-30T16:20:00',
    };
  }

  // ---------- sessions ----------
  createSession(connectionId: string, database: string | null, txMode: TxMode): SessionInfo | null {
    const c = this.conn(connectionId);
    if (!c) return null;
    c.lastUsedAt = ts();
    const s: MockSession = {
      sessionId: nextId('s'), connectionId, serverInfo: this.serverInfo(c.providerId, c.props), database: database ?? this.databases(connectionId).current,
      txMode, txOpen: false, state: 'idle', dialect: DIALECT[c.providerId], cancel: false, lastResults: null,
    };
    this.sessions.set(s.sessionId, s);
    return this.info(s);
  }
  info(s: MockSession): SessionInfo {
    const { cancel: _c, lastResults: _l, ...rest } = s;
    void _c;
    void _l;
    return { ...rest };
  }
  changed(s: MockSession) {
    this.emit({ type: 'session.changed', sessionId: s.sessionId, state: s.state, txOpen: s.txOpen, database: s.database, txMode: s.txMode } as WsEvent);
  }

  // ---------- execution ----------
  execute(sid: string, req: ExecuteRequest): { executionId: string } | { error: string; code: string } {
    const s = this.sessions.get(sid);
    if (!s) return { error: 'Session not found', code: 'NOT_FOUND' };
    if (s.state === 'executing') return { error: 'The session is executing another statement', code: 'SESSION_BUSY' };
    const conn = this.conn(s.connectionId)!;
    if (conn.readOnly && !req.confirmedDestructive && req.batches.some((b) => /^\s*(insert|update|delete|merge|create|drop|alter|truncate)\b/i.test(stripComments(b.sql)))) {
      return { error: `Connection “${conn.name}” is read-only; the statement modifies data`, code: 'READ_ONLY' };
    }
    const executionId = nextId('x');
    s.state = 'executing';
    s.cancel = false;
    s.lastResults = { executionId, sets: [] };
    // Like the engine: the session remembers the tab of its last run (re-attach after a reload).
    if (req.source?.tabId) {
      s.tabId = req.source.tabId;
      s.label = req.source.title ?? null;
    }
    // Events start after the HTTP response (like the real engine, they may also race it).
    setTimeout(() => void this.run(s, executionId, req), 0);
    return { executionId };
  }

  cancel(sid: string): boolean {
    const s = this.sessions.get(sid);
    if (!s || s.state !== 'executing') return false;
    s.cancel = true;
    return true;
  }

  private async run(s: MockSession, xid: string, req: ExecuteRequest) {
    const started = performance.now();
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    this.emit({ type: 'exec.started', executionId: xid, sessionId: s.sessionId, batchCount: req.batches.length } as WsEvent);
    let rsId = 0;
    let status: 'ok' | 'error' | 'cancelled' = 'ok';
    let affected = 0;
    let resultRows = 0;
    let errorText: string | null = null;
    for (let bi = 0; bi < req.batches.length; bi++) {
      const b = req.batches[bi];
      const bStart = performance.now();
      this.emit({ type: 'exec.batch.started', executionId: xid, batchIndex: bi } as WsEvent);
      // PostgreSQL binds ($1, @name, :name) are inlined so the tiny interpreter can filter on them.
      const r = this.interpret(s, s.dialect === 'pgsql' ? inlinePgParams(b.sql, req.params ?? []) : b.sql);
      for (const m of r.messages) {
        this.emit({ type: 'exec.message', executionId: xid, batchIndex: bi, severity: m.severity, text: m.text, line: b.line + (m.lineOffset ?? 0), code: null, source: m.source } as WsEvent);
      }
      let batchStatus: 'ok' | 'error' | 'cancelled' = 'ok';
      if (r.error) {
        batchStatus = 'error';
        errorText = r.error;
        this.emit({ type: 'exec.error', executionId: xid, batchIndex: bi, code: r.errorCode ?? '1', message: r.error, line: b.line, col: null, detail: null } as WsEvent);
      }
      for (const set of r.sets) {
        const id = rsId++;
        this.emit({ type: 'exec.resultset', executionId: xid, resultSetId: id, batchIndex: bi, columns: set.columns } as WsEvent);
        const cap = req.maxRows > 0 ? req.maxRows : Infinity;
        const total = Math.min(set.rows.length, cap);
        const stored: CellValue[][] = [];
        const rsStart = performance.now();
        for (let i = 0; i < total; i += this.opts.frameRows) {
          if (s.cancel) break;
          const chunk = set.rows.slice(i, Math.min(total, i + this.opts.frameRows));
          stored.push(...chunk);
          this.emit({ type: 'exec.rows', executionId: xid, resultSetId: id, rows: chunk } as WsEvent);
          if (this.opts.frameDelay) await pause(this.opts.frameDelay);
          else if (i % (this.opts.frameRows * 20) === 0) await pause(0);
        }
        s.lastResults?.sets.push({ columns: set.columns, rows: stored });
        resultRows += stored.length;
        this.emit({
          type: 'exec.resultset.end', executionId: xid, resultSetId: id, rowCount: stored.length, truncated: set.rows.length > cap && !s.cancel,
          elapsedMs: Math.round(performance.now() - rsStart + (r.delay ?? 0)),
        } as WsEvent);
        if (s.cancel) break;
      }
      if (r.delay && !s.cancel) {
        const until = performance.now() + r.delay;
        while (performance.now() < until && !s.cancel) await pause(50);
      }
      if (r.affected !== null && !r.error) {
        affected += r.affected;
        this.emit({ type: 'exec.affected', executionId: xid, batchIndex: bi, count: r.affected, statementKind: r.kind } as WsEvent);
        if (s.txMode === 'manual' && r.kind !== 'DDL') s.txOpen = true;
      }
      if (r.catalogChanged) {
        const st = this.schemasFor(s.connectionId).get(this.defaultSchema(s.connectionId));
        if (st) st.version++;
        this.emit({ type: 'catalog.changed', connectionId: s.connectionId, database: s.database, schemas: [this.defaultSchema(s.connectionId)], version: st?.version ?? 1 } as WsEvent);
      }
      if (s.cancel) batchStatus = 'cancelled';
      this.emit({ type: 'exec.batch.ended', executionId: xid, batchIndex: bi, elapsedMs: Math.round(performance.now() - bStart), status: batchStatus } as WsEvent);
      if (batchStatus === 'cancelled') {
        status = 'cancelled';
        this.emit({ type: 'exec.message', executionId: xid, batchIndex: bi, severity: 'warning', text: 'Query was cancelled by user.', line: null, code: null, source: 'engine' } as WsEvent);
        break;
      }
      if (batchStatus === 'error') {
        status = 'error';
        if (req.stopOnError) break;
      }
    }
    s.state = 'idle';
    const elapsed = Math.round(performance.now() - started);
    // Out / in-out binds (Oracle OUT parameters): numbers come back as 42, text as 'mock', in-out as their input.
    const outParams = status === 'ok'
      ? (req.params ?? []).filter((p) => (p.direction === 'out' || p.direction === 'inout') && p.kind !== 'refcursor')
        .map((p) => ({ name: p.name.replace(/^[@:$]/, ''), value: p.direction === 'inout' ? p.value : p.kind === 'int' || p.kind === 'decimal' || p.kind === 'float' ? 42 : 'mock' }))
      : [];
    this.emit({
      type: 'exec.done', executionId: xid, sessionId: s.sessionId, status, elapsedMs: elapsed, resultSets: rsId, rowsAffected: affected, txOpen: s.txOpen,
      ...(outParams.length ? { outParams } : {}),
    } as WsEvent);
    this.changed(s);
    this.history.unshift({
      id: ++this.historySeq, connectionId: s.connectionId, database: s.database, sql: req.batches.map((b) => b.sql).join(';\n'), startedAt: ts(),
      durationMs: elapsed, status, rowsAffected: affected || null, resultRows: rsId ? resultRows : null, error: errorText, label: req.label, pinned: false,
    });
  }

  /** A deliberately tiny SQL "interpreter": enough to make the mock UI feel real. */
  interpret(s: MockSession, sqlRaw: string): {
    sets: { columns: ColumnInfo[]; rows: CellValue[][] }[]; messages: { severity: 'info' | 'warning' | 'error'; text: string; source: 'server' | 'dbmsOutput' | 'engine'; lineOffset?: number }[];
    affected: number | null; kind: string | null; error: string | null; errorCode?: string; catalogChanged?: boolean; delay?: number;
  } {
    const sql = stripComments(sqlRaw).trim();
    const out = { sets: [] as { columns: ColumnInfo[]; rows: CellValue[][] }[], messages: [] as { severity: 'info' | 'warning' | 'error'; text: string; source: 'server' | 'dbmsOutput' | 'engine'; lineOffset?: number }[], affected: null as number | null, kind: null as string | null, error: null as string | null, errorCode: undefined as string | undefined, catalogChanged: false, delay: 0 };
    const upper = sql.toUpperCase();
    // PRINT / DBMS_OUTPUT
    sqlRaw.split('\n').forEach((line, i) => {
      const p = /^\s*print\s+N?'((?:[^']|'')*)'/i.exec(line);
      if (p) out.messages.push({ severity: 'info', text: p[1].replace(/''/g, "'"), source: 'server', lineOffset: i });
      const d = /dbms_output\.put_line\s*\(\s*'((?:[^']|'')*)'\s*\)/i.exec(line);
      if (d) out.messages.push({ severity: 'info', text: d[1].replace(/''/g, "'"), source: 'dbmsOutput', lineOffset: i });
      const r = /^\s*raiserror\s*\(\s*N?'((?:[^']|'')*)'\s*,\s*(\d+)/i.exec(line);
      if (r) out.messages.push({ severity: Number(r[2]) >= 11 ? 'error' : 'warning', text: r[1], source: 'server', lineOffset: i });
    });
    const wait = /waitfor\s+delay\s+'(\d+):(\d+):(\d+)'|sleep\s*\(\s*(\d+)\s*\)/i.exec(sql);
    if (wait) out.delay = wait[4] ? Number(wait[4]) * 1000 : (Number(wait[1]) * 3600 + Number(wait[2]) * 60 + Number(wait[3])) * 1000;
    if (!sql || /^(print|raiserror|begin\s+dbms_output|waitfor)/i.test(sql)) return out;

    const pg = s.dialect === 'pgsql';
    if (pg) {
      // PostgreSQL-only statements: SHOW, DO blocks, LISTEN/NOTIFY, RAISE NOTICE inside DO, pg_sleep.
      const show = /^SHOW\s+(\w+)/i.exec(sql);
      if (show) {
        const v: Record<string, string> = { search_path: '"$user", public', server_version: '17.2', timezone: 'UTC', transaction_isolation: 'read committed', application_name: 'Rowlit' };
        out.sets.push({ columns: [col(show[1].toLowerCase(), 'text', 'string', 0)], rows: [[v[show[1].toLowerCase()] ?? 'on']] });
        return out;
      }
      if (/^(DO|LISTEN|NOTIFY|UNLISTEN|DISCARD|RESET|REFRESH|ANALYZE|VACUUM)\b/.test(upper)) {
        const notice = /RAISE\s+NOTICE\s+'((?:[^']|'')*)'/i.exec(sql);
        if (notice) out.messages.push({ severity: 'info', text: notice[1].replace(/''/g, "'"), source: 'server' });
        return out;
      }
      const sleep = /pg_sleep\s*\(\s*(\d+(?:\.\d+)?)\s*\)/i.exec(sql);
      if (sleep) out.delay = Number(sleep[1]) * 1000;
      if (/^SELECT\s+version\s*\(\s*\)\s*;?$/i.test(sql)) {
        out.sets.push({ columns: [col('version', 'text', 'string', 0)], rows: [[s.serverInfo.version]] });
        return out;
      }
    }
    const pgError = (code: string, message: string) => {
      out.error = message;
      out.errorCode = code;
      return out;
    };

    if (/^(SELECT|WITH|VALUES|PRAGMA|TABLE)\b/.test(upper)) {
      if (/^PRAGMA/.test(upper)) {
        out.sets.push({ columns: [col('result', 'TEXT', 'string', 0)], rows: [['ok']] });
        return out;
      }
      const from = /\bFROM\s+((?:[\w$#]+|"[^"]+"|\[[^\]]+\])(?:\.(?:[\w$#]+|"[^"]+"|\[[^\]]+\]))?)/i.exec(sql);
      if (!from || /\bFROM\s+dual\b/i.test(sql)) {
        const list = splitTop(sql.replace(/^SELECT\s+/i, '').replace(/\bFROM\s+dual\b.*$/is, '').replace(/;$/, ''));
        const columns: ColumnInfo[] = [];
        const row: CellValue[] = [];
        list.forEach((expr, i) => {
          const m = /^(.*?)(?:\s+AS\s+("?)([\w ]+)\2)?$/is.exec(expr.trim())!;
          const e = m[1].trim();
          let v: CellValue = e;
          let kind: ColumnInfo['kind'] = 'string';
          if (/^-?\d+$/.test(e)) { v = Number(e); kind = 'int'; }
          else if (/^-?\d*\.\d+$/.test(e)) { v = e; kind = 'decimal'; }
          else if (/^N?'.*'$/s.test(e)) v = e.replace(/^N?'|'$/g, '').replace(/''/g, "'");
          else if (/^null$/i.test(e)) v = null;
          else if (/sqlite_version\(\)|@@version|banner/i.test(e)) v = s.serverInfo.version;
          else if (/current_timestamp|getdate\(\)|sysdate|now\(\)/i.test(e)) { v = new Date().toISOString().slice(0, 23); kind = 'datetime'; }
          else if (/^\d+\s*[-+*/]\s*\d+$/.test(e)) { v = arith(e); kind = 'int'; }
          columns.push(col(m[3] ?? (e.length > 30 ? `column${i + 1}` : e), kind === 'int' ? 'INTEGER' : 'TEXT', kind, i));
          row.push(v);
        });
        out.sets.push({ columns, rows: [row] });
        return out;
      }
      const parts = from[1].split('.');
      const name = parts[parts.length - 1];
      const schema = parts.length > 1 ? parts[0].replace(/^["[]|["\]]$/g, '') : null;
      const found = this.findTable(s.connectionId, schema, name);
      if (!found) {
        if (pg) return pgError('42P01', `relation "${from[1].replace(/"/g, '')}" does not exist`);
        out.error = s.dialect === 'tsql' ? `Invalid object name '${from[1]}'.` : s.dialect === 'plsql' ? 'ORA-00942: table or view does not exist' : `no such table: ${from[1]}`;
        out.errorCode = s.dialect === 'tsql' ? '208' : s.dialect === 'plsql' ? '942' : '1';
        return out;
      }
      const t = found.table;
      const isUpper = s.dialect === 'plsql';
      let columns = columnInfos(t, found.schema.name).map((c) => (isUpper ? { ...c, name: c.name.toUpperCase() } : c));
      let rows = tableRows(t);
      // WHERE col <op> literal (single condition)
      // `WHERE 1 = 0` (column probes) returns no rows; otherwise the left side must be a column name.
      if (/\bWHERE\s+1\s*=\s*0\b/i.test(sql)) rows = [];
      const where = /\bWHERE\s+(?:\w+\.)?([A-Za-z_]\w*)\s*(=|<>|!=|>=|<=|>|<|I?LIKE)\s*('(?:[^']|'')*'|-?[\d.]+)/i.exec(sql);
      if (where) {
        const ci = columns.findIndex((c) => c.name.toLowerCase() === where[1].toLowerCase());
        if (ci >= 0) {
          const lit = where[3].startsWith("'") ? where[3].slice(1, -1).replace(/''/g, "'") : where[3];
          const op = where[2].toUpperCase();
          const re = op === 'LIKE' || op === 'ILIKE' ? new RegExp(`^${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i') : null;
          rows = rows.filter((r) => {
            const v = r[ci];
            if (v === null || typeof v === 'object') return false;
            const a = typeof v === 'number' || (typeof v === 'string' && /^-?[\d.]+$/.test(v) && /^-?[\d.]+$/.test(lit)) ? Number(v) : String(v);
            const b = typeof a === 'number' ? Number(lit) : lit;
            switch (op) {
              case '=': return a == b; // eslint-disable-line eqeqeq
              case '<>': case '!=': return a != b; // eslint-disable-line eqeqeq
              case '>': return a > b;
              case '<': return a < b;
              case '>=': return a >= b;
              case '<=': return a <= b;
              default: return re!.test(String(v));
            }
          });
        } else {
          if (pg) return pgError('42703', `column "${where[1].toLowerCase()}" does not exist`);
          out.error = s.dialect === 'tsql' ? `Invalid column name '${where[1]}'.` : `no such column: ${where[1]}`;
          return out;
        }
      }
      // COUNT(*)
      if (/^SELECT\s+COUNT\s*\(\s*\*\s*\)/i.test(sql)) {
        out.sets.push({ columns: [col(isUpper ? 'COUNT(*)' : 'count', 'INTEGER', 'int', 0)], rows: [[rows.length]] });
        return out;
      }
      // ORDER BY col [DESC]
      const order = /\bORDER\s+BY\s+(?:\w+\.)?(\w+)(\s+DESC)?/i.exec(sql);
      if (order) {
        const ci = columns.findIndex((c) => c.name.toLowerCase() === order[1].toLowerCase());
        if (ci >= 0) {
          const dir = order[2] ? -1 : 1;
          rows = [...rows].sort((x, y) => {
            const a = x[ci], b = y[ci];
            if (a === b) return 0;
            if (a === null) return 1;
            if (b === null) return -1;
            const na = Number(a), nb = Number(b);
            return (!Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : String(a) < String(b) ? -1 : 1) * dir;
          });
        }
      }
      // Projection
      const proj = /^SELECT\s+(?:TOP\s+\(?\d+\)?\s+)?(?:DISTINCT\s+)?(.*?)\s+FROM\s/is.exec(sql);
      if (proj && !/^\s*(\w+\.)?\*\s*$/.test(proj[1])) {
        const items = splitTop(proj[1]).map((x) => {
          const m = /^(?:\w+\.)?("?)(\w+)\1(?:\s+(?:AS\s+)?(\w+))?$/i.exec(x.trim());
          return m ? { src: m[2], alias: m[3] ?? m[2] } : null;
        });
        if (items.every(Boolean)) {
          const idx = items.map((it) => columns.findIndex((c) => c.name.toLowerCase() === it!.src.toLowerCase()));
          const bad = idx.findIndex((i) => i < 0);
          if (bad >= 0) {
            if (pg) return pgError('42703', `column "${items[bad]!.src.toLowerCase()}" does not exist`);
            out.error = s.dialect === 'tsql' ? `Invalid column name '${items[bad]!.src}'.` : s.dialect === 'plsql' ? `ORA-00904: "${items[bad]!.src.toUpperCase()}": invalid identifier` : `no such column: ${items[bad]!.src}`;
            return out;
          }
          const src = rows;
          columns = idx.map((i, k) => ({ ...columns[i], name: items[k]!.alias, ordinal: k }));
          rows = src.map((r) => idx.map((i) => r[i]));
        }
      }
      // Row limits
      const lim = /\bLIMIT\s+(\d+)/i.exec(sql) ?? /\bTOP\s+\(?(\d+)\)?/i.exec(sql) ?? /\bFETCH\s+FIRST\s+(\d+)/i.exec(sql);
      // PostgreSQL pages with LIMIT n OFFSET m (the data tab's paging).
      const off = pg ? /\bOFFSET\s+(\d+)/i.exec(sql) : null;
      if (off) rows = rows.slice(Number(off[1]));
      if (lim) rows = rows.slice(0, Number(lim[1]));
      out.sets.push({ columns, rows });
      return out;
    }
    const kw = /^(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|BEGIN|COMMIT|ROLLBACK|EXEC|EXECUTE|CALL|SET|USE|DECLARE)\b/.exec(upper)?.[1];
    if (!kw) {
      const word = sql.split(/\s+/)[0];
      if (pg) return pgError('42601', `syntax error at or near "${word}"`);
      out.error = s.dialect === 'tsql' ? `Incorrect syntax near '${word}'.` : s.dialect === 'plsql' ? 'ORA-00900: invalid SQL statement' : `near "${word}": syntax error`;
      out.errorCode = s.dialect === 'tsql' ? '102' : '1';
      return out;
    }
    if (kw === 'COMMIT' || kw === 'ROLLBACK') {
      s.txOpen = false;
      return out;
    }
    if (kw === 'EXEC' || kw === 'EXECUTE' || kw === 'CALL' || kw === 'BEGIN' || kw === 'SET' || kw === 'USE' || kw === 'DECLARE') {
      if (/getcustomer/i.test(sql)) {
        const t = SHOP_TABLES.find((x) => x.name === 'customers')!;
        out.sets.push({ columns: columnInfos(t, 'dbo'), rows: tableRows(t).slice(0, 1) });
        out.sets.push({ columns: columnInfos(SHOP_TABLES.find((x) => x.name === 'orders')!, 'dbo'), rows: tableRows(SHOP_TABLES.find((x) => x.name === 'orders')!).slice(0, 7) });
      }
      // Execute routine (SQL Server): `DECLARE @return_value int…; EXEC …; SELECT @return_value AS [Return value], @x AS [x];`
      const outs = kw === 'DECLARE' ? /;\s*SELECT\s+((?:@\w+\s+AS\s+\[[^\]]+\]\s*,?\s*)+);?\s*$/i.exec(sql) : null;
      if (outs) {
        const names = [...outs[1].matchAll(/AS\s+\[([^\]]+)\]/gi)].map((m) => m[1]);
        out.sets.push({ columns: names.map((n, i) => col(n, i === 0 ? 'int' : 'sql_variant', i === 0 ? 'int' : 'string', i)), rows: [names.map((_, i) => (i === 0 ? 0 : null))] });
      }
      return out;
    }
    if (kw === 'CREATE' || kw === 'DROP' || kw === 'ALTER' || kw === 'TRUNCATE') {
      out.kind = 'DDL';
      out.affected = kw === 'TRUNCATE' ? 0 : null;
      out.catalogChanged = kw !== 'TRUNCATE';
      const ct = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"[\]]+)\s*\((.*)\)/is.exec(sql);
      const schemaState = this.schemasFor(s.connectionId).get(this.defaultSchema(s.connectionId));
      if (ct && schemaState) {
        const name = ct[1].replace(/["[\]]/g, '');
        const cols = splitTop(ct[2]).filter((c) => !/^\s*(PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|CHECK)\b/i.test(c)).map((c) => c.trim().split(/\s+/));
        const table: FixtureTable = {
          name, kind: 'table', rowCount: 0, gen: () => [], ddl: sql,
          columns: cols.map((p) => ({ name: p[0].replace(/["[\]]/g, ''), type: (p[1] ?? 'TEXT').toUpperCase(), kind: /INT/i.test(p[1] ?? '') ? 'int' : 'string', nullable: !/NOT\s+NULL/i.test(p.join(' ')), pk: /PRIMARY/i.test(p.join(' ')) })),
        };
        schemaState.tables.set(name.toLowerCase(), table);
        schemaState.objects = [...schemaState.objects.filter((o) => o.n.toLowerCase() !== name.toLowerCase()), catalogObject(table, schemaState.name)];
      }
      const dt = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w"[\]]+)/i.exec(sql);
      if (dt && schemaState) {
        const name = dt[1].replace(/["[\]]/g, '').toLowerCase();
        schemaState.tables.delete(name);
        schemaState.objects = schemaState.objects.filter((o) => o.n.toLowerCase() !== name);
      }
      return out;
    }
    // DML
    const target = /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DELETE|MERGE\s+INTO)\s+([\w.$#"[\]]+)/i.exec(sql);
    if (target && !this.findTable(s.connectionId, null, target[1].split('.').pop()!)) {
      if (pg) return pgError('42P01', `relation "${target[1].replace(/"/g, '')}" does not exist`);
      out.error = s.dialect === 'tsql' ? `Invalid object name '${target[1]}'.` : `no such table: ${target[1]}`;
      return out;
    }
    out.kind = kw;
    if (kw === 'INSERT') out.affected = Math.max(1, (sql.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1);
    // INSERT … RETURNING (grid inserts on PostgreSQL): one row with the next key values.
    const returning = pg && kw === 'INSERT' && target ? /\bRETURNING\s+(.+?)\s*;?\s*$/is.exec(sql) : null;
    if (returning && target) {
      const t = this.findTable(s.connectionId, null, target[1].split('.').pop()!)!.table;
      const names = splitTop(returning[1]).map((x) => x.trim().replace(/^"|"$/g, ''));
      const cols = names.map((nm, i) => {
        const c = t.columns.find((x) => x.name.toLowerCase() === nm.toLowerCase());
        return col(nm, c?.type ?? 'bigint', c?.kind ?? 'int', i);
      });
      const next = tableRows(t).length + 1 + (this.historySeq % 1000);
      out.sets.push({ columns: cols, rows: [cols.map((c) => (c.kind === 'int' ? next : null))] });
    }
    else out.affected = /\bWHERE\b/i.test(sql) ? 1 + (sql.length % 7) : target ? Math.min(tableRows(this.findTable(s.connectionId, null, target[1].split('.').pop()!)!.table).length, 5000) : 0;
    return out;
  }

  rowsPage(xid: string, rs: number, offset: number, limit: number) {
    for (const s of this.sessions.values()) {
      if (s.lastResults?.executionId === xid) {
        const set = s.lastResults.sets[rs];
        if (!set) return null;
        return { columns: set.columns, rows: set.rows.slice(offset, offset + limit), total: set.rows.length, truncated: false };
      }
    }
    return null;
  }

  cell(xid: string, rs: number, row: number, colIdx: number) {
    const page = this.rowsPage(xid, rs, row, 1);
    if (!page || !page.rows[0]) return null;
    const v = page.rows[0][colIdx];
    if (v && typeof v === 'object' && '$trunc' in v) {
      const full = `Customer asked for a detailed delivery log.\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(700)}`;
      return { kind: 'string' as const, value: full, len: full.length };
    }
    if (v && typeof v === 'object' && '$bin' in v) {
      const bytes = new Uint8Array(v.len);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return { kind: 'binary' as const, value: btoa(bin), len: v.len };
    }
    return { kind: 'string' as const, value: v === null ? '' : String(v), len: String(v ?? '').length };
  }

  resultSet(xid: string, rs: number) {
    for (const s of this.sessions.values()) if (s.lastResults?.executionId === xid) return s.lastResults.sets[rs] ?? null;
    return null;
  }
}

function col(name: string, dbType: string, kind: ColumnInfo['kind'], ordinal: number): ColumnInfo {
  return { name, ordinal, dbType, kind, nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false };
}

export function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split by commas at paren depth 0 (ignores commas in quotes). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Stored DDL of the PostgreSQL shop objects (pg_get_functiondef / pg_get_viewdef / generated, as the engine returns it). */
function pgObjectDdl(ref: ObjectRef): DdlResponse | null {
  const s = ref.schema ?? 'public';
  const t = pgShop().find((x) => x.name === ref.name);
  if (t && (ref.type === 'table' || ref.type === 'view')) return { ddl: t.kind === 'view' ? `CREATE OR REPLACE VIEW ${s}.${t.name} AS\n${t.ddl.replace(/^CREATE VIEW [^\n]+\n/, '')}` : t.ddl, source: t.kind === 'view' ? 'stored' : 'generated' };
  const fns: Record<string, string> = {
    fn_tax: `CREATE OR REPLACE FUNCTION ${s}.fn_tax(amount numeric, rate numeric)\n RETURNS numeric\n LANGUAGE sql\n IMMUTABLE\nAS $function$\n  SELECT round(amount * rate, 2)\n$function$\n`,
    orders_of: `CREATE OR REPLACE FUNCTION ${s}.orders_of(p_customer_id bigint)\n RETURNS TABLE(id bigint, order_date timestamp without time zone, total numeric)\n LANGUAGE sql\n STABLE\nAS $function$\n  SELECT o.id, o.order_date, o.total FROM public.orders o WHERE o.customer_id = p_customer_id ORDER BY o.order_date DESC\n$function$\n`,
    add_order_line: `CREATE OR REPLACE PROCEDURE ${s}.add_order_line(IN p_order_id bigint, IN p_product_id integer, IN p_qty integer DEFAULT 1, INOUT p_line_no integer DEFAULT NULL::integer)\n LANGUAGE plpgsql\nAS $procedure$\nBEGIN\n    SELECT coalesce(max(line_no), 0) + 1 INTO p_line_no FROM public.order_lines WHERE order_id = p_order_id;\n    INSERT INTO public.order_lines (order_id, line_no, product_id, qty, unit_price)\n    SELECT p_order_id, p_line_no, p.id, p_qty, p.price FROM public.products p WHERE p.id = p_product_id;\n    RAISE NOTICE 'added line % to order %', p_line_no, p_order_id;\nEND\n$procedure$\n`,
    get_customer_report: `CREATE OR REPLACE PROCEDURE ${s}.get_customer_report(IN p_customer_id bigint, INOUT p_report refcursor DEFAULT 'report'::refcursor)\n LANGUAGE plpgsql\nAS $procedure$\nBEGIN\n    OPEN p_report FOR SELECT * FROM public.orders WHERE customer_id = p_customer_id;\nEND\n$procedure$\n`,
  };
  if ((ref.type === 'func' || ref.type === 'proc' || ref.type === 'tablefunc') && fns[ref.name]) return { ddl: fns[ref.name], source: 'stored' };
  if (ref.type === 'mview' && ref.name === 'customer_totals') {
    return { ddl: `CREATE MATERIALIZED VIEW ${s}.customer_totals AS\n SELECT c.id AS customer_id,\n    c.name,\n    count(o.id) AS orders,\n    sum(o.total) AS revenue\n   FROM customers c\n     LEFT JOIN orders o ON o.customer_id = c.id\n  GROUP BY c.id, c.name;\nCREATE UNIQUE INDEX customer_totals_customer_id_idx ON ${s}.customer_totals USING btree (customer_id);`, source: 'stored' };
  }
  if (ref.type === 'type' && ref.name === 'order_status') return { ddl: `CREATE TYPE ${s}.order_status AS ENUM ('new', 'paid', 'shipped', 'delivered', 'cancelled');`, source: 'generated' };
  if (ref.type === 'type' && ref.name === 'email_address') return { ddl: `CREATE DOMAIN ${s}.email_address AS text\n    CONSTRAINT email_address_check CHECK (VALUE ~* '^[^@\\s]+@[^@\\s]+$');`, source: 'generated' };
  if (ref.type === 'sequence') return { ddl: `CREATE SEQUENCE ${s}.${ref.name}\n    AS bigint\n    START WITH 1000\n    INCREMENT BY 1\n    MINVALUE 1\n    MAXVALUE 9223372036854775807\n    NO CYCLE\n    CACHE 1;`, source: 'generated' };
  if (ref.type === 'trigger' && ref.name === 'trg_orders_check') {
    return {
      ddl: `CREATE OR REPLACE FUNCTION ${s}.trg_orders_check_fn()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n    IF NEW.total < 0 THEN\n        RAISE EXCEPTION 'order total must not be negative';\n    END IF;\n    RETURN NEW;\nEND\n$function$\n;\nCREATE TRIGGER trg_orders_check BEFORE INSERT OR UPDATE ON ${s}.orders FOR EACH ROW EXECUTE FUNCTION ${s}.trg_orders_check_fn();`,
      source: 'stored',
    };
  }
  return null;
}

/** PostgreSQL binds of a statement (`$1`, `@name`, `:name`, never `::cast`) replaced by SQL literals. */
export function inlinePgParams(sql: string, params: readonly { name: string; value: unknown }[]): string {
  if (!params.length) return sql;
  const byName = new Map(params.map((p) => [p.name.replace(/^[@:$]/, '').toLowerCase(), p.value]));
  const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/'/g, "''")}'`);
  return sql.replace(/'(?:[^']|'')*'|(?<![:\w$])[$@:]([A-Za-z_]\w*|\d+)/g, (m, name: string | undefined) => {
    if (!name) return m;
    const key = name.toLowerCase();
    return byName.has(key) ? lit(byName.get(key)) : m;
  });
}

function arith(e: string): number {
  const m = /^(\d+)\s*([-+*/])\s*(\d+)$/.exec(e)!;
  const a = Number(m[1]);
  const b = Number(m[3]);
  return m[2] === '+' ? a + b : m[2] === '-' ? a - b : m[2] === '*' ? a * b : a / b;
}

// M2 mock framework (docs/PLAN-M2.md 1.3, 2.3, 2.4): streams, source clients and jobs for `npm run dev:mock` and the
// MSW-based tests, plus the helpers the feature mock modules (./redis.ts, ./mongo.ts, ./kafka.ts, ./logs.ts, ./er.ts)
// use to emit stream items and job progress over the FakeSocket.
//
// A feature mock registers its stream kinds and its REST routes:
//
//   export function createRedisHandlers(ctx: M2MockContext) {
//     ctx.streams.register('redis.monitor', ({ push, signal }) => {
//       const t = setInterval(() => push([{ ts: new Date().toISOString(), db: 0, client: '127.0.0.1:5000', args: ['PING'] }]), 500);
//       signal.addEventListener('abort', () => clearInterval(t));
//     });
//     return [http.post(`${M2_PREFIX}/redis/:cid/keys/scan`, ...)];
//   }
import { http, HttpResponse, type JsonBodyType, type RequestHandler } from 'msw';
import type {
  ServerInfo, SourceClientInfo, StreamInfo, StreamKind, StreamOpenRequest, StreamState, WsEvent,
} from '../../api/types';
import type { MockEngine } from '../engine';

/** Route prefix used by every mock handler (any origin). */
export const M2_PREFIX = '*/api/v1';

const iso = () => new Date().toISOString();
let seq = 0;
const nextId = (p: string) => `${p}_mock${(++seq).toString(36).padStart(4, '0')}`;

function err(status: number, code: string, message: string, detail?: unknown) {
  return HttpResponse.json({ error: { code, message, detail } }, { status });
}

/** Context handed to a stream emitter for one open stream. */
export interface MockStreamContext {
  streamId: string;
  kind: StreamKind;
  connectionId: string;
  params: Record<string, unknown>;
  /** Sends one `stream.data` batch (dropped while paused, counted in `dropped`). */
  push(items: unknown[]): void;
  /** Ends the stream (`stream.state{ended}`); further pushes are ignored. */
  end(reason?: string): void;
  /** Aborted when the stream ends for any reason (DELETE, disconnect, end()). */
  signal: AbortSignal;
}

export type MockStreamEmitter = (ctx: MockStreamContext) => void;

interface OpenStream {
  info: StreamInfo;
  ctl: AbortController;
  seq: number;
}

/** In-memory stand-in for the engine StreamManager (limits: 8 open streams, like the per-client engine limit). */
export class MockStreams {
  static readonly MAX_STREAMS = 8;
  private emitters = new Map<string, MockStreamEmitter>();
  private open = new Map<string, OpenStream>();
  private engine: MockEngine;

  constructor(engine: MockEngine) {
    this.engine = engine;
  }

  /** Feature mocks register the kinds they serve. */
  register(kind: StreamKind, emitter: MockStreamEmitter): void {
    this.emitters.set(kind, emitter);
  }

  list(): StreamInfo[] {
    return [...this.open.values()].map((s) => s.info);
  }

  get(id: string): StreamInfo | undefined {
    return this.open.get(id)?.info;
  }

  start(req: StreamOpenRequest): { streamId: string } | { status: number; code: string; message: string } {
    const emitter = this.emitters.get(req.kind);
    if (!emitter) return { status: 400, code: 'VALIDATION', message: `Unknown stream kind '${req.kind}'.` };
    if (!req.connectionId) return { status: 400, code: 'VALIDATION', message: 'connectionId is required.' };
    if (this.open.size >= MockStreams.MAX_STREAMS) {
      return { status: 429, code: 'STREAM_LIMIT', message: `This window already has ${this.open.size} open streams (limit ${MockStreams.MAX_STREAMS}).` };
    }
    const streamId = nextId('st');
    const s: OpenStream = {
      info: { streamId, kind: req.kind, connectionId: req.connectionId, state: 'open', owner: 'mock', openedAt: iso(), delivered: 0, dropped: 0 },
      ctl: new AbortController(),
      seq: 0,
    };
    this.open.set(streamId, s);
    const ctx: MockStreamContext = {
      streamId, kind: req.kind, connectionId: req.connectionId, params: req.params ?? {}, signal: s.ctl.signal,
      push: (items) => {
        if (!this.open.has(streamId) || items.length === 0) return;
        if (s.info.state === 'paused') {
          s.info = { ...s.info, dropped: s.info.dropped + items.length };
          return;
        }
        s.info = { ...s.info, delivered: s.info.delivered + items.length };
        this.emit({ type: 'stream.data', streamId, items, seq: ++s.seq });
      },
      end: (reason) => this.stop(streamId, 'ended', reason ?? 'completed'),
    };
    // Start after the 202 reached the UI (the engine also starts asynchronously).
    setTimeout(() => {
      if (this.open.has(streamId)) emitter(ctx);
    }, 0);
    return { streamId };
  }

  setPaused(id: string, paused: boolean): StreamInfo | undefined {
    const s = this.open.get(id);
    if (!s) return undefined;
    const state: StreamState = paused ? 'paused' : 'open';
    if (s.info.state !== state) {
      s.info = { ...s.info, state };
      this.emit({ type: 'stream.state', streamId: id, state, reason: null, dropped: s.info.dropped });
    }
    return s.info;
  }

  stop(id: string, state: 'ended' | 'error' = 'ended', reason = 'closed'): boolean {
    const s = this.open.get(id);
    if (!s) return false;
    this.open.delete(id);
    s.ctl.abort();
    this.emit({ type: 'stream.state', streamId: id, state, reason, dropped: s.info.dropped });
    return true;
  }

  stopForConnection(connectionId: string, reason: string): void {
    for (const s of [...this.open.values()]) if (s.info.connectionId === connectionId) this.stop(s.info.streamId, 'ended', reason);
  }

  private emit(ev: Record<string, unknown> & { type: WsEvent['type'] }): void {
    this.engine.emit(ev as unknown as Parameters<MockEngine['emit']>[0]);
  }
}

/** In-memory source clients (one per non-relational connection). */
export class MockSourceClients {
  private clients = new Map<string, SourceClientInfo>();
  private engine: MockEngine;
  private streams: MockStreams;

  constructor(engine: MockEngine, streams: MockStreams) {
    this.engine = engine;
    this.streams = streams;
  }

  list(): SourceClientInfo[] {
    return [...this.clients.values()];
  }

  /** Opens lazily; hosts matching /fail|nowhere/ answer 503 SOURCE_UNAVAILABLE. */
  get(connectionId: string): SourceClientInfo | { status: number; code: string; message: string } {
    const conn = this.engine.conn(connectionId);
    if (!conn) return { status: 404, code: 'NOT_FOUND', message: `Connection '${connectionId}' was not found.` };
    const existing = this.clients.get(connectionId);
    if (existing) {
      const touched = { ...existing, lastUsed: iso() };
      this.clients.set(connectionId, touched);
      return touched;
    }
    const target = String(conn.props.host ?? conn.props.uri ?? conn.props.bootstrapServers ?? conn.props.url ?? '');
    if (/fail|nowhere/i.test(target)) return { status: 503, code: 'SOURCE_UNAVAILABLE', message: `Cannot connect to ${target}: connection refused` };
    const info: SourceClientInfo = { connectionId, state: 'open', server: mockServerInfo(conn.providerId, target), openedAt: iso(), lastUsed: iso() };
    this.clients.set(connectionId, info);
    this.engine.emit({ type: 'source.client', connectionId, state: 'open' } as Parameters<MockEngine['emit']>[0]);
    return info;
  }

  close(connectionId: string): void {
    if (!this.clients.delete(connectionId)) return;
    this.streams.stopForConnection(connectionId, 'source-closed');
    this.engine.emit({ type: 'source.client', connectionId, state: 'closed' } as Parameters<MockEngine['emit']>[0]);
  }
}

function mockServerInfo(providerId: string, target: string): ServerInfo {
  if (providerId === 'redis') return { version: 'Redis 7.4.1', productVersion: '7.4.1', serverName: target, user: 'default', database: '0' };
  if (providerId === 'mongodb') return { version: 'MongoDB 7.0.14 (replica set rs0)', productVersion: '7.0.14', serverName: target, user: null, database: null };
  if (providerId === 'kafka') return { version: 'Kafka 3.8 (3 brokers, controller 1)', productVersion: '3.8.0', serverName: target, user: null, database: null };
  if (providerId === 'elasticsearch') return { version: 'Elasticsearch 8.15.3 (cluster rowlit-dev, green, 3 nodes)', productVersion: '8.15.3', serverName: 'rowlit-dev', user: null, database: null };
  return { version: `Mock ${providerId}`, productVersion: null, serverName: target, user: null, database: null };
}

/** Long operations: `202 { jobId }`, then `job.progress` and `job.done` over the FakeSocket. */
export class MockJobs {
  private running = new Map<string, AbortController>();
  private engine: MockEngine;

  constructor(engine: MockEngine) {
    this.engine = engine;
  }

  /**
   * Starts a job: `run` reports progress and returns the result (rejects → status error). Returns the job id for the
   * 202 response.
   */
  start(kind: string, run: (report: (done: number, total?: number | null, message?: string | null) => void, signal: AbortSignal) => Promise<unknown>): string {
    const jobId = nextId('j');
    const ctl = new AbortController();
    this.running.set(jobId, ctl);
    const emit = (ev: Record<string, unknown>) => this.engine.emit(ev as Parameters<MockEngine['emit']>[0]);
    setTimeout(() => {
      run((done, total = null, message = null) => emit({ type: 'job.progress', jobId, kind, done, total, message }), ctl.signal)
        .then(
          (result) => emit({ type: 'job.done', jobId, kind, status: ctl.signal.aborted ? 'cancelled' : 'ok', error: null, result: ctl.signal.aborted ? null : result ?? null }),
          (e: unknown) => emit({ type: 'job.done', jobId, kind, status: ctl.signal.aborted ? 'cancelled' : 'error', error: e instanceof Error ? e.message : String(e), result: null }),
        )
        .finally(() => this.running.delete(jobId));
    }, 0);
    return jobId;
  }

  cancel(jobId: string): boolean {
    const ctl = this.running.get(jobId);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }
}

/** Shared state of the M2 mocks, handed to every feature factory. */
export interface M2MockContext {
  engine: MockEngine;
  streams: MockStreams;
  clients: MockSourceClients;
  jobs: MockJobs;
  ok: (body: JsonBodyType, init?: ResponseInit) => Promise<Response>;
}

export function createM2Context(engine: MockEngine, ok: M2MockContext['ok']): M2MockContext {
  const streams = new MockStreams(engine);
  return { engine, streams, clients: new MockSourceClients(engine, streams), jobs: new MockJobs(engine), ok };
}

/** Framework routes: /streams, /sources, /jobs (docs/PLAN-M2.md 1.1). */
export function createM2FrameworkHandlers(ctx: M2MockContext): RequestHandler[] {
  const P = M2_PREFIX;
  const { streams, clients, jobs, ok } = ctx;
  return [
    http.post(`${P}/streams`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Partial<StreamOpenRequest>;
      const r = streams.start({ kind: body.kind as StreamKind, connectionId: body.connectionId ?? '', params: body.params ?? {} });
      return 'streamId' in r ? ok(r, { status: 202 }) : err(r.status, r.code, r.message);
    }),
    http.get(`${P}/streams`, () => ok(streams.list())),
    http.post(`${P}/streams/:id/pause`, ({ params }) => {
      const info = streams.setPaused(String(params.id), true);
      return info ? ok(info) : err(404, 'NOT_FOUND', `Stream '${String(params.id)}' was not found.`);
    }),
    http.post(`${P}/streams/:id/resume`, ({ params }) => {
      const info = streams.setPaused(String(params.id), false);
      return info ? ok(info) : err(404, 'NOT_FOUND', `Stream '${String(params.id)}' was not found.`);
    }),
    http.delete(`${P}/streams/:id`, ({ params }) =>
      streams.stop(String(params.id)) ? new HttpResponse(null, { status: 204 }) : err(404, 'NOT_FOUND', `Stream '${String(params.id)}' was not found.`)),

    http.get(`${P}/sources/clients`, () => ok(clients.list())),
    http.get(`${P}/sources/:cid/client`, ({ params }) => {
      const r = clients.get(String(params.cid));
      return 'connectionId' in r ? ok(r) : err(r.status, r.code, r.message);
    }),
    http.delete(`${P}/sources/:cid/client`, ({ params }) => {
      clients.close(String(params.cid));
      return new HttpResponse(null, { status: 204 });
    }),

    http.delete(`${P}/jobs/:id`, ({ params }) =>
      jobs.cancel(String(params.id)) ? new HttpResponse(null, { status: 204 }) : err(404, 'NOT_FOUND', `Job '${String(params.id)}' was not found.`)),
  ];
}

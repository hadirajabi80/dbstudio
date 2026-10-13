// Single multiplexed WebSocket to the engine (D-6). Auth via the first frame, never the URL.
import type { WsClientFrame, WsEvent, WsEventOf, WsEventType } from './types';

/** Minimal WebSocket surface so tests and the mock engine can supply a fake socket. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'closed';

type Handler<E = WsEvent> = (ev: E) => void;

const OPEN = 1;
/** Paths tried in order until one authenticates (section 3.6 lists `/ws`; the REST prefix is `/api/v1`). */
const WS_PATHS = ['/api/v1/ws', '/ws'];
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];
const PING_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

export class EngineSocket {
  private factory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;
  private socket: SocketLike | null = null;
  private info: { baseUrl: string; token: string } | null = null;
  private byType = new Map<string, Set<Handler>>();
  private byExec = new Map<string, Set<Handler>>();
  private statusHandlers = new Set<(s: WsStatus) => void>();
  private _status: WsStatus = 'idle';
  private attempt = 0;
  private pathIndex = 0;
  private authed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  get status(): WsStatus {
    return this._status;
  }

  setSocketFactory(f: SocketFactory): void {
    this.factory = f;
  }

  connect(info: { baseUrl: string; token: string }): void {
    this.info = { baseUrl: info.baseUrl.replace(/\/+$/, ''), token: info.token };
    this.stopped = false;
    this.attempt = 0;
    this.teardown();
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.teardown();
    this.setStatus('closed');
  }

  /** Subscribe to an event type. Returns an unsubscribe function. */
  on<T extends WsEventType>(type: T, fn: Handler<WsEventOf<T>>): () => void {
    return this.add(this.byType, type, fn as Handler);
  }

  /** Every event. */
  onAny(fn: Handler): () => void {
    return this.add(this.byType, '*', fn);
  }

  /** Events carrying this executionId. */
  onExecution(executionId: string, fn: Handler): () => void {
    return this.add(this.byExec, executionId, fn);
  }

  onStatus(fn: (s: WsStatus) => void): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }

  /** Feed an event as if it came from the socket (used by tests). */
  dispatch(ev: WsEvent): void {
    const typed = this.byType.get(ev.type);
    if (typed) for (const h of [...typed]) safe(h, ev);
    const any = this.byType.get('*');
    if (any) for (const h of [...any]) safe(h, ev);
    const xid = (ev as { executionId?: string }).executionId;
    if (xid) {
      const hs = this.byExec.get(xid);
      if (hs) for (const h of [...hs]) safe(h, ev);
    }
  }

  private add(map: Map<string, Set<Handler>>, key: string, fn: Handler): () => void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(fn);
    return () => {
      const s = map.get(key);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) map.delete(key);
    };
  }

  private setStatus(s: WsStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const h of [...this.statusHandlers]) safe(h, s);
  }

  private open(): void {
    if (!this.info || this.stopped) return;
    const base = this.info.baseUrl.replace(/^http/i, 'ws');
    const url = `${base}${WS_PATHS[this.pathIndex % WS_PATHS.length]}`;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    this.authed = false;
    let sock: SocketLike;
    try {
      sock = this.factory(url);
    } catch {
      this.scheduleReconnect(false);
      return;
    }
    this.socket = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      this.sendFrame({ type: 'auth', token: this.info!.token });
    };
    sock.onmessage = (m) => this.onMessage(m.data);
    sock.onerror = () => {
      /* onclose follows */
    };
    sock.onclose = (ev) => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (ev.code === 4401) {
        this.setStatus('unauthorized');
        this.scheduleReconnect(true);
        return;
      }
      // Never opened: maybe the wrong path; rotate to the next candidate.
      if (!opened && !this.authed) this.pathIndex++;
      this.scheduleReconnect(this.authed);
    };
  }

  private onMessage(data: unknown): void {
    let ev: WsEvent;
    try {
      ev = JSON.parse(typeof data === 'string' ? data : String(data)) as WsEvent;
    } catch {
      return;
    }
    if (ev.type === 'auth.ok') {
      this.authed = true;
      this.attempt = 0;
      this.setStatus('open');
      this.startPing();
    } else if (ev.type === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.dispatch(ev);
  }

  private sendFrame(f: WsClientFrame): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(f));
  }

  private startPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      this.sendFrame({ type: 'ping' });
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        // Half-open connection: force a reconnect.
        this.pongTimer = null;
        this.socket?.close(4000, 'pong timeout');
      }, PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  private scheduleReconnect(wasOpen: boolean): void {
    if (this.stopped) return;
    if (wasOpen) this.attempt = 0;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    const delay = base + Math.floor(Math.random() * base * 0.25);
    this.attempt++;
    if (this._status !== 'unauthorized') this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private teardown(): void {
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      try {
        s.close(1000, 'reconnect');
      } catch {
        /* ignore */
      }
    }
  }
}

function safe<A>(fn: (a: A) => void, a: A): void {
  try {
    fn(a);
  } catch (e) {
    console.error('[ws] handler failed', e);
  }
}

export const engineSocket = new EngineSocket();

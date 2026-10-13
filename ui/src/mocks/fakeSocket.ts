import type { WsClientFrame } from '../api/types';
import type { SocketLike } from '../api/ws';
import type { MockEngine } from './engine';

/** WebSocket stand-in wired to the MockEngine's event bus. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private unsub: (() => void) | null = null;
  private engine: MockEngine;
  private token: string;

  constructor(engine: MockEngine, token = 'mock-token') {
    this.engine = engine;
    this.token = token;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    const f = JSON.parse(data) as WsClientFrame;
    if (f.type === 'auth') {
      if (!f.token || (this.token && f.token !== this.token)) {
        this.close(4401, 'unauthorized');
        return;
      }
      this.unsub = this.engine.subscribe((ev) => this.deliver(ev));
      this.deliver({ type: 'auth.ok', ts: new Date().toISOString() });
    } else if (f.type === 'ping') {
      this.deliver({ type: 'pong', ts: new Date().toISOString() });
    }
  }

  private deliver(ev: unknown) {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(ev) });
  }

  close(code = 1000, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsub?.();
    this.unsub = null;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
}

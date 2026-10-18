// M2-0 (docs/PLAN-M2.md 1.2): stream and job subscriptions filter `stream.*` / `job.*` events by id.
import { describe, expect, it } from 'vitest';
import type { StreamEvent, WsEvent } from './types';
import { EngineSocket } from './ws';

const ts = '2026-10-18T00:00:00.000Z';

describe('EngineSocket streams and jobs', () => {
  it('delivers stream events only to the subscribers of that stream', () => {
    const s = new EngineSocket();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const offA = s.onStream('st_a', (e) => a.push(e));
    s.onStream('st_b', (e) => b.push(e));
    s.dispatch({ type: 'stream.data', ts, streamId: 'st_a', items: [{ n: 1 }], seq: 1 });
    s.dispatch({ type: 'stream.state', ts, streamId: 'st_b', state: 'open', reason: null, dropped: 12 });
    s.dispatch({ type: 'stream.data', ts, streamId: 'st_c', items: [], seq: 1 });
    expect(a.map((e) => e.type)).toEqual(['stream.data']);
    expect(b).toEqual([{ type: 'stream.state', ts, streamId: 'st_b', state: 'open', reason: null, dropped: 12 }]);

    offA();
    s.dispatch({ type: 'stream.data', ts, streamId: 'st_a', items: [{ n: 2 }], seq: 2 });
    expect(a).toHaveLength(1);

    // Engine restart: every remaining subscriber hears ended.
    expect(s.endAllStreams()).toBe(1);
    expect(b.at(-1)).toMatchObject({ type: 'stream.state', streamId: 'st_b', state: 'ended', reason: 'engine-restarted' });
  });

  it('delivers job events by job id and keeps type subscriptions working', () => {
    const s = new EngineSocket();
    const seen: string[] = [];
    const typed: WsEvent[] = [];
    s.onJob('j_1', (e) => seen.push(`${e.type}:${e.jobId}`));
    s.on('job.done', (e) => typed.push(e));
    s.dispatch({ type: 'job.progress', ts, jobId: 'j_1', kind: 'redis.deletePattern', done: 5, total: 10, message: null });
    s.dispatch({ type: 'job.done', ts, jobId: 'j_2', kind: 'x', status: 'ok', error: null, result: null });
    s.dispatch({ type: 'job.done', ts, jobId: 'j_1', kind: 'redis.deletePattern', status: 'ok', error: null, result: { deleted: 10 } });
    expect(seen).toEqual(['job.progress:j_1', 'job.done:j_1']);
    expect(typed).toHaveLength(2);
  });
});

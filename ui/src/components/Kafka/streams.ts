// Fetch jobs and live tails of the message browser (docs/PLAN-M2.md 7.4). Both subscribe to the WebSocket BEFORE the
// REST call and buffer events of unknown ids, so items the engine sends before the 202 is processed are not lost; once
// the ids are known the buffer is replayed and the rest is routed directly.
import { api, errorMessage } from '../../api/client';
import type { KafkaFetchRequest, KafkaFetchResult, KafkaMessage, KafkaTailParams, WsEvent } from '../../api/types';
import { engineSocket } from '../../api/ws';

type Ev = WsEvent & { streamId?: string; jobId?: string };

/** Subscribes to stream/job events now; `bind` names the ids to keep once the REST call answered. */
function collector(onEvent: (ev: Ev) => void) {
  let ids: { streamId: string | null; jobId: string | null } | null = null;
  const buffer: Ev[] = [];
  const handle = (ev: Ev) => {
    if (!ids) {
      if (buffer.length < 5000) buffer.push(ev);
      return;
    }
    if ((ev.streamId && ev.streamId === ids.streamId) || (ev.jobId && ev.jobId === ids.jobId)) onEvent(ev);
  };
  const subs = [
    engineSocket.on('stream.data', (e) => handle(e as Ev)),
    engineSocket.on('stream.state', (e) => handle(e as Ev)),
    engineSocket.on('job.progress', (e) => handle(e as Ev)),
    engineSocket.on('job.done', (e) => handle(e as Ev)),
  ];
  return {
    bind(streamId: string | null, jobId: string | null) {
      ids = { streamId, jobId };
      const pending = buffer.splice(0);
      for (const ev of pending) handle(ev);
    },
    stop() {
      subs.forEach((u) => u());
    },
  };
}

export interface FetchHandlers {
  onMessages(items: KafkaMessage[]): void;
  onProgress?(done: number, total: number | null, message: string | null): void;
  /** Called once: result on success, error text otherwise (cancelled → error 'cancelled'). */
  onDone(result: KafkaFetchResult | null, error: string | null): void;
}

export interface FetchHandle {
  cancel(): void;
}

/** Starts a browse job; messages arrive on its `kafka.fetch` stream, the job's result ends it. */
export function startFetch(cid: string, topic: string, req: KafkaFetchRequest, h: FetchHandlers): FetchHandle {
  let jobId: string | null = null;
  let streamId: string | null = null;
  let jobDone: { result: KafkaFetchResult | null; error: string | null } | null = null;
  let streamEnded = false;
  let finished = false;
  const finish = (result: KafkaFetchResult | null, error: string | null) => {
    if (finished) return;
    finished = true;
    c.stop();
    h.onDone(result, error);
  };
  const maybeFinish = () => {
    if (jobDone && (streamEnded || jobDone.error)) finish(jobDone.result, jobDone.error);
  };
  const c = collector((ev) => {
    if (ev.type === 'stream.data') h.onMessages(ev.items as KafkaMessage[]);
    else if (ev.type === 'stream.state') {
      if (ev.state === 'ended' || ev.state === 'error') {
        streamEnded = true;
        if (ev.state === 'error' && !jobDone) jobDone = { result: null, error: ev.reason ?? 'stream error' };
        maybeFinish();
      }
    } else if (ev.type === 'job.progress') h.onProgress?.(ev.done, ev.total, ev.message);
    else if (ev.type === 'job.done') {
      jobDone = ev.status === 'ok'
        ? { result: (ev.result as KafkaFetchResult | null) ?? null, error: null }
        : { result: null, error: ev.status === 'cancelled' ? 'cancelled' : ev.error ?? 'failed' };
      maybeFinish();
      // the stream normally ends right after; do not wait for ever if its end event was missed
      setTimeout(() => finish(jobDone?.result ?? null, jobDone?.error ?? null), 3000);
    }
  });
  api.kafka.fetchMessages(cid, topic, req).then(
    (r) => {
      jobId = r.jobId;
      streamId = r.streamId;
      if (finished) {
        void api.cancelJob(r.jobId).catch(() => undefined);
        return;
      }
      c.bind(r.streamId, r.jobId);
    },
    (e) => finish(null, errorMessage(e)),
  );
  return {
    cancel() {
      if (finished) return;
      if (jobId) void api.cancelJob(jobId).catch(() => undefined);
      if (streamId) void api.closeStream(streamId).catch(() => undefined);
      finish(null, 'cancelled');
    },
  };
}

export interface TailHandlers {
  onMessages(items: KafkaMessage[]): void;
  onState(state: 'open' | 'paused' | 'ended' | 'error', reason: string | null, dropped: number): void;
}

export interface TailHandle {
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): void;
  readonly streamId: string | null;
}

/** Opens a `kafka.tail` stream. Rejects with the engine error (VALIDATION, STREAM_LIMIT, SOURCE_UNAVAILABLE…). */
export async function startTail(cid: string, params: KafkaTailParams, h: TailHandlers): Promise<TailHandle> {
  const c = collector((ev) => {
    if (ev.type === 'stream.data') h.onMessages(ev.items as KafkaMessage[]);
    else if (ev.type === 'stream.state') {
      h.onState(ev.state, ev.reason, ev.dropped);
      if (ev.state === 'ended' || ev.state === 'error') c.stop();
    }
  });
  let streamId: string;
  try {
    streamId = (await api.openStream({ kind: 'kafka.tail', connectionId: cid, params: { ...params } })).streamId;
  } catch (e) {
    c.stop();
    throw e;
  }
  // engine restart: the socket synthesises stream.state{ended} through onStream subscribers
  const unsub = engineSocket.onStream(streamId, (ev) => {
    if (ev.type === 'stream.state' && ev.reason === 'engine-restarted') h.onState('ended', ev.reason, ev.dropped);
  });
  c.bind(streamId, null);
  let closed = false;
  return {
    streamId,
    pause: async () => {
      await api.pauseStream(streamId);
    },
    resume: async () => {
      await api.resumeStream(streamId);
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsub();
      c.stop();
      void api.closeStream(streamId).catch(() => undefined);
    },
  };
}

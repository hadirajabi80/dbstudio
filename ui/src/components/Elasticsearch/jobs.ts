// Engine jobs of the Elasticsearch dialogs (reindex, import, export): `202 { jobId }`, then `job.progress` / `job.done`
// over the WebSocket. A fast job can finish before the 202 arrives, so recent `job.done` events are remembered.
import { useEffect, useRef, useState } from 'react';
import type { JobDoneEvent, JobProgressEvent } from '../../api/types';
import { engineSocket } from '../../api/ws';
import { esErrorText } from './parts';

export interface JobState<R> {
  status: 'idle' | 'running' | 'ok' | 'error' | 'cancelled';
  done: number;
  total: number | null;
  message: string | null;
  result: R | null;
  error: string | null;
  jobId: string | null;
}

const IDLE: JobState<never> = { status: 'idle', done: 0, total: null, message: null, result: null, error: null, jobId: null };

const recentDone = new Map<string, JobDoneEvent>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  engineSocket.on('job.done', (ev) => {
    recentDone.set(ev.jobId, ev);
    if (recentDone.size > 50) recentDone.delete(recentDone.keys().next().value as string);
  });
}

export function waitForJob<R>(jobId: string, onProgress?: (ev: JobProgressEvent) => void, signal?: AbortSignal): Promise<R> {
  listen();
  return new Promise<R>((resolve, reject) => {
    const finish = (done: JobDoneEvent) => {
      if (done.status === 'ok') resolve(done.result as R);
      else reject(new Error(done.status === 'cancelled' ? 'Cancelled' : done.error ?? 'The job failed.'));
    };
    const early = recentDone.get(jobId);
    if (early) return finish(early);
    const off = engineSocket.onJob(jobId, (ev) => {
      if (ev.type === 'job.progress') return onProgress?.(ev);
      off();
      finish(ev as JobDoneEvent);
    });
    signal?.addEventListener('abort', () => {
      off();
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export function useJob<R>() {
  const [state, setState] = useState<JobState<R>>(IDLE);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => {
    listen();
    return () => ctl.current?.abort();
  }, []);
  const run = async (start: () => Promise<{ jobId: string }>): Promise<R | null> => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ ...IDLE, status: 'running' });
    try {
      const { jobId } = await start();
      setState((s) => ({ ...s, jobId }));
      const result = await waitForJob<R>(jobId, (ev) => setState((s) => ({ ...s, done: ev.done, total: ev.total ?? s.total, message: ev.message ?? s.message })), c.signal);
      if (c.signal.aborted) return null;
      setState((s) => ({ ...s, status: 'ok', result }));
      return result;
    } catch (e) {
      if (c.signal.aborted) return null;
      const msg = esErrorText(e);
      setState((s) => ({ ...s, status: msg === 'Cancelled' ? 'cancelled' : 'error', error: msg }));
      return null;
    }
  };
  return { state, run, reset: () => setState(IDLE) };
}

// Small helpers shared by the Mongo views.
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import type { JobDoneEvent, JobProgressEvent } from '../../api/types';
import { engineSocket } from '../../api/ws';
import { getConnection } from '../../store/connections';

export function errorText(e: unknown): string {
  if (isApiError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** `READ_ONLY` and friends: a short reason for a disabled write control, or null when writes are allowed. */
export function readOnlyReason(cid: string): string | null {
  const c = getConnection(cid);
  return c?.readOnly ? `“${c.name}” is read-only` : null;
}

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

// A job can finish before the 202 reached us (fast jobs): remember recent `job.done` events.
const recentDone = new Map<string, JobDoneEvent>();
engineSocket.on('job.done', (ev) => {
  recentDone.set(ev.jobId, ev);
  if (recentDone.size > 50) recentDone.delete(recentDone.keys().next().value as string);
});

/** Waits for a job's `job.done` (resolves with the result) while reporting progress. */
export function waitForJob<R>(jobId: string, onProgress?: (ev: JobProgressEvent) => void, signal?: AbortSignal): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const finish = (done: JobDoneEvent) => {
      if (done.status === 'ok') resolve(done.result as R);
      else reject(new Error(done.status === 'cancelled' ? 'Cancelled' : done.error ?? 'The job failed.'));
    };
    const early = recentDone.get(jobId);
    if (early) {
      finish(early);
      return;
    }
    const off = engineSocket.onJob(jobId, (ev) => {
      if (ev.type === 'job.progress') {
        onProgress?.(ev);
        return;
      }
      off();
      finish(ev as JobDoneEvent);
    });
    signal?.addEventListener('abort', () => {
      off();
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

/** Runs `start()` (which answers `{ jobId }`) and tracks the job. */
export function useJob<R>() {
  const [state, setState] = useState<JobState<R>>(IDLE);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
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
      const msg = errorText(e);
      setState((s) => ({ ...s, status: msg === 'Cancelled' ? 'cancelled' : 'error', error: msg }));
      return null;
    }
  };
  const reset = () => setState(IDLE);
  return { state, run, reset };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "Use as validation" from the schema view: a validator draft waiting for the Validation tab of a collection. */
export const pendingValidator = new Map<string, string>();

export function draftValidator(cid: string, db: string, coll: string, text: string): void {
  pendingValidator.set(`${cid}:${db}.${coll}`, text);
  window.dispatchEvent(new CustomEvent('dbstudio:mongo-validator', { detail: { key: `${cid}:${db}.${coll}` } }));
}

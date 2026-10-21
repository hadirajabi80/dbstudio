// Runs auto layouts in layout.worker.ts (one shared worker, requests answered in order). Where no Worker exists (tests,
// a worker that failed to start) the same computeLayout runs in a lazily imported chunk on the main thread.
import type { LayoutInput, LayoutProgress, LayoutResult } from './layout';

type Pending = { resolve: (r: LayoutResult) => void; reject: (e: Error) => void; progress?: LayoutProgress };

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'er-layout' });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; progress?: string; result?: LayoutResult; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.progress !== undefined) {
      p.progress?.(e.data.progress);
      return;
    }
    pending.delete(e.data.id);
    if (e.data.result) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error ?? 'Layout failed'));
  };
  worker.onerror = (e) => {
    // a worker that cannot load (CSP, file:// quirks) falls back to the main thread for this and later layouts
    workerBroken = true;
    worker?.terminate();
    worker = null;
    const all = [...pending.entries()];
    pending.clear();
    e.preventDefault?.();
    for (const [, p] of all) p.reject(new Error('worker-failed'));
  };
  return worker;
}

async function inThread(input: LayoutInput, progress?: LayoutProgress): Promise<LayoutResult> {
  const { computeLayout } = await import('./layout');
  return computeLayout(input, progress);
}

/** Lays out the diagram; never blocks the UI thread when Workers are available. */
export async function runLayout(input: LayoutInput, progress?: LayoutProgress): Promise<LayoutResult> {
  const w = getWorker();
  if (!w) return inThread(input, progress);
  const id = ++seq;
  try {
    return await new Promise<LayoutResult>((resolve, reject) => {
      pending.set(id, { resolve, reject, progress });
      w.postMessage({ id, input });
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'worker-failed') return inThread(input, progress);
    throw e;
  }
}

// Web Worker running the dagre layout off the UI thread (docs/PLAN-M2.md D6). Protocol:
//   in:  { id, input: LayoutInput }
//   out: { id, progress: string } (zero or more), then { id, result: LayoutResult } or { id, error: string }
import { computeLayout, type LayoutInput } from './layout';

interface Req { id: number; input: LayoutInput }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Req>) => void) | null; postMessage(m: unknown): void };

ctx.onmessage = (e) => {
  const { id, input } = e.data;
  try {
    const result = computeLayout(input, (progress) => ctx.postMessage({ id, progress }));
    ctx.postMessage({ id, result });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

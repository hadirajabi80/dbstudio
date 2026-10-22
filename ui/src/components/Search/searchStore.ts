// Runs of the Search tab: one `db.search` engine stream at a time per tab. Hits, progress and errors arrive as
// `stream.data` batches (api/types.search.ts); results live here, not in the workspace.
import { create } from 'zustand';
import { api, errorMessage } from '../../api/client';
import type { StreamEvent } from '../../api/types';
import { SEARCH_STREAM_KIND, type SearchErrorItem, type SearchHitItem, type SearchItem, type SearchProgressItem, type SearchRequestParams } from '../../api/types.search';
import { engineSocket } from '../../api/ws';

export type SearchStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface SearchRun {
  status: SearchStatus;
  request: SearchRequestParams | null;
  hits: SearchHitItem[];
  errors: SearchErrorItem[];
  /** Latest progress per connection. */
  progress: Record<string, SearchProgressItem>;
  truncated: boolean;
  startedAt: number;
  elapsedMs: number | null;
  /** Why the search failed (rejected request, engine error). */
  error: string | null;
  streamId: string | null;
}

const EMPTY: SearchRun = {
  status: 'idle', request: null, hits: [], errors: [], progress: {}, truncated: false, startedAt: 0, elapsedMs: null, error: null, streamId: null,
};

interface SearchRuns {
  runs: Record<string, SearchRun>;
  start(tabId: string, request: SearchRequestParams): Promise<void>;
  cancel(tabId: string): Promise<void>;
  /** The tab closed: cancel and forget. */
  dispose(tabId: string): void;
}

/** Per tab: the run's sequence number (a newer start wins) and its stream subscription. */
const live = new Map<string, { seq: number; off: (() => void) | null; streamId: string | null }>();
let seq = 0;

export function emptyRun(): SearchRun {
  return EMPTY;
}

export const useSearchRuns = create<SearchRuns>((set, get) => {
  const patch = (tabId: string, p: Partial<SearchRun> | ((r: SearchRun) => Partial<SearchRun>)) =>
    set((s) => {
      const cur = s.runs[tabId] ?? EMPTY;
      return { runs: { ...s.runs, [tabId]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } } };
    });

  const stopStream = (tabId: string) => {
    const l = live.get(tabId);
    if (!l) return null;
    l.off?.();
    live.delete(tabId);
    return l.streamId;
  };

  const onItems = (tabId: string, items: SearchItem[]) => {
    const hits: SearchHitItem[] = [];
    const errors: SearchErrorItem[] = [];
    const progress: Record<string, SearchProgressItem> = {};
    let done: Extract<SearchItem, { kind: 'done' }> | null = null;
    for (const it of items) {
      if (it.kind === 'hit') hits.push(it);
      else if (it.kind === 'error') errors.push(it);
      else if (it.kind === 'progress') progress[it.connectionId] = it;
      else if (it.kind === 'done') done = it;
    }
    patch(tabId, (r) => ({
      hits: hits.length ? [...r.hits, ...hits] : r.hits,
      errors: errors.length ? [...r.errors, ...errors] : r.errors,
      progress: Object.keys(progress).length ? { ...r.progress, ...progress } : r.progress,
      ...(done ? { status: 'done' as const, truncated: done.truncated, elapsedMs: done.elapsedMs, progress: {} } : {}),
    }));
  };

  return {
    runs: {},

    async start(tabId, request) {
      const prev = stopStream(tabId);
      if (prev) void api.closeStream(prev).catch(() => undefined);
      const mySeq = ++seq;
      live.set(tabId, { seq: mySeq, off: null, streamId: null });
      set((s) => ({ runs: { ...s.runs, [tabId]: { ...EMPTY, status: 'running', request, startedAt: Date.now() } } }));
      let streamId: string;
      try {
        ({ streamId } = await api.openStream({ kind: SEARCH_STREAM_KIND, connectionId: 'engine', params: request as unknown as Record<string, unknown> }));
      } catch (e) {
        if (live.get(tabId)?.seq !== mySeq) return;
        live.delete(tabId);
        patch(tabId, { status: 'error', error: errorMessage(e), elapsedMs: 0 });
        return;
      }
      const l = live.get(tabId);
      if (l?.seq !== mySeq) {
        // Cancelled or restarted while the stream opened.
        void api.closeStream(streamId).catch(() => undefined);
        return;
      }
      l.streamId = streamId;
      patch(tabId, { streamId });
      l.off = engineSocket.onStream(streamId, (ev: StreamEvent) => {
        if (live.get(tabId)?.seq !== mySeq) return;
        if (ev.type === 'stream.data') {
          onItems(tabId, ev.items as SearchItem[]);
          return;
        }
        if (ev.state !== 'ended' && ev.state !== 'error') return;
        stopStream(tabId);
        const r = get().runs[tabId] ?? EMPTY;
        if (r.status !== 'running') return;
        const elapsedMs = Date.now() - r.startedAt;
        if (ev.state === 'error') patch(tabId, { status: 'error', error: ev.reason ?? 'The search failed.', elapsedMs });
        else patch(tabId, { status: ev.reason === 'completed' ? 'done' : 'cancelled', elapsedMs, progress: {} });
      });
    },

    async cancel(tabId) {
      const r = get().runs[tabId];
      const streamId = stopStream(tabId);
      if (r?.status === 'running') patch(tabId, { status: 'cancelled', elapsedMs: Date.now() - r.startedAt, progress: {} });
      if (streamId) await api.closeStream(streamId).catch(() => undefined);
    },

    dispose(tabId) {
      void get().cancel(tabId);
      set((s) => {
        const runs = { ...s.runs };
        delete runs[tabId];
        return { runs };
      });
    },
  };
});

export function useSearchRun(tabId: string): SearchRun {
  return useSearchRuns((s) => s.runs[tabId] ?? EMPTY);
}

// Runs of Find in database: one `db.search` engine stream at a time per owner (the Search dialog, or a Search tab by
// its id). Hits, progress and errors arrive as `stream.data` batches (api/types.search.ts); results live here, not in
// the workspace. A run can move to another owner while it streams ("Open in tab" from the dialog).
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
  start(owner: string, request: SearchRequestParams): Promise<void>;
  cancel(owner: string): Promise<void>;
  /** The owner closed: cancel and forget. */
  dispose(owner: string): void;
  /** Move a run (finished or still streaming) to another owner; the target's own run is cancelled first. */
  transfer(from: string, to: string): void;
}

/** A run in flight: its sequence number (a newer start wins), its owner (changes on transfer) and its stream. */
interface Live {
  seq: number;
  owner: string;
  off: (() => void) | null;
  streamId: string | null;
}

/** Per owner. */
const live = new Map<string, Live>();
let seq = 0;

export function emptyRun(): SearchRun {
  return EMPTY;
}

export const useSearchRuns = create<SearchRuns>((set, get) => {
  const patch = (owner: string, p: Partial<SearchRun> | ((r: SearchRun) => Partial<SearchRun>)) =>
    set((s) => {
      const cur = s.runs[owner] ?? EMPTY;
      return { runs: { ...s.runs, [owner]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } } };
    });

  const stopStream = (owner: string) => {
    const l = live.get(owner);
    if (!l) return null;
    l.off?.();
    live.delete(owner);
    return l.streamId;
  };

  const onItems = (owner: string, items: SearchItem[]) => {
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
    patch(owner, (r) => ({
      hits: hits.length ? [...r.hits, ...hits] : r.hits,
      errors: errors.length ? [...r.errors, ...errors] : r.errors,
      progress: Object.keys(progress).length ? { ...r.progress, ...progress } : r.progress,
      ...(done ? { status: 'done' as const, truncated: done.truncated, elapsedMs: done.elapsedMs, progress: {} } : {}),
    }));
  };

  return {
    runs: {},

    async start(owner, request) {
      const prev = stopStream(owner);
      if (prev) void api.closeStream(prev).catch(() => undefined);
      const entry: Live = { seq: ++seq, owner, off: null, streamId: null };
      live.set(owner, entry);
      // Still the run in flight (not cancelled, restarted or disposed; it may have moved to another owner).
      const current = () => live.get(entry.owner) === entry;
      set((s) => ({ runs: { ...s.runs, [owner]: { ...EMPTY, status: 'running', request, startedAt: Date.now() } } }));
      let streamId: string;
      try {
        ({ streamId } = await api.openStream({ kind: SEARCH_STREAM_KIND, connectionId: 'engine', params: request as unknown as Record<string, unknown> }));
      } catch (e) {
        if (!current()) return;
        live.delete(entry.owner);
        patch(entry.owner, { status: 'error', error: errorMessage(e), elapsedMs: 0 });
        return;
      }
      if (!current()) {
        // Cancelled or restarted while the stream opened.
        void api.closeStream(streamId).catch(() => undefined);
        return;
      }
      entry.streamId = streamId;
      patch(entry.owner, { streamId });
      entry.off = engineSocket.onStream(streamId, (ev: StreamEvent) => {
        if (!current()) return;
        if (ev.type === 'stream.data') {
          onItems(entry.owner, ev.items as SearchItem[]);
          return;
        }
        if (ev.state !== 'ended' && ev.state !== 'error') return;
        stopStream(entry.owner);
        const r = get().runs[entry.owner] ?? EMPTY;
        if (r.status !== 'running') return;
        const elapsedMs = Date.now() - r.startedAt;
        if (ev.state === 'error') patch(entry.owner, { status: 'error', error: ev.reason ?? 'The search failed.', elapsedMs });
        else patch(entry.owner, { status: ev.reason === 'completed' ? 'done' : 'cancelled', elapsedMs, progress: {} });
      });
    },

    async cancel(owner) {
      const r = get().runs[owner];
      const streamId = stopStream(owner);
      if (r?.status === 'running') patch(owner, { status: 'cancelled', elapsedMs: Date.now() - r.startedAt, progress: {} });
      if (streamId) await api.closeStream(streamId).catch(() => undefined);
    },

    dispose(owner) {
      void get().cancel(owner);
      set((s) => {
        const runs = { ...s.runs };
        delete runs[owner];
        return { runs };
      });
    },

    transfer(from, to) {
      if (from === to) return;
      if (get().runs[to] || live.has(to)) get().dispose(to);
      const run = get().runs[from];
      const l = live.get(from);
      if (l) {
        live.delete(from);
        l.owner = to;
        live.set(to, l);
      }
      set((s) => {
        const runs = { ...s.runs };
        delete runs[from];
        if (run) runs[to] = run;
        return { runs };
      });
    },
  };
});

export function useSearchRun(owner: string): SearchRun {
  return useSearchRuns((s) => s.runs[owner] ?? EMPTY);
}

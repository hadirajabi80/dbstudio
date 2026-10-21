// Engine streams of the Redis views (redis.subscribe, redis.monitor): open on start, items batched from
// `stream.data`, pause/resume, drop counter from `stream.state`, closed on stop / unmount (no live handles are kept
// in tab state: a restored workspace starts stopped).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { engineSocket } from '../../api/ws';
import type { StreamKind } from '../../api/types';
import { errorText } from './store';

export type StreamStatus = 'idle' | 'starting' | 'open' | 'paused' | 'ended' | 'error';

export interface RedisStreamApi<T> {
  status: StreamStatus;
  items: T[];
  dropped: number;
  /** Why the stream ended (completed = auto-stop, closed, source-closed, engine-restarted...). */
  reason: string | null;
  error: string | null;
  start: (params: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  clear: () => void;
}

export function useRedisStream<T>(kind: StreamKind, cid: string, maxItems = 10_000): RedisStreamApi<T> {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [items, setItems] = useState<T[]>([]);
  const [dropped, setDropped] = useState(0);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const offRef = useRef<(() => void) | null>(null);
  const pendingRef = useRef<T[]>([]);
  const frame = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    const add = pendingRef.current;
    pendingRef.current = [];
    if (add.length) setItems((cur) => {
      const next = cur.concat(add);
      return next.length > maxItems ? next.slice(next.length - maxItems) : next;
    });
  }, [maxItems]);

  const detach = () => {
    offRef.current?.();
    offRef.current = null;
    idRef.current = null;
  };

  const start = useCallback(async (params: Record<string, unknown>) => {
    if (idRef.current) return;
    setStatus('starting');
    setError(null);
    setReason(null);
    setDropped(0);
    try {
      const { streamId } = await api.openStream({ kind, connectionId: cid, params });
      idRef.current = streamId;
      offRef.current = engineSocket.onStream(streamId, (ev) => {
        if (ev.type === 'stream.data') {
          pendingRef.current.push(...(ev.items as T[]));
          if (!frame.current) frame.current = setTimeout(flush, 50);
        } else {
          setDropped(ev.dropped);
          if (ev.state === 'ended' || ev.state === 'error') {
            flush();
            setStatus(ev.state);
            setReason(ev.reason);
            if (ev.state === 'error') setError(ev.reason);
            detach();
          } else setStatus(ev.state);
        }
      });
      setStatus('open');
    } catch (e) {
      setStatus('error');
      setError(errorText(e));
    }
  }, [kind, cid, flush]);

  const stop = useCallback(async () => {
    const id = idRef.current;
    detach();
    setStatus('ended');
    setReason('closed');
    if (id) await api.closeStream(id).catch(() => {});
  }, []);

  const pause = useCallback(async () => {
    if (!idRef.current) return;
    await api.pauseStream(idRef.current).catch(() => {});
    setStatus('paused');
  }, []);

  const resume = useCallback(async () => {
    if (!idRef.current) return;
    await api.resumeStream(idRef.current).catch(() => {});
    setStatus('open');
  }, []);

  useEffect(() => () => {
    const id = idRef.current;
    detach();
    if (frame.current) clearTimeout(frame.current);
    if (id) void api.closeStream(id).catch(() => {});
  }, []);

  return { status, items, dropped, reason, error, start, stop, pause, resume, clear: () => setItems([]) };
}

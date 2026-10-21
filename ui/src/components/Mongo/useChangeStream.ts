// "Watch" in the documents view (docs/PLAN-M2.md 6.5): a `mongo.changes` stream for the collection; counts the
// changes since the last refresh and keeps the latest 50 for the popover. The stream id is never persisted (it is
// re-created when the view mounts with Watch on).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { MongoChangeItem } from '../../api/types';
import { engineSocket } from '../../api/ws';
import { errorText } from './util';

export interface ChangeStreamState {
  on: boolean;
  status: 'off' | 'opening' | 'live' | 'ended' | 'error';
  pending: number;
  recent: MongoChangeItem[];
  error: string | null;
}

export function useChangeStream(cid: string, db: string, coll: string, enabled: boolean) {
  const [s, setS] = useState<ChangeStreamState>({ on: enabled, status: 'off', pending: 0, recent: [], error: null });
  const streamRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setS((p) => ({ ...p, on: false, status: 'off' }));
      return;
    }
    let live = true;
    let off: (() => void) | null = null;
    setS((p) => ({ ...p, on: true, status: 'opening', error: null }));
    api.openStream({ kind: 'mongo.changes', connectionId: cid, params: { db, coll, fullDocument: 'updateLookup' } }).then(
      ({ streamId }) => {
        if (!live) {
          void api.closeStream(streamId).catch(() => undefined);
          return;
        }
        streamRef.current = streamId;
        setS((p) => ({ ...p, status: 'live' }));
        off = engineSocket.onStream(streamId, (ev) => {
          if (ev.type === 'stream.data') {
            const items = ev.items as MongoChangeItem[];
            setS((p) => ({ ...p, pending: p.pending + items.length, recent: [...[...items].reverse(), ...p.recent].slice(0, 50) }));
          } else if (ev.state === 'ended' || ev.state === 'error') {
            streamRef.current = null;
            setS((p) => ({ ...p, status: ev.state === 'error' ? 'error' : 'ended', error: ev.reason }));
          }
        });
      },
      (e) => live && setS((p) => ({ ...p, status: 'error', error: errorText(e) })),
    );
    return () => {
      live = false;
      off?.();
      const id = streamRef.current;
      streamRef.current = null;
      if (id) void api.closeStream(id).catch(() => undefined);
    };
  }, [cid, db, coll, enabled]);

  const clear = () => setS((p) => ({ ...p, pending: 0 }));
  return { ...s, clear };
}

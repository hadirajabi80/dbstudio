// A small request hook of the Cassandra views: data / error / loading of one async call, reloadable, stale-safe.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage, isApiError } from '../../api/client';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** The error's engine code (e.g. NOT_SUPPORTED), when it was an API error. */
  errorCode: string | null;
  loading: boolean;
  reload(): void;
}

interface Result<T> {
  key: string;
  seq: number;
  data: T | null;
  error: { message: string; code: string | null } | null;
}

/**
 * Runs `fn` when `key` changes (null key: nothing to load) and on reload(). A reload keeps the last data until the
 * answer arrives; a failed reload keeps it too (with the error).
 */
export function useLoad<T>(key: string | null, fn: () => Promise<T>): Loaded<T> {
  const [res, setRes] = useState<Result<T> | null>(null);
  const [seq, setSeq] = useState(0);
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (key === null) return;
    let live = true;
    fnRef.current().then(
      (data) => {
        if (live) setRes({ key, seq, data, error: null });
      },
      (e: unknown) => {
        if (!live) return;
        const error = { message: errorMessage(e), code: isApiError(e) ? e.code : null };
        setRes((prev) => ({ key, seq, data: prev?.key === key ? prev.data : null, error }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, seq]);

  const reload = useCallback(() => setSeq((s) => s + 1), []);
  const cur = key !== null && res?.key === key ? res : null;
  return {
    data: cur?.data ?? null,
    error: cur?.error?.message ?? null,
    errorCode: cur?.error?.code ?? null,
    loading: key !== null && (!cur || cur.seq !== seq),
    reload,
  };
}

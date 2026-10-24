// Data loading with optional polling for the ClickHouse views.
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/**
 * Loads `fn` on mount and whenever `key` changes; `intervalMs` > 0 polls while `active`. A failed poll keeps the last
 * data and shows the error.
 */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, key: string, intervalMs = 0, active = true): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const ctl = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    fnRef.current(c.signal).then(
      (d) => {
        if (c.signal.aborted) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (c.signal.aborted) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
  }, []);
  useEffect(() => {
    reload();
    return () => ctl.current?.abort();
  }, [key, reload]);
  useEffect(() => {
    if (!intervalMs || !active) return;
    const t = setInterval(reload, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active, reload]);
  return { data, error, loading, reload };
}

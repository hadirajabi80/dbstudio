// The right pane of the browser: key header (type, live TTL, memory, encoding, length) with Rename, TTL, Refresh,
// Copy and Delete, and the typed value editor.
import { Braces, Copy, Lock, Pencil, RefreshCw, Timer, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { RedisKeyValue } from '../../api/types';
import { formatBytes, formatCount, formatTtl, TYPE_LABEL } from '../../redis/format';
import type { EffectiveTheme } from '../../theme/useTheme';
import { ValueEditor } from './editors';
import { errorText } from './store';
import { typeIcon, TYPE_COLOR } from './tree';

export interface KeyDetailHandle {
  save: () => Promise<boolean>;
  reload: () => void;
}

interface KeyDetailProps {
  cid: string;
  db: number;
  keyName: string;
  readOnly: boolean;
  theme: EffectiveTheme;
  now: number;
  /** The key is gone (deleted elsewhere, expired). */
  onMissing: (key: string) => void;
  /** TTL/type/size learned from the value (refreshes the list badges). */
  onLoaded: (v: RedisKeyValue) => void;
  onRename: () => void;
  onTtl: (ttl: number) => void;
  onDelete: () => void;
  onCopyKey: () => void;
  onCopyJson: (v: RedisKeyValue) => void;
  handle: (h: KeyDetailHandle | null) => void;
}

function lengthOf(v: RedisKeyValue): string {
  switch (v.type) {
    case 'string': return formatBytes(v.length ?? (typeof v.value === 'string' ? v.value.length : v.value.len));
    case 'hash': return `${formatCount(v.length)} fields`;
    case 'list': return `${formatCount(v.length)} items`;
    case 'set': case 'zset': return `${formatCount(v.length)} members`;
    case 'stream': return `${formatCount(v.length)} entries`;
    default: return '';
  }
}

export function KeyDetail(p: KeyDetailProps) {
  const [value, setValue] = useState<RedisKeyValue | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const [seq, setSeq] = useState(0);
  const latest = useRef(p);
  latest.current = p;

  const reload = useCallback(() => setSeq((s) => s + 1), []);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api.redis.getKey(p.cid, p.keyName, { db: p.db }, ctl.signal).then(
      (v) => {
        setValue(v);
        setLoadedAt(Date.now());
        setLoading(false);
        latest.current.onLoaded(v);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoading(false);
        if (e instanceof ApiError && e.status === 404) {
          setValue(null);
          setError('The key does not exist any more (deleted or expired).');
          latest.current.onMissing(p.keyName);
        } else setError(errorText(e));
      },
    );
    return () => ctl.abort();
  }, [p.cid, p.db, p.keyName, seq]);

  useEffect(() => {
    p.handle({
      save: async () => {
        if (!saveRef.current) return false;
        await saveRef.current();
        return true;
      },
      reload,
    });
    return () => p.handle(null);
    // the handle reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const registerSave = useCallback((s: (() => Promise<void>) | null) => {
    saveRef.current = s;
  }, []);
  const onEditorError = useCallback((m: string | null) => setEditorError(m), []);

  const ttl = value ? (value.ttl < 0 ? value.ttl : Math.max(0, value.ttl - Math.floor((p.now - loadedAt) / 1000))) : -1;
  return (
    <section className="redis-detail" aria-label={`Key ${p.keyName}`}>
      <header className="redis-detail-header">
        <div className="redis-detail-title">
          {value && <span className="redis-type-badge large" style={{ color: TYPE_COLOR[value.type], borderColor: TYPE_COLOR[value.type] }}>{typeIcon(value.type, 13)}{TYPE_LABEL[value.type]}</span>}
          <h2 className="mono redis-detail-key" title={p.keyName}>{p.keyName}</h2>
        </div>
        {value && (
          <div className="redis-detail-meta" aria-label="Key details">
            <span title="TTL"><Timer size={13} /> {ttl >= 0 ? <span className={ttl < 60 ? 'text-warning' : ''}>{formatTtl(ttl)}</span> : 'No limit'}</span>
            {value.memory !== null && <span title="MEMORY USAGE">{formatBytes(value.memory)}</span>}
            <span>{lengthOf(value)}</span>
            {value.objectEncoding && <span className="mono muted" title="OBJECT ENCODING">{value.objectEncoding}</span>}
            {p.readOnly && <span className="pill pill-muted" title="Read-only connection"><Lock size={11} /> read-only</span>}
          </div>
        )}
        <div className="redis-detail-actions" role="toolbar" aria-label="Key actions">
          <button className="btn btn-xs" disabled={p.readOnly || !value} onClick={p.onRename} title="Rename (F2)"><Pencil size={13} /> Rename</button>
          <button className="btn btn-xs" disabled={p.readOnly || !value} onClick={() => p.onTtl(ttl)} title="Set TTL"><Timer size={13} /> TTL</button>
          <button className="btn btn-xs" onClick={reload} title="Refresh the value"><RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh</button>
          <button className="btn btn-xs" onClick={p.onCopyKey} title="Copy the key name"><Copy size={13} /> Copy name</button>
          <button className="btn btn-xs" disabled={!value} onClick={() => value && p.onCopyJson(value)} title="Copy the value as JSON"><Braces size={13} /> Copy JSON</button>
          <button className="btn btn-xs btn-danger-outline" disabled={p.readOnly || !value} onClick={p.onDelete} title="Delete (Delete)"><Trash2 size={13} /> Delete</button>
        </div>
      </header>
      {error && <div className="message sev-error redis-detail-error" role="alert">{error}</div>}
      {editorError && <div className="message sev-error redis-detail-error" role="alert">{editorError}</div>}
      {value && (
        <ValueEditor key={`${p.keyName}:${value.type}`} cid={p.cid} db={p.db} value={value} readOnly={p.readOnly} theme={p.theme} reload={reload}
          registerSave={registerSave} onError={onEditorError} />
      )}
      {!value && loading && <div className="muted redis-empty" role="status">Loading…</div>}
    </section>
  );
}

/** JSON representation of a key value (Copy JSON). */
export function valueAsJson(v: RedisKeyValue): string {
  switch (v.type) {
    case 'string': {
      const s = typeof v.value === 'string' ? v.value : v.value.$trunc;
      if (v.isJson) {
        try {
          return JSON.stringify(JSON.parse(s), null, 2);
        } catch {
          return JSON.stringify(s);
        }
      }
      return JSON.stringify(s);
    }
    case 'hash': return JSON.stringify(Object.fromEntries(v.fields.map((f) => [f.field, f.value])), null, 2);
    case 'list': return JSON.stringify(v.items.map((i) => i.value), null, 2);
    case 'set': return JSON.stringify(v.members, null, 2);
    case 'zset': return JSON.stringify(v.members, null, 2);
    case 'stream': return JSON.stringify(v.entries, null, 2);
    case 'rejson': return JSON.stringify(v.json, null, 2);
    default: return '';
  }
}

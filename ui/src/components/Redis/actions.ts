// Redis key actions shared by the explorer context menus, the palette and the browser: each opens its dialog or
// confirmation and, on success, announces the change (`onKeysChanged`) so every open browser and the explorer cache
// stay in sync without rescanning.
import { createElement } from 'react';
import { api } from '../../api/client';
import { copyText } from '../../app/actions';
import { getConnection } from '../../store/connections';
import { toast, useUi } from '../../store/ui';
import { formatCount } from '../../redis/format';
import { showRedisDialog } from './dialogHost';
import { DeletePatternDialog, FlushDbDialog, NewKeyDialog, RenameKeyDialog, TtlDialog } from './dialogs';
import { valueAsJson } from './KeyDetail';
import { cacheOf, errorText, forgetKeys, loadServer, resetKeys } from './store';

export type KeysChange =
  | { kind: 'added'; cid: string; db: number; key: string }
  | { kind: 'removed'; cid: string; db: number; keys: string[] }
  | { kind: 'renamed'; cid: string; db: number; from: string; to: string }
  | { kind: 'ttl'; cid: string; db: number; key: string; ttl: number }
  | { kind: 'flushed'; cid: string; db: number }
  | { kind: 'pattern'; cid: string; db: number; pattern: string };

const listeners = new Set<(c: KeysChange) => void>();

export function onKeysChanged(fn: (c: KeysChange) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function announce(c: KeysChange): void {
  if (c.kind === 'removed') forgetKeys(c.cid, c.db, c.keys);
  else if (c.kind === 'renamed') forgetKeys(c.cid, c.db, [c.from]);
  else if (c.kind === 'flushed' || c.kind === 'pattern') resetKeys(c.cid, c.db);
  if (c.kind !== 'ttl') void loadServer(c.cid, true);
  for (const l of listeners) l(c);
}

export const isWritable = (cid: string) => !getConnection(cid)?.readOnly;

export function newKey(cid: string, db: number, prefix = ''): void {
  showRedisDialog((close) => createElement(NewKeyDialog, {
    cid, db, initialPrefix: prefix, onClose: close,
    onCreated: (key: string) => {
      toast('success', 'Key added', key);
      announce({ kind: 'added', cid, db, key });
    },
  }));
}

export function renameKey(cid: string, db: number, key: string): void {
  showRedisDialog((close) => createElement(RenameKeyDialog, {
    cid, db, keyName: key, onClose: close,
    onRenamed: (to: string) => {
      toast('success', 'Key renamed', `${key} → ${to}`);
      announce({ kind: 'renamed', cid, db, from: key, to });
    },
  }));
}

export async function setTtl(cid: string, db: number, key: string, ttl?: number): Promise<void> {
  let current = ttl;
  if (current === undefined) {
    try {
      current = (await api.redis.getKey(cid, key, { db, count: 1 })).ttl;
    } catch (e) {
      toast('error', 'Could not read the key', errorText(e));
      return;
    }
  }
  showRedisDialog((close) => createElement(TtlDialog, {
    cid, db, keyName: key, ttl: current ?? -1, onClose: close,
    onSaved: (t: number) => {
      toast('success', t < 0 ? 'TTL removed' : 'TTL set', key);
      announce({ kind: 'ttl', cid, db, key, ttl: t });
    },
  }));
}

export async function deleteKey(cid: string, db: number, key: string): Promise<boolean> {
  const ok = await useUi.getState().askConfirm({
    title: 'Delete key', danger: true, confirmLabel: 'Delete key', items: [key],
    message: `Delete this key from db${db}? UNLINK removes it permanently.`,
  });
  if (!ok) return false;
  try {
    await api.redis.deleteKey(cid, db, key);
    toast('success', 'Key deleted', key);
    announce({ kind: 'removed', cid, db, keys: [key] });
    return true;
  } catch (e) {
    toast('error', 'Could not delete the key', errorText(e));
    return false;
  }
}

export function deletePattern(cid: string, db: number, pattern: string): void {
  showRedisDialog((close) => createElement(DeletePatternDialog, {
    cid, db, pattern, onClose: close,
    onDone: (deleted: number) => {
      toast('success', `Deleted ${formatCount(deleted)} keys`, pattern);
      announce({ kind: 'pattern', cid, db, pattern });
    },
  }));
}

export function flushDb(cid: string, db: number): void {
  const keys = cacheOf(cid, db)?.dbSize ?? null;
  showRedisDialog((close) => createElement(FlushDbDialog, {
    cid, db, keys, onClose: close,
    onDone: () => {
      toast('success', `Flushed db${db}`);
      announce({ kind: 'flushed', cid, db });
    },
  }));
}

export function copyKeyName(key: string): Promise<void> {
  return copyText(key, 'Key name copied');
}

export async function copyValueJson(cid: string, db: number, key: string): Promise<void> {
  try {
    const v = await api.redis.getKey(cid, key, { db, count: 1000 });
    await copyText(valueAsJson(v), 'Value copied as JSON');
  } catch (e) {
    toast('error', 'Could not copy the value', errorText(e));
  }
}

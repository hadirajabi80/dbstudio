// Delimiter tree of scanned keys (docs/PLAN-M2.md 5.2, 5.3): `user:1001:profile` with ":" sits under the folders
// `user:` → `user:1001:`. The index is built once per scan page set; flattening walks only expanded folders, so a
// 100k-key browser stays responsive.
import type { RedisKeySummary } from '../api/types';

export interface KeyFolder {
  /** Full prefix including the trailing delimiter ("user:1001:"). */
  prefix: string;
  label: string;
  folders: Map<string, KeyFolder>;
  keys: RedisKeySummary[];
  /** Keys below this folder (all depths). */
  count: number;
}

export type KeyTreeRow =
  | { kind: 'folder'; id: string; prefix: string; label: string; depth: number; count: number; expanded: boolean }
  | { kind: 'key'; id: string; label: string; depth: number; entry: RedisKeySummary };

export function buildKeyIndex(entries: readonly RedisKeySummary[], delimiter: string): KeyFolder {
  const root: KeyFolder = { prefix: '', label: '', folders: new Map(), keys: [], count: 0 };
  const d = delimiter || ':';
  for (const e of entries) {
    let node = root;
    node.count++;
    let from = 0;
    for (;;) {
      const at = e.key.indexOf(d, from);
      // a trailing delimiter ("a:") or an empty segment keeps the key in the current folder
      if (at < 0 || at === e.key.length - d.length) break;
      const prefix = e.key.slice(0, at + d.length);
      let child = node.folders.get(prefix);
      if (!child) {
        child = { prefix, label: e.key.slice(from, at), folders: new Map(), keys: [], count: 0 };
        node.folders.set(prefix, child);
      }
      child.count++;
      node = child;
      from = at + d.length;
    }
    node.keys.push(e);
  }
  return root;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Visible rows: folders first (natural order), then keys; children of expanded folders only. */
export function flattenKeyTree(root: KeyFolder, expanded: ReadonlySet<string>, depth = 0, out: KeyTreeRow[] = []): KeyTreeRow[] {
  const folders = [...root.folders.values()].sort((a, b) => collator.compare(a.label, b.label));
  for (const f of folders) {
    const open = expanded.has(f.prefix);
    out.push({ kind: 'folder', id: `f:${f.prefix}`, prefix: f.prefix, label: f.label || '(empty)', depth, count: f.count, expanded: open });
    if (open) flattenKeyTree(f, expanded, depth + 1, out);
  }
  const keys = [...root.keys].sort((a, b) => collator.compare(a.key, b.key));
  for (const k of keys) out.push({ kind: 'key', id: `k:${k.key}`, label: k.key.slice(root.prefix.length) || k.key, depth, entry: k });
  return out;
}

/** The folder prefixes on the path to a key (to reveal it). */
export function ancestors(key: string, delimiter: string): string[] {
  const out: string[] = [];
  const d = delimiter || ':';
  let at = key.indexOf(d);
  while (at >= 0 && at < key.length - d.length) {
    out.push(key.slice(0, at + d.length));
    at = key.indexOf(d, at + d.length);
  }
  return out;
}

/** SCAN MATCH pattern of a folder: its prefix with glob characters escaped, then "*". */
export function folderPattern(prefix: string): string {
  return `${prefix.replace(/[*?[\]\\]/g, (c) => `\\${c}`)}*`;
}

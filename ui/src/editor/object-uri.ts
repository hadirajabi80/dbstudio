// Synthetic `dbstudio-object://connectionId/db/schema/type/name` URIs for go-to-definition on catalog objects.
// Pure: no Monaco imports.
import type { CatalogObjectType, ObjectRef } from '../api/types';

const TYPES = new Set<CatalogObjectType>(['table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'synonym', 'sequence', 'package', 'type', 'trigger']);
const enc = (s: string | null | undefined) => encodeURIComponent(s ?? '') || '-';
const dec = (s: string) => (s === '-' ? '' : decodeURIComponent(s));

export function objectUri(connectionId: string, ref: ObjectRef, column?: string, owner?: string): string {
  const q: string[] = [];
  if (column) q.push('column=' + encodeURIComponent(column));
  if (owner) q.push('owner=' + encodeURIComponent(owner));
  return `dbstudio-object://${enc(connectionId)}/${enc(ref.database)}/${enc(ref.schema)}/${ref.type}/${enc(ref.name)}${q.length ? '?' + q.join('&') : ''}`;
}

export function parseObjectUri(uri: string): { connectionId: string; ref: ObjectRef; column?: string; owner?: string } | null {
  const m = /^dbstudio-object:\/\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*)\/([^?]*)(?:\?(.*))?$/.exec(uri);
  if (!m) return null;
  const type = m[4] as CatalogObjectType;
  if (!TYPES.has(type)) return null;
  const params = new Map<string, string>();
  for (const kv of (m[6] ?? '').split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    params.set(decodeURIComponent(kv.slice(0, i)), decodeURIComponent(kv.slice(i + 1)));
  }
  const db = dec(m[2]);
  const schema = dec(m[3]);
  const out: { connectionId: string; ref: ObjectRef; column?: string; owner?: string } = {
    connectionId: dec(m[1]),
    ref: { database: db || null, schema: schema || null, name: dec(m[5]), type },
  };
  if (params.has('column')) out.column = params.get('column');
  if (params.has('owner')) out.owner = params.get('owner');
  return out;
}

export function objectSummary(ref: ObjectRef, _owner?: unknown): string {
  const name = [ref.schema, ref.name].filter(Boolean).join('.');
  return `-- ${name} (${ref.type})\n-- F12 / Ctrl+click opens the object tab`;
}

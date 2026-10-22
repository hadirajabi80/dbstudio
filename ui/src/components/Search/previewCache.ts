// Definitions (DDL) fetched by the Find in database preview while the dialog is used: arrowing back and forth through
// the results does not fetch them again.
import { api } from '../../api/client';
import type { ObjectGroup } from './model';

const MAX_CACHED = 40;
const cache = new Map<string, Promise<string>>();

export function fetchDdl(o: Pick<ObjectGroup, 'key' | 'connectionId' | 'database' | 'schema' | 'name' | 'type'>): Promise<string> {
  const hit = cache.get(o.key);
  if (hit) return hit;
  const p = api.ddl(o.connectionId, o.database, { database: o.database, schema: o.schema, name: o.name, type: o.type }).then((r) => r.ddl);
  p.catch(() => cache.delete(o.key));
  cache.set(o.key, p);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return p;
}

export function hasDdl(key: string): boolean {
  return cache.has(key);
}

/** Tests: forget the fetched definitions. */
export function clearPreviewCache(): void {
  cache.clear();
}

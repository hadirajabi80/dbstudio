// Name check of the view designer: a new view (or a renamed one) must not take the name of an existing table or view.
// The engine no longer drops an object of the new name first, so without this check Apply fails on the server; the
// designer says so up front and offers to open the existing object instead. Pure TypeScript.
import type { CatalogSnapshot, Dialect } from '../../api/types';

export interface NameConflict {
  name: string;
  type: 'table' | 'view' | 'mview';
}

/**
 * An existing table or view that a new view (or a renamed one) would collide with, from the catalog snapshot. Names are
 * compared case-insensitively (SQL Server and SQLite ignore case; Oracle folds unquoted names). Renaming a view to
 * its own name in another letter case is not a conflict.
 */
export function viewNameConflict(
  snapshot: Pick<CatalogSnapshot, 'schemas' | 'defaultSchema'> | null, dialect: Dialect, schema: string | null, name: string, originalName: string | null,
): NameConflict | null {
  const n = name.trim();
  if (!n || !snapshot) return null;
  const key = n.toLowerCase();
  if (originalName && originalName.toLowerCase() === key) return null;
  const sc = schema ?? snapshot.defaultSchema ?? (dialect === 'sqlite' ? 'main' : null);
  const objects = snapshot.schemas.find((x) => x.name === sc)?.objects ?? snapshot.schemas.find((x) => x.name.toLowerCase() === (sc ?? '').toLowerCase())?.objects ?? [];
  const hit = objects.find((o) => (o.t === 'view' || o.t === 'table' || o.t === 'mview') && o.n.toLowerCase() === key);
  return hit ? { name: hit.n, type: hit.t as NameConflict['type'] } : null;
}

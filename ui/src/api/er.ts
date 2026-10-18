// ER diagram API surface (docs/PLAN-M2.md §3, owner M2-ER). M2-0 stub: wire types live in ./types.m2.ts,
// the REST calls are `api.er.layouts / saveLayout / deleteLayout` (./client.m2.ts).
import type { DiagramScope } from './types.m2';

export type { DiagramAutoLayout, DiagramLayout, DiagramLayoutQuery, DiagramScope } from './types.m2';

/**
 * Stable key of a diagram scope, used to look up its saved layout (`GET …/er/layouts?scope=`).
 * Schema scope → `db|schema`; table-set scope → `db|t:a,b` with the table names sorted (order-insensitive).
 * A null database is encoded as the empty string, e.g. `|main` for SQLite.
 */
export function layoutScopeKey(scope: DiagramScope): string {
  const db = scope.database ?? '';
  if (scope.tables && scope.tables.length > 0) return `${db}|t:${[...scope.tables].sort().join(',')}`;
  return `${db}|${scope.schema ?? ''}`;
}

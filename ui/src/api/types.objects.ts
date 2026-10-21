// Object browser wire types (WP3): the Objects tab list and an object's dependencies.
//   GET /connections/{id}/catalog/objects?database&schema&type         → ObjectListItem[]
//   GET /connections/{id}/catalog/dependencies?database&schema&name&type → DependencyGraph
import type { CatalogObjectType, ObjectRef } from './types';

/** One row of the Objects tab. Statistics are null where the server has none (views, routines, missing grants). */
export interface ObjectListItem {
  type: CatalogObjectType;
  schema: string | null;
  name: string;
  rowCount: number | null;
  sizeBytes: number | null;
  /** Server-local time without offset semantics (shown as is). */
  modified: string | null;
  created: string | null;
  comment: string | null;
}

/**
 * `fk`: a foreign key (Uses: this table references the object; Used by: the object references this table).
 * `uses` / `usedBy`: named in a view, routine or trigger body. `trigger`: a trigger on this table, or (Uses side of a
 * trigger) the table it fires on.
 */
export type DependencyKind = 'fk' | 'uses' | 'usedBy' | 'trigger' | 'index';

export interface ObjectDependency {
  kind: DependencyKind;
  object: ObjectRef;
  /** e.g. "FK_Orders_Customers: CustomerId → Id", "AFTER INSERT, UPDATE", "referenced in body". */
  detail: string | null;
  isSchemaBound: boolean | null;
}

export interface DependencyGraph {
  root: ObjectRef;
  uses: ObjectDependency[];
  usedBy: ObjectDependency[];
}

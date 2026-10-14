// Argument shapes passed by the shell's context menus to registered commands. Commands from other packages
// should accept these (all optional) and fall back to the current selection / active tab when run without args.
import type { CatalogObjectType, ObjectRef } from '../api/types';

/** An explorer object node (table, view, procedure, ...): explorer context menu, palette "go to object". */
export interface ObjectTarget {
  kind: 'object';
  connectionId: string;
  database: string | null;
  ref: ObjectRef;
  /** Several objects selected (multi-select codegen); includes `ref`. */
  refs?: ObjectRef[];
}

/** A container node where new objects are created (database, schema, or a type folder inside a schema). */
export interface ContainerTarget {
  kind: 'container';
  connectionId: string;
  database: string | null;
  schema: string | null;
  /** Folder type when invoked on a "Tables"/"Views"/... folder. */
  objectType?: CatalogObjectType;
}

export interface ConnectionTarget {
  kind: 'connection';
  connectionId: string;
}

export interface TabTarget {
  kind: 'tab';
  tabId: string;
}

export type CommandTarget = ObjectTarget | ContainerTarget | ConnectionTarget | TabTarget;

export function isObjectTarget(a: unknown): a is ObjectTarget {
  return !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'object';
}
export function isContainerTarget(a: unknown): a is ContainerTarget {
  return !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'container';
}
export function isConnectionTarget(a: unknown): a is ConnectionTarget {
  return !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'connection';
}
export function isTabTarget(a: unknown): a is TabTarget {
  return !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'tab';
}

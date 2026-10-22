// Dependencies section model (WP3): groups of a dependency list, badges and the summary line. Pure and unit-tested.
import type { CatalogObjectType, ObjectRef } from '../../api/types';
import type { DependencyGraph, ObjectDependency } from '../../api/types.objects';

export type DepCategory = 'fk' | 'table' | 'view' | 'routine' | 'trigger' | 'other';

export const CATEGORY_LABEL: Record<DepCategory, string> = {
  fk: 'Foreign keys',
  table: 'Tables',
  view: 'Views',
  routine: 'Procedures & functions',
  trigger: 'Triggers',
  other: 'Other objects',
};

const ORDER: DepCategory[] = ['fk', 'table', 'view', 'routine', 'trigger', 'other'];

const ROUTINE_TYPES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc', 'package']);

export function categoryOf(d: ObjectDependency): DepCategory {
  if (d.kind === 'fk') return 'fk';
  const t = d.object.type;
  if (t === 'table') return 'table';
  if (t === 'view' || t === 'mview') return 'view';
  if (ROUTINE_TYPES.has(t)) return 'routine';
  if (t === 'trigger') return 'trigger';
  return 'other';
}

export interface DepGroup {
  category: DepCategory;
  label: string;
  items: ObjectDependency[];
}

/** Groups in a fixed order (FKs first), each sorted by schema and name. */
export function groupDependencies(list: readonly ObjectDependency[]): DepGroup[] {
  const by = new Map<DepCategory, ObjectDependency[]>();
  for (const d of list) {
    const c = categoryOf(d);
    by.set(c, [...(by.get(c) ?? []), d]);
  }
  const cmp = (a: ObjectDependency, b: ObjectDependency) =>
    (a.object.schema ?? '').localeCompare(b.object.schema ?? '', undefined, { sensitivity: 'base' })
    || a.object.name.localeCompare(b.object.name, undefined, { sensitivity: 'base' });
  return ORDER.filter((c) => by.has(c)).map((c) => ({ category: c, label: CATEGORY_LABEL[c], items: [...by.get(c)!].sort(cmp) }));
}

const TYPE_BADGE: Record<CatalogObjectType, string> = {
  table: 'table', view: 'view', mview: 'mat. view', proc: 'procedure', func: 'function', tablefunc: 'table function',
  synonym: 'synonym', sequence: 'sequence', package: 'package', type: 'type', trigger: 'trigger',
};

/** Kind badge of a row: FK, view, procedure, trigger, function… */
export function badgeOf(d: ObjectDependency): string {
  return d.kind === 'fk' ? 'FK' : TYPE_BADGE[d.object.type] ?? d.object.type;
}

/** The FK detail "FK_Orders_Customers: CustomerId → Id" split into constraint and column mapping. */
export function splitFkDetail(detail: string | null): { constraint: string | null; mapping: string | null; note: string | null } {
  if (!detail) return { constraint: null, mapping: null, note: null };
  const m = /^(.*?):\s(.*?)(?:\s\((disabled)\))?$/.exec(detail);
  return m ? { constraint: m[1], mapping: m[2], note: m[3] ?? null } : { constraint: null, mapping: detail, note: null };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 foreign keys · 3 views · 1 trigger" over both directions. */
export function summaryChips(g: DependencyGraph): string[] {
  const all = [...g.uses, ...g.usedBy];
  const n = (c: DepCategory) => all.filter((d) => categoryOf(d) === c).length;
  const out: string[] = [];
  if (n('fk')) out.push(plural(n('fk'), 'foreign key', 'foreign keys'));
  if (n('table')) out.push(plural(n('table'), 'table', 'tables'));
  if (n('view')) out.push(plural(n('view'), 'view', 'views'));
  if (n('routine')) out.push(plural(n('routine'), 'routine', 'routines'));
  if (n('trigger')) out.push(plural(n('trigger'), 'trigger', 'triggers'));
  if (n('other')) out.push(plural(n('other'), 'other object', 'other objects'));
  return out;
}

export function dependencyCount(g: DependencyGraph | null | undefined): number | undefined {
  return g ? g.uses.length + g.usedBy.length : undefined;
}

// ---------------------------------------------------------------------------------------------- per-tab cache

/** Last graph per object tab (re-opening the section is instant; Reload fetches again). */
const cache = new Map<string, { key: string; graph: DependencyGraph }>();

export function dependencyKey(connectionId: string, database: string | null, ref: Pick<ObjectRef, 'schema' | 'name' | 'type'>): string {
  return `${connectionId}|${database ?? ''}|${ref.schema ?? ''}|${ref.name}|${ref.type}`;
}

export function cachedDependencies(cacheId: string, key: string): DependencyGraph | null {
  const c = cache.get(cacheId);
  return c && c.key === key ? c.graph : null;
}

export function rememberDependencies(cacheId: string, key: string, graph: DependencyGraph): void {
  cache.set(cacheId, { key, graph });
}

export function forgetDependencies(cacheId: string): void {
  cache.delete(cacheId);
}
// Objects tab (WP3) model: type groups with counts, live filter, sort, and the fallback list from the loaded catalog.
// Pure and unit-tested.
import type { CatalogObjectType, CatalogSchema } from '../../api/types';
import type { ObjectListItem } from '../../api/types.objects';

export const OBJECTS_VIEW = 'objects';

export type GroupId = 'table' | 'view' | 'proc' | 'func' | 'package' | 'trigger' | 'sequence' | 'synonym' | 'type';
/** The saved queries of the scope (components/SavedQueries): a group of its own, not catalog objects. */
export const QUERIES_GROUP = 'queries';
export type GroupFilter = GroupId | 'all' | typeof QUERIES_GROUP;

export const GROUPS: readonly { id: GroupId; label: string; singular: string; types: readonly CatalogObjectType[] }[] = [
  { id: 'table', label: 'Tables', singular: 'table', types: ['table'] },
  { id: 'view', label: 'Views', singular: 'view', types: ['view', 'mview'] },
  { id: 'proc', label: 'Procedures', singular: 'procedure', types: ['proc'] },
  { id: 'func', label: 'Functions', singular: 'function', types: ['func', 'tablefunc'] },
  { id: 'package', label: 'Packages', singular: 'package', types: ['package'] },
  { id: 'trigger', label: 'Triggers', singular: 'trigger', types: ['trigger'] },
  { id: 'sequence', label: 'Sequences', singular: 'sequence', types: ['sequence'] },
  { id: 'synonym', label: 'Synonyms', singular: 'synonym', types: ['synonym'] },
  { id: 'type', label: 'Types', singular: 'type', types: ['type'] },
];

const GROUP_OF = new Map<CatalogObjectType, GroupId>(GROUPS.flatMap((g) => g.types.map((t) => [t, g.id] as const)));

export function groupOf(t: CatalogObjectType): GroupId {
  return GROUP_OF.get(t) ?? 'type';
}

/** The group an explorer type folder opens on ("Tables" → table, "Table Functions" → func). */
export function groupForType(t: CatalogObjectType | null | undefined): GroupFilter {
  return t ? groupOf(t) : 'all';
}

export type GroupCounts = Record<GroupFilter, number>;

export function countByGroup(items: readonly ObjectListItem[]): GroupCounts {
  const counts = { all: items.length } as GroupCounts;
  for (const g of GROUPS) counts[g.id] = 0;
  for (const it of items) counts[groupOf(it.type)]++;
  return counts;
}

export type SortKey = 'name' | 'schema' | 'type' | 'rows' | 'size' | 'modified' | 'comment';
export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortSpec = { key: 'name', dir: 'asc' };

/**
 * Live filter: every whitespace-separated word must occur (case-insensitive) in the name, `schema.name` or the
 * comment, so `dbo.ord` and `order audit` both work.
 */
export function filterObjects(items: readonly ObjectListItem[], group: GroupFilter, query: string): ObjectListItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    if (group !== 'all' && groupOf(it.type) !== group) return false;
    if (!words.length) return true;
    const hay = `${it.schema ? `${it.schema}.` : ''}${it.name} ${it.comment ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function cmpNullable<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last in both directions
  if (b === null) return -1;
  return cmp(a, b);
}

export function sortObjects(items: readonly ObjectListItem[], sort: SortSpec): ObjectListItem[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const byName = (a: ObjectListItem, b: ObjectListItem) => collator.compare(a.name, b.name) || collator.compare(a.schema ?? '', b.schema ?? '');
  const key = (a: ObjectListItem, b: ObjectListItem): number => {
    switch (sort.key) {
      case 'schema':
        return collator.compare(a.schema ?? '', b.schema ?? '') * sign;
      case 'type':
        return (GROUPS.findIndex((g) => g.id === groupOf(a.type)) - GROUPS.findIndex((g) => g.id === groupOf(b.type))) * sign;
      case 'rows':
        return cmpNullable(a.rowCount, b.rowCount, (x, y) => (x - y) * sign);
      case 'size':
        return cmpNullable(a.sizeBytes, b.sizeBytes, (x, y) => (x - y) * sign);
      case 'modified':
        return cmpNullable(a.modified, b.modified, (x, y) => x.localeCompare(y) * sign);
      case 'comment':
        return cmpNullable(a.comment || null, b.comment || null, (x, y) => collator.compare(x, y) * sign);
      default:
        return byName(a, b) * sign;
    }
  };
  return [...items].sort((a, b) => key(a, b) || byName(a, b));
}

/** Clicking a header: same key flips the direction; a new key starts ascending (numbers and dates descending). */
export function nextSort(cur: SortSpec, key: SortKey): SortSpec {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'rows' || key === 'size' || key === 'modified' ? 'desc' : 'asc' };
}

/** One row per schema, type and name (overloaded routines come back once per overload). */
export function uniqueObjects(items: readonly ObjectListItem[]): ObjectListItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = itemKey(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The list without statistics, from the explorer's loaded catalog (shown while loading or when the request fails). */
export function fromCatalog(schemas: readonly CatalogSchema[], schema: string | null): ObjectListItem[] {
  return uniqueObjects(schemas
    .filter((s) => schema === null || s.name === schema)
    .flatMap((s) => s.objects.map((o) => ({
      type: o.t, schema: s.name, name: o.n, rowCount: null, sizeBytes: null, modified: null, created: null, comment: o.cm ?? null,
    }))));
}

/** Stable key of a row. */
export const itemKey = (it: Pick<ObjectListItem, 'schema' | 'type' | 'name'>) => `${it.schema ?? ''}\u0001${it.type}\u0001${it.name}`;

/** "Objects: Shop.dbo", "Objects: Shop", "Objects: main". */
export function objectsTitle(database: string | null, schema: string | null): string {
  return `Objects: ${[database, schema].filter(Boolean).join('.') || 'all'}`;
}

/** Dates arrive as server-local times; they are shown as is (no time zone shift). */
export function formatModified(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 1,234 / 12.3K / 4.5M: compact row counts for the cards. */
export function formatRowsShort(n: number | null): string {
  if (n === null) return '';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 100_000_000 ? 1 : 0)}M`;
}

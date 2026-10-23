// Saved queries (Navicat's "Queries" node under each schema): pure helpers shared by the explorer, the Objects tab, the
// palette and the commands. No React, no stores: the explorer imports it statically.
import type { SavedQuery, SavedQueryScope } from '../../api/savedQueries';
import type { ProviderId } from '../../api/types';
import type { SavedQueryTarget } from '../../commands/types';
import type { DbCatalog } from '../../store/catalog';
import type { SavedQueryBinding } from '../../store/tabs';
import type { SelectOption } from '../common/selectModel';
import { schemaIsDatabase } from '../../lib/providerLevels';

/** Key of a (database, schema) pair (the save dialog's schema picker). */
export const scopeKey = (s: Pick<SavedQueryScope, 'database' | 'schema'>) => `${s.database ?? ''}\u0001${s.schema ?? ''}`;

/**
 * The save dialog's schema picker: every schema of the connection the catalog knows (every loaded database). The
 * default (`extra`) comes first with the other schemas of its database (default schema first), then the other
 * databases by name, each under its own heading when the provider has databases.
 */
export function scopeOptions(
  dbs: Record<string, DbCatalog>, connectionId: string, multiDb: boolean, extra: SavedQueryScope,
): { options: SelectOption[]; byKey: Map<string, SavedQueryScope> } {
  const byKey = new Map<string, SavedQueryScope>();
  const options: SelectOption[] = [];
  const add = (database: string | null, schema: string | null) => {
    const k = scopeKey({ database, schema });
    if (byKey.has(k)) return;
    byKey.set(k, { connectionId, database, schema });
    options.push({ value: k, label: schema ?? database ?? '(default)', group: multiDb && database ? database : undefined });
  };
  const home = extra.database ?? '';
  const list = Object.values(dbs)
    .filter((d) => d.connectionId === connectionId && d.schemasResp)
    .sort((a, b) => Number((b.database ?? '') === home) - Number((a.database ?? '') === home) || (a.database ?? '').localeCompare(b.database ?? ''));
  if (!list.some((d) => (d.database ?? '') === home)) add(extra.database, extra.schema);
  for (const d of list) {
    const def = d.schemasResp!.defaultSchema;
    const names = d.schemasResp!.schemas.map((s) => s.name).sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
    if ((d.database ?? '') === home && extra.schema && !names.includes(extra.schema)) add(d.database, extra.schema);
    for (const n of names) add(d.database, n);
  }
  return { options, byKey };
}

/** A saved query's tooltip: its name, description and the first lines of its text. */
export function savedQueryTooltip(name: string, description: string | null, sql: string): string {
  const lines = sql.trim().split(/\r?\n/);
  const head = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
  return [name, description, head].filter(Boolean).join('\n');
}

export function targetOfQuery(q: SavedQuery): SavedQueryTarget {
  return { kind: 'savedQuery', connectionId: q.connectionId, database: q.database, schema: q.schema, id: q.id, name: q.name };
}

export function bindingOf(q: Pick<SavedQuery, 'id' | 'connectionId' | 'database' | 'schema' | 'name'>): SavedQueryBinding {
  return { id: q.id, connectionId: q.connectionId, database: q.database, schema: q.schema, name: q.name };
}

/**
 * The database a console opened on a saved query uses: Oracle consoles' "database" is the session's current schema,
 * SQLite has none to choose; elsewhere the query's database.
 */
export function consoleDatabaseFor(providerId: ProviderId | undefined, q: Pick<SavedQuery, 'database' | 'schema'>): string | null {
  if (schemaIsDatabase(providerId)) return q.schema; // Oracle, MySQL/MariaDB, ClickHouse, Cassandra
  if (providerId === 'sqlite') return null;
  return q.database;
}

/** Default console titles ("Console 3", "Edit: …") say nothing about the query: they are not offered as its name. */
export function suggestedNameFromTitle(title: string): string | undefined {
  const t = title.trim();
  if (!t || /^Console \d+$/i.test(t) || /^Edit:/i.test(t) || /^Query:/i.test(t)) return undefined;
  return t.replace(/\.sql$/i, '');
}

/** "2026-10-23 14:05" in the viewer's time zone (the engine stores UTC). */
export function formatQueryDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Live filter of the Objects tab's Queries group: every word must occur in the name, schema, description or text. */
export function filterQueries(items: readonly SavedQuery[], query: string): SavedQuery[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((q) => {
    const hay = `${q.schema ? `${q.schema}.` : ''}${q.name} ${q.description ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type QuerySortKey = 'name' | 'schema' | 'modified' | 'description';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sortQueries(items: readonly SavedQuery[], key: QuerySortKey, dir: 'asc' | 'desc'): SavedQuery[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: SavedQuery, b: SavedQuery) => collator.compare(a.name, b.name);
  const cmp = (a: SavedQuery, b: SavedQuery): number => {
    switch (key) {
      case 'schema': return collator.compare(a.schema ?? '', b.schema ?? '') * sign;
      case 'modified': return a.updatedAt.localeCompare(b.updatedAt) * sign;
      case 'description': {
        if (!a.description !== !b.description) return a.description ? -1 : 1; // empty last in both directions
        return collator.compare(a.description ?? '', b.description ?? '') * sign;
      }
      default: return byName(a, b) * sign;
    }
  };
  return [...items].sort((a, b) => cmp(a, b) || byName(a, b));
}

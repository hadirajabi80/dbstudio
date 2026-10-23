// Opening the Objects tab (WP3): one tab per connection, database and schema (re-opening activates it and switches to
// the requested type group). A null schema lists every schema of the database.
import { catalogDatabase } from '../../app/actions';
import { isConnectionTarget, isContainerTarget, isObjectTarget, type CommandTarget } from '../../commands/types';
import { dbKey, useCatalog } from '../../store/catalog';
import { getConnection, providerKind } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';
import { DEFAULT_SORT, groupForType, OBJECTS_VIEW, objectsTitle, type GroupFilter, type SortSpec } from './model';

export interface ObjectsState {
  connectionId: string;
  database: string | null;
  schema: string | null;
  group: GroupFilter;
  layout: ObjectsLayout;
  sort: SortSpec;
}

/** list = sortable table; grid = cards with stats; compact = small icon + name tiles, many per row. */
export type ObjectsLayout = 'list' | 'grid' | 'compact';

export interface ObjectsScope {
  connectionId: string;
  database: string | null;
  schema: string | null;
  group?: GroupFilter;
}

export const objectsKey = (s: Pick<ObjectsScope, 'connectionId' | 'database' | 'schema'>) => `objects:${s.connectionId}:${s.database ?? ''}:${s.schema ?? ''}`;

/** Scope of an explorer target: a database/schema/folder node, an object (its schema, on its type), or a connection. */
export function scopeOf(t: CommandTarget | null | undefined): ObjectsScope | null {
  if (!t || !('connectionId' in t)) return null;
  const conn = getConnection(t.connectionId);
  if (!conn || providerKind(conn.providerId) !== 'relational') return null;
  if (isContainerTarget(t)) return { connectionId: t.connectionId, database: t.database, schema: t.schema, group: groupForType(t.objectType) };
  if (isObjectTarget(t)) return { connectionId: t.connectionId, database: t.database, schema: t.ref.schema, group: groupForType(t.ref.type) };
  if (isConnectionTarget(t)) {
    // A connection: its default schema when it has a single one (SQLite main), else every schema of the current database.
    const d = useCatalog.getState().dbs[dbKey(t.connectionId, null)];
    const single = d?.schemasResp?.schemas.length === 1 ? d.schemasResp.schemas[0].name : null;
    return { connectionId: t.connectionId, database: null, schema: single, group: 'all' };
  }
  return null;
}

export function openObjects(scope: ObjectsScope): string {
  const key = objectsKey(scope);
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((x): x is ViewTab => x.kind === 'view' && x.view === OBJECTS_VIEW && x.key === key);
  if (existing) {
    const prev = existing.state as ObjectsState;
    if (scope.group && scope.group !== prev.group) tabs.updateView(existing.id, { state: { ...prev, group: scope.group } });
    tabs.activate(existing.id);
    tabs.requestFocus(existing.id);
    return existing.id;
  }
  const state: ObjectsState = {
    connectionId: scope.connectionId, database: scope.database, schema: scope.schema, group: scope.group ?? 'all', layout: 'list', sort: DEFAULT_SORT,
  };
  // The title names the database even when the scope uses the connection's current one ("Objects: Shop.dbo").
  const shownDb = scope.database ?? (getConnection(scope.connectionId)?.providerId === 'sqlite' ? null : catalogDatabase(scope.connectionId, null));
  return tabs.openView({
    view: OBJECTS_VIEW, title: objectsTitle(shownDb, scope.schema), connectionId: scope.connectionId, database: scope.database, state, key,
  });
}

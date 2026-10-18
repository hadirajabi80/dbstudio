// Source modules (docs/PLAN-M2.md 1.3, 2.5): the plug-in point through which the Redis, MongoDB and Kafka packages
// add their explorer subtree, context menus, row activation, default workspace and Ctrl+P entries for connections whose
// provider kind is not `relational`. The shell (Explorer, actions, command palette) only talks to this registry.
//
// A feature package registers from its `components/<Feature>/commands.ts` (auto-loaded at startup by commands/index.ts;
// put the registration in its `register…Commands()` export). Keep heavy views behind `lazy(() => import(...))`.
//
//   registerSourceModule({
//     providerId: 'redis', kind: 'keyvalue',
//     tree: ({ connection, depth, expanded }) => redisRows(connection, depth, expanded),
//     contextMenuId: (row) => row.source?.nodeType === 'key' ? 'explorer.redis.key' : 'explorer.redis.db',
//     activate: (row) => openKey(row),
//     defaultWorkspace: (cid) => openRedisBrowser(cid),
//     paletteEntries: () => scannedKeys(),
//   });
//
// and calls `notifySourceTreeChanged()` whenever data shown by `tree()` or `paletteEntries()` changed (the explorer and
// the palette re-render on it).
import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { ConnectionProfile, ProviderId, SourceKind } from '../api/types';
import type { TreeRow } from '../components/Explorer/tree';

/** Input of `SourceModule.tree` for one expanded connection. */
export interface SourceTreeInput {
  connection: ConnectionProfile;
  /** Depth of the rows returned (the connection row itself is at `depth - 1` and is added by the explorer). */
  depth: number;
  /** Expanded node ids of the explorer (row ids from `sourceNodeId`). */
  expanded: ReadonlySet<string>;
  /** Explorer filter text ('' = none). Filter mode: return only matching rows (with their ancestors), expanded. */
  filter: string;
}

/** A Ctrl+P entry contributed by a source module (Redis keys, Mongo collections, Kafka topics...). */
export interface PaletteSourceEntry {
  /** Display name searched by the palette (e.g. the key, `shop.orders`, the topic). */
  name: string;
  type: 'redis.key' | 'mongo.collection' | 'kafka.topic';
  connectionId: string;
  /** Short context shown next to the name (database, "db 0", cluster name...). */
  detail?: string;
  /** Opens the entry (Enter in the palette). */
  open: () => void;
}

export interface SourceModule {
  providerId: ProviderId;
  kind: Exclude<SourceKind, 'relational'>;
  /** Child rows of an expanded connection. Rows use `kind: 'source'` with `source` set (see `sourceRow`). */
  tree: (input: SourceTreeInput) => TreeRow[];
  /** Context menu id of a source row (menu ids reserved in commands/menuModel.ts, e.g. `explorer.redis.key`). */
  contextMenuId: (row: TreeRow) => string | null;
  /** Enter / double-click on a source row (leaf rows open their view; containers are toggled by the explorer). */
  activate: (row: TreeRow) => void;
  /** "Connect" / Welcome / connection dialog: open the default view (Redis browser, Mongo documents, Kafka overview). */
  defaultWorkspace: (connectionId: string) => void;
  /** Ctrl+P entries from already loaded data (never fetches). */
  paletteEntries: () => PaletteSourceEntry[];
  /** Optional: start lazy loads for the expanded nodes of a connection (called by the explorer after expand changes). */
  ensureLoaded?: (connection: ConnectionProfile, expanded: ReadonlySet<string>) => void;
  /** Optional: icon of a source row (default: folder for containers, a generic item glyph for leaves). */
  icon?: (row: TreeRow) => ReactNode;
  /** Optional: Disconnect hook (after the engine source client was closed), e.g. to drop cached scan results. */
  onDisconnect?: (connectionId: string) => void;
}

interface SourceModulesState {
  modules: Record<string, SourceModule>;
  /** Bumped by `notifySourceTreeChanged` (explorer/palette memo dependency). */
  version: number;
}

export const useSourceModules = create<SourceModulesState>(() => ({ modules: {}, version: 0 }));

/** Registers (or replaces, e.g. on HMR) the module of a provider. Returns an unregister function. */
export function registerSourceModule(module: SourceModule): () => void {
  useSourceModules.setState((s) => ({ modules: { ...s.modules, [module.providerId]: module }, version: s.version + 1 }));
  return () => {
    useSourceModules.setState((s) => {
      if (s.modules[module.providerId] !== module) return s;
      const next = { ...s.modules };
      delete next[module.providerId];
      return { modules: next, version: s.version + 1 };
    });
  };
}

export function getSourceModule(providerId: string | null | undefined): SourceModule | undefined {
  return providerId ? useSourceModules.getState().modules[providerId] : undefined;
}

export function listSourceModules(): SourceModule[] {
  return Object.values(useSourceModules.getState().modules);
}

/** Tell the explorer and the palette that a module's tree or palette entries changed. */
export function notifySourceTreeChanged(): void {
  useSourceModules.setState((s) => ({ version: s.version + 1 }));
}

/** Row id of a source node: unique per connection and path (`x:` prefix keeps it apart from catalog ids). */
export function sourceNodeId(connectionId: string, path: readonly string[]): string {
  return `x:${connectionId}:${path.map((p) => encodeURIComponent(p)).join('/')}`;
}

/** Builds a source tree row with the conventional id and fields. */
export function sourceRow(init: {
  connectionId: string;
  providerId: ProviderId;
  nodeType: string;
  path: string[];
  depth: number;
  label: string;
  expanded: ReadonlySet<string>;
  expandable?: boolean;
  detail?: string;
  count?: number;
  meta?: unknown;
  match?: number[];
  forceOpen?: boolean;
}): TreeRow {
  const id = sourceNodeId(init.connectionId, init.path);
  const expandable = init.expandable ?? false;
  return {
    id,
    kind: 'source',
    depth: init.depth,
    label: init.label,
    detail: init.detail,
    count: init.count,
    match: init.match,
    expandable,
    expanded: expandable && (init.forceOpen === true || init.expanded.has(id)),
    connectionId: init.connectionId,
    source: { providerId: init.providerId, nodeType: init.nodeType, path: init.path, meta: init.meta },
  };
}

// The permanent Objects tab (Navicat's first "Objects" tab): pinned first in the first editor group of the main
// window, it lists the objects of whatever is selected in the explorer and follows the selection live.
//
//   connection        → its databases (or schemas) as cards to drill into; a single-schema connection lists its objects
//   database / schema → its objects, on the type filter last chosen for that scope (Tables the first time)
//   type folder       → the same list switched to that type (Procedures, Views…)
//   table / routine   → its schema's list with the object highlighted
//   nothing           → the welcome content (recent connections, new connection)
//
// Following the selection never activates the tab or moves the focus: the tab updates in the background and is seen
// when the user switches to it (it is the active tab anyway while no other tab is open). "Show objects" (Enter or
// double-click on a database / schema / folder, the container menu) activates it on that scope.
//
// This module is logic only (no React; boot.ts imports it): the view is components/ObjectList/ObjectsHomeView.tsx,
// registered lazily by ObjectList/commands.ts. Detached windows never get the tab (boot never installs it there and
// useTabs.adopt refuses pinned tabs).
import type { CatalogObjectType } from '../../api/types';
import type { CommandTarget } from '../../commands/types';
import { getConnection, providerKind } from '../../store/connections';
import { showObjectsTab, useSettings } from '../../store/settings';
import { isPinnedTab, useTabs, type ViewTab } from '../../store/tabs';
import { useExplorer } from '../Explorer/explorerStore';
import { DEFAULT_SORT, groupOf, type GroupFilter, type SortSpec } from './model';
import type { ObjectsLayout } from './open';

export const OBJECTS_HOME_VIEW = 'objectsHome';
export const OBJECTS_HOME_ID = 'objects-home';
export const OBJECTS_HOME_TITLE = 'Objects';
/** Explorer selection → Objects tab delay (arrowing through the tree does not reload the list on every row). */
export const FOLLOW_DELAY_MS = 120;
/** A scope seen for the first time lists its tables (Navicat's default). */
export const DEFAULT_HOME_GROUP: GroupFilter = 'table';
const MAX_REMEMBERED_SCOPES = 200;

/** What the tab shows. */
export type HomeTarget =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'scope'; connectionId: string; database: string | null; schema: string | null }
  /** A Redis / MongoDB / Kafka node: browsed in the explorer, not listed here. */
  | { kind: 'unsupported'; connectionId: string };

export interface HomeHighlight {
  schema: string | null;
  name: string;
  type: CatalogObjectType;
}

/** Serializable state of the Objects tab (persisted with the workspace). */
export interface ObjectsHomeState {
  target: HomeTarget | null;
  /** The explorer's selected object, highlighted in the list. */
  highlight: HomeHighlight | null;
  /** The type filter chosen per scope (homeScopeKey). */
  groups: Record<string, GroupFilter>;
  layout: ObjectsLayout;
  sort: SortSpec;
}

export const EMPTY_HOME: ObjectsHomeState = { target: null, highlight: null, groups: {}, layout: 'list', sort: DEFAULT_SORT };

export function homeScopeKey(s: { connectionId: string; database: string | null; schema: string | null }): string {
  return `${s.connectionId}\u0001${s.database ?? ''}\u0001${s.schema ?? ''}`;
}

/** The tab's state, repaired (a workspace from another build, a hand-edited file). */
export function homeStateOf(tab: Pick<ViewTab, 'state'> | undefined | null): ObjectsHomeState {
  const s = (tab?.state ?? null) as Partial<ObjectsHomeState> | null;
  if (!s || typeof s !== 'object') return EMPTY_HOME;
  const t = s.target as HomeTarget | null | undefined;
  const target = t && typeof t === 'object' && typeof t.connectionId === 'string' && (t.kind === 'connection' || t.kind === 'scope' || t.kind === 'unsupported')
    ? t : null;
  return {
    target,
    highlight: s.highlight && typeof s.highlight === 'object' && typeof s.highlight.name === 'string' ? s.highlight : null,
    groups: s.groups && typeof s.groups === 'object' ? s.groups : {},
    layout: s.layout === 'grid' || s.layout === 'compact' ? s.layout : 'list',
    sort: s.sort && typeof s.sort === 'object' && typeof s.sort.key === 'string' ? s.sort : DEFAULT_SORT,
  };
}

export function groupForScope(state: ObjectsHomeState, key: string): GroupFilter {
  return state.groups[key] ?? DEFAULT_HOME_GROUP;
}

function withGroup(groups: Record<string, GroupFilter>, key: string, g: GroupFilter): Record<string, GroupFilter> {
  if (groups[key] === g) return groups;
  const next = { ...groups };
  delete next[key];
  next[key] = g;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_SCOPES))) delete next[k];
  return next;
}

export function isRelationalConnection(connectionId: string): boolean {
  const c = getConnection(connectionId);
  return !!c && providerKind(c.providerId) === 'relational';
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The state after the explorer selected `target` (pure). Returns `state` itself when nothing changes. A type folder
 * switches its scope's filter to that type; a selected object switches it only when the filter would hide the object.
 */
export function followTarget(state: ObjectsHomeState, target: CommandTarget | null | undefined, relational: (connectionId: string) => boolean): ObjectsHomeState {
  let next: Pick<ObjectsHomeState, 'target' | 'highlight' | 'groups'>;
  if (!target || !('connectionId' in target)) next = { target: null, highlight: null, groups: state.groups };
  else if (!relational(target.connectionId)) next = { target: { kind: 'unsupported', connectionId: target.connectionId }, highlight: null, groups: state.groups };
  else if (target.kind === 'connection') next = { target: { kind: 'connection', connectionId: target.connectionId }, highlight: null, groups: state.groups };
  else if (target.kind === 'container') {
    const scope = { kind: 'scope' as const, connectionId: target.connectionId, database: target.database ?? null, schema: target.schema ?? null };
    const groups = target.objectType ? withGroup(state.groups, homeScopeKey(scope), groupOf(target.objectType)) : state.groups;
    next = { target: scope, highlight: null, groups };
  } else if (target.kind === 'object') {
    const scope = { kind: 'scope' as const, connectionId: target.connectionId, database: target.database ?? null, schema: target.ref.schema ?? null };
    const key = homeScopeKey(scope);
    const cur = groupForScope(state, key);
    const own = groupOf(target.ref.type);
    const groups = cur !== 'all' && cur !== own ? withGroup(state.groups, key, own) : state.groups;
    next = { target: scope, highlight: { schema: target.ref.schema ?? null, name: target.ref.name, type: target.ref.type }, groups };
  } else return state;
  if (same(next.target, state.target) && same(next.highlight, state.highlight) && next.groups === state.groups) return state;
  return { ...state, ...next };
}

export function homeTab(): ViewTab | undefined {
  return useTabs.getState().tabs.find((t): t is ViewTab => t.id === OBJECTS_HOME_ID && isPinnedTab(t));
}

function patchHome(fn: (s: ObjectsHomeState) => ObjectsHomeState): void {
  const tab = homeTab();
  if (!tab) return;
  const prev = homeStateOf(tab);
  const next = fn(prev);
  if (next !== prev) useTabs.getState().updateView(tab.id, { state: next });
}

/** Show the explorer node's objects in the tab (no activation). */
export function followSelection(target: CommandTarget | null | undefined): void {
  patchHome((s) => followTarget(s, target, isRelationalConnection));
}

/**
 * "Show objects": the Objects tab on that node, activated and focused. Null when the tab is off (the caller opens a
 * per-scope Objects tab instead).
 */
export function showInObjectsHome(target: CommandTarget): string | null {
  const tab = homeTab();
  if (!tab) return null;
  followSelection(target);
  const tabs = useTabs.getState();
  tabs.activate(tab.id);
  tabs.requestFocus(tab.id);
  return tab.id;
}

/** The list's type filter (remembered for the scope), layout and sort (shared by every scope). */
export function setHomeListOptions(scopeKey: string, p: { group?: GroupFilter; layout?: ObjectsLayout; sort?: SortSpec }): void {
  patchHome((s) => ({
    ...s,
    ...(p.group ? { groups: withGroup(s.groups, scopeKey, p.group) } : {}),
    ...(p.layout ? { layout: p.layout } : {}),
    ...(p.sort ? { sort: p.sort } : {}),
  }));
}

// ------------------------------------------------------------------------------------------------- installation

let uninstall: (() => void) | null = null;
/** The tab's state while it is hidden by the setting (shown again as it was). */
let parked: ObjectsHomeState | null = null;

/** Adds or removes the tab to match the setting. */
export function syncObjectsHome(): void {
  const tabs = useTabs.getState();
  const tab = homeTab();
  const on = showObjectsTab(useSettings.getState().settings);
  if (on && !tab) {
    tabs.pin({ id: OBJECTS_HOME_ID, title: OBJECTS_HOME_TITLE, view: OBJECTS_HOME_VIEW, connectionId: null, database: null, state: parked ?? EMPTY_HOME, key: OBJECTS_HOME_ID, dirty: false });
  } else if (!on && tab) {
    parked = homeStateOf(tab);
    tabs.unpin(tab.id);
  }
}

/**
 * Main window only (boot.ts, after the workspace is restored): keeps the tab in step with the setting and the explorer
 * selection. Returns the uninstaller (tests).
 */
export function installObjectsHome(): () => void {
  if (uninstall) return uninstall;
  syncObjectsHome();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const offSettings = useSettings.subscribe((s, p) => {
    if (showObjectsTab(s.settings) !== showObjectsTab(p.settings)) syncObjectsHome();
  });
  // A workspace restored later, or tabs replaced from outside: the tab comes back.
  const offTabs = useTabs.subscribe((s, p) => {
    if (s.tabs !== p.tabs && !s.tabs.some((t) => t.id === OBJECTS_HOME_ID) && showObjectsTab(useSettings.getState().settings)) syncObjectsHome();
  });
  const offExplorer = useExplorer.subscribe((s, p) => {
    if (s.selectedTarget === p.selectedTarget) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      followSelection(useExplorer.getState().selectedTarget);
    }, FOLLOW_DELAY_MS);
  });
  uninstall = () => {
    if (timer) clearTimeout(timer);
    offSettings();
    offTabs();
    offExplorer();
    uninstall = null;
    parked = null;
  };
  return uninstall;
}

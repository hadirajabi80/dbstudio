// Opening Data tabs (PLAN-M1.5 A1): a `view` tab registered as 'data' (components/layout/tabViews).
import type { CatalogObjectType, CellValue } from '../../api/types';
import { newCondition, newGroup, type FilterGroup } from '../../filter/model';
import { useTabs } from '../../store/tabs';
import { focusIsLost } from '../common/focus';
import { focusGrid } from '../Grid/controller';

export const DATA_VIEW = 'data';

/** Serializable state of a Data tab (persisted with the workspace). */
export interface DataTabState {
  schema: string | null;
  name: string;
  type?: CatalogObjectType;
  /** Initial / externally requested filter (FK navigation); applied when `nonce` changes. */
  filter?: FilterGroup | null;
  /** Quick search over the text columns (persisted). */
  quick?: string;
  /** Server ORDER BY by column name (persisted). */
  sort?: SortByName[];
  nonce?: number;
}

/** A sort key stored by column name (column positions can change between sessions). */
export interface SortByName {
  column: string;
  dir: 'asc' | 'desc';
}

export interface OpenDataTabOptions {
  connectionId: string;
  database: string | null;
  schema: string | null;
  name: string;
  type?: CatalogObjectType;
  /** Equality filter on key columns (FK navigation), or a full filter tree. */
  filter?: { column: string; value: CellValue }[] | FilterGroup | null;
}

export function dataTabKey(connectionId: string, database: string | null, schema: string | null, name: string): string {
  return `${connectionId}|${database ?? ''}|${schema ?? ''}.${name}`.toLowerCase();
}

export function pairsToFilter(pairs: { column: string; value: CellValue }[]): FilterGroup {
  return newGroup('and', pairs.map((p) => {
    if (p.value === null) return newCondition(p.column, 'isNull');
    const v = typeof p.value === 'object' ? null : p.value;
    return newCondition(p.column, 'eq', [v]);
  }));
}

export function openDataTab(o: OpenDataTabOptions): string {
  const filter = !o.filter ? null : Array.isArray(o.filter) ? pairsToFilter(o.filter) : o.filter;
  const state: DataTabState = { schema: o.schema, name: o.name, type: o.type, filter, nonce: Date.now() };
  return useTabs.getState().openView({
    view: DATA_VIEW,
    title: `${o.schema ? `${o.schema}.` : ''}${o.name}`,
    connectionId: o.connectionId,
    database: o.database,
    state,
    key: dataTabKey(o.connectionId, o.database, o.schema, o.name),
  });
}

export const dataGridKey = (tabId: string) => `data:${tabId}`;

// ------------------------------------------------------------------ primary focus (design-15)

/** Data tabs whose grid should take focus as soon as it renders (opened from a command before the rows arrived). */
const pendingGridFocus = new Map<string, { origin: Element | null; until: number }>();
const PENDING_FOCUS_MS = 15_000;

/**
 * `focusPrimary` of the data view: focus the tab's grid. While the grid is not rendered yet (the first page is still
 * loading) the request is remembered and the tab focuses its grid once it appears (`consumeGridFocus`), unless the
 * user has moved focus meanwhile. It never falls back to the search box: the request counts as handled.
 */
export function focusDataTabPrimary(tabId: string): boolean {
  if (focusGrid(dataGridKey(tabId))) {
    pendingGridFocus.delete(tabId);
    return true;
  }
  pendingGridFocus.set(tabId, { origin: typeof document === 'undefined' ? null : document.activeElement, until: Date.now() + PENDING_FOCUS_MS });
  return true;
}

/** Called by the data tab once its grid is rendered: performs a remembered focus request (true when it did). */
export function consumeGridFocus(tabId: string): boolean {
  const req = pendingGridFocus.get(tabId);
  if (!req) return false;
  if (Date.now() > req.until || useTabs.getState().activeId !== tabId) {
    pendingGridFocus.delete(tabId);
    return false;
  }
  // The user went somewhere else meanwhile (clicked the search box, another tab, …): leave focus alone.
  const a = typeof document === 'undefined' ? null : document.activeElement;
  if (a !== req.origin && !focusIsLost()) {
    pendingGridFocus.delete(tabId);
    return false;
  }
  if (!focusGrid(dataGridKey(tabId))) return false; // not focusable yet: the tab tries again
  pendingGridFocus.delete(tabId);
  return true;
}

export function hasPendingGridFocus(tabId: string): boolean {
  return pendingGridFocus.has(tabId);
}

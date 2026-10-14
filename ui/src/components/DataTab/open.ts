// Opening Data tabs (PLAN-M1.5 A1): a `view` tab registered as 'data' (components/layout/tabViews).
import type { CatalogObjectType, CellValue } from '../../api/types';
import { newCondition, newGroup, type FilterGroup } from '../../filter/model';
import { useTabs } from '../../store/tabs';

export const DATA_VIEW = 'data';

/** Serializable state of a Data tab (persisted with the workspace). */
export interface DataTabState {
  schema: string | null;
  name: string;
  type?: CatalogObjectType;
  /** Initial / externally requested filter (FK navigation); applied when `nonce` changes. */
  filter?: FilterGroup | null;
  quick?: string;
  nonce?: number;
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
export const countTabId = (tabId: string) => `${tabId}::count`;

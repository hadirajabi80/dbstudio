// Opening the Search tab (Ctrl+Shift+F) and the objects its results point at.
import type { SearchHitItem } from '../../api/types.search';
import { activateObject } from '../../app/actions';
import { getEditor } from '../../app/editors';
import type { CommandTarget, ObjectTarget } from '../../commands/types';
import { newCondition, newGroup } from '../../filter/model';
import { isTabular } from '../../lib/sql';
import { getConnection, providerKind } from '../../store/connections';
import { useTabs, type ViewTab } from '../../store/tabs';
import { openDataTab, pairsToFilter } from '../DataTab/open';
import { useExplorer } from '../Explorer/explorerStore';
import { requestObjectSection } from '../ObjectTab/sectionRequests';
import { DEFAULT_OPTIONS, matchedText, scopeFromTarget, SEARCH_TAB_KEY, SEARCH_VIEW, type ObjectGroup, type SearchScope, type SearchTabState } from './model';

export function isRelationalConnection(connectionId: string): boolean {
  const c = getConnection(connectionId);
  return !!c && providerKind(c.providerId) === 'relational';
}

/** True while keyboard focus is inside the explorer tree (its selection is then what the user means). */
function explorerHasFocus(): boolean {
  const a = typeof document === 'undefined' ? null : document.activeElement;
  return !!a && !!a.closest?.('[data-command-scope~="explorer"]');
}

/** Selected single-line text of the focused console editor (pre-fills the search box). */
function editorSelection(tab: { id: string; kind: string } | undefined): string | null {
  if (!tab || tab.kind !== 'console') return null;
  const a = typeof document === 'undefined' ? null : document.activeElement;
  if (!a?.closest?.('.monaco-editor')) return null;
  const t = getEditor(tab.id)?.getRunTarget('statement');
  const text = t?.label === 'selection' ? t.text.trim() : '';
  return text && !text.includes('\n') && text.length <= 200 ? text : null;
}

export interface OpenSearchResult {
  tabId: string;
  /** The context could not be searched (a Redis/MongoDB/Kafka node): the scope fell back to every connection. */
  unsupported: boolean;
}

/**
 * Ctrl+Shift+F / "Find in database…". The scope comes from `args` (a context menu target) or, when the explorer has
 * focus, its selected node; otherwise every connected connection (the active tab's connection is offered in the view).
 * Re-opening keeps the term (unless the console has a one-line selection) and switches to the new scope.
 */
export function openSearch(args?: CommandTarget | null): OpenSearchResult {
  const tabs = useTabs.getState();
  const active = tabs.tabs.find((t) => t.id === tabs.activeId);
  const existing = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === SEARCH_VIEW);
  const prev = existing?.state as SearchTabState | undefined;

  const target = args ?? (explorerHasFocus() ? useExplorer.getState().selectedTarget : null);
  const fromTarget = scopeFromTarget(target, isRelationalConnection);
  const unsupported = !!target && 'connectionId' in target && !fromTarget;
  const searchingActive = active?.kind === 'view' && active.view === SEARCH_VIEW;
  // From inside the Search tab itself: keep its scope.
  const scope: SearchScope = fromTarget?.scope ?? (searchingActive && prev && !unsupported ? prev.scope : { kind: 'all' });
  const consoleConnectionId = searchingActive
    ? prev?.consoleConnectionId ?? null
    : active?.connectionId && isRelationalConnection(active.connectionId) ? active.connectionId : null;
  const selection = editorSelection(active);

  const state: SearchTabState = {
    ...DEFAULT_OPTIONS,
    ...(prev ?? {}),
    ...(fromTarget ? { types: fromTarget.types ?? [] } : {}),
    ...(selection ? { term: selection } : {}),
    scope,
    consoleConnectionId,
    nonce: Date.now(),
  };
  const tabId = tabs.openView({ view: SEARCH_VIEW, title: 'Search', state, key: SEARCH_TAB_KEY });
  return { tabId, unsupported };
}

function objectTarget(o: Pick<ObjectGroup, 'connectionId' | 'database' | 'schema' | 'name' | 'type'>): ObjectTarget {
  return { kind: 'object', connectionId: o.connectionId, database: o.database, ref: { database: o.database, schema: o.schema, name: o.name, type: o.type } };
}

/** The explorer target of a result object (context menu, reveal). */
export function targetOfObject(o: Pick<ObjectGroup, 'connectionId' | 'database' | 'schema' | 'name' | 'type'>): ObjectTarget {
  return objectTarget(o);
}

/** Enter / double-click on a result object: the explorer's default open (object tab, or a routine's edit console). */
export function openObjectOf(o: Pick<ObjectGroup, 'connectionId' | 'database' | 'schema' | 'name' | 'type'>): void {
  const t = objectTarget(o);
  activateObject(t.connectionId, t.database, t.ref);
}

/**
 * Enter / double-click on a match: a column opens the object tab on that column, code opens the DDL with the cursor
 * on the match, a data match opens the table's data filtered on the row (its key) or on the matched text.
 */
export function openHit(h: SearchHitItem, opts: { matchCase: boolean }): void {
  const o = { connectionId: h.connectionId, database: h.database, schema: h.schema, name: h.object.name, type: h.object.type };
  const t = objectTarget(o);
  const tabs = useTabs.getState();
  switch (h.match) {
    case 'name':
      openObjectOf(o);
      return;
    case 'column':
      tabs.openObject(t.connectionId, t.database, t.ref, h.column ?? h.text);
      return;
    case 'code': {
      const id = tabs.openObject(t.connectionId, t.database, t.ref);
      const text = matchedText(h);
      requestObjectSection(id, 'ddl', text ? { text, line: h.line, matchCase: opts.matchCase } : undefined);
      return;
    }
    case 'data': {
      if (!isTabular(h.object.type)) return;
      const filter = h.key?.length
        ? pairsToFilter(h.key)
        : newGroup('and', [newCondition(h.column ?? '', 'contains', [matchedText(h) ?? h.text])]);
      openDataTab({ connectionId: h.connectionId, database: h.database, schema: h.schema, name: h.object.name, type: h.object.type, filter });
      return;
    }
  }
}

/** Show a result object in the explorer (expand its ancestors, select it). */
export function revealObject(o: Pick<ObjectGroup, 'connectionId' | 'database' | 'schema' | 'name' | 'type'>): void {
  useExplorer.getState().reveal(objectTarget(o));
}

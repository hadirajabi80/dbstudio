// Opening Find in database (Ctrl+Shift+F: the dialog; "Open in tab": the Search tab) and the objects its results
// point at.
import type { SearchHitItem } from '../../api/types.search';
import { activateObject } from '../../app/actions';
import { getEditor } from '../../app/editors';
import type { CommandTarget, ObjectTarget } from '../../commands/types';
import { newCondition, newGroup } from '../../filter/model';
import { isTabular } from '../../lib/sql';
import { getConnection, providerKind } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { openDataTab, pairsToFilter } from '../DataTab/open';
import { useExplorer } from '../Explorer/explorerStore';
import { requestObjectSection } from '../ObjectTab/sectionRequests';
import { SEARCH_DIALOG_RUN, useSearchDialog } from './dialogStore';
import {
  DEFAULT_OPTIONS, matchedText, scopeFromTarget, SEARCH_TAB_KEY, SEARCH_VIEW, type ObjectGroup, type SearchScope, type SearchTabState,
} from './model';
import { useSearchRuns } from './searchStore';

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
  /** The context could not be searched (a Redis/MongoDB/Kafka node): the scope fell back to every connection. */
  unsupported: boolean;
}

/** Identity of an explorer selection (the dialog re-scopes when it changed since the last open). */
function selectionKey(t: CommandTarget | null): string | null {
  return t ? JSON.stringify(t) : null;
}

/**
 * Ctrl+Shift+F / "Find in database…": the Find in database dialog, with the last query, scope and results. The scope
 * comes from `args` (a context menu target), else from the explorer's selected node when the explorer has focus or
 * its selection changed since the dialog last opened (the first open included); otherwise the last scope stays (every
 * connected connection the first time). A one-line selection in the focused console becomes the search text.
 */
export function openSearch(args?: CommandTarget | null): OpenSearchResult {
  const tabs = useTabs.getState();
  const active = tabs.tabs.find((t) => t.id === tabs.activeId);
  const dialog = useSearchDialog.getState();
  const prev = dialog.state;
  const selected = useExplorer.getState().selectedTarget;
  const selKey = selectionKey(selected);

  const explicit = args ?? (explorerHasFocus() ? selected : null);
  const target = explicit ?? (!prev || selKey !== dialog.explorerKey ? selected : null);
  const fromTarget = scopeFromTarget(target, isRelationalConnection);
  const unsupported = !!explicit && 'connectionId' in explicit && !fromTarget;
  const scope: SearchScope = fromTarget?.scope ?? (unsupported || !prev ? { kind: 'all' } : prev.scope);
  const consoleConnectionId = active?.connectionId && isRelationalConnection(active.connectionId) ? active.connectionId : prev?.consoleConnectionId ?? null;
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
  dialog.show(state, selKey);
  return { unsupported };
}

/** The Search tab (one, reused) with this query; returns its id. */
export function openSearchTab(state: SearchTabState): string {
  return useTabs.getState().openView({ view: SEARCH_VIEW, title: 'Search', state: { ...state, nonce: Date.now() }, key: SEARCH_TAB_KEY });
}

/**
 * "Open in tab" (the dialog's pin button): the dialog's query, scope and results (still streaming or not) move into
 * the Search tab, for a long session next to the other tabs. The dialog closes.
 */
export function moveSearchToTab(): string | null {
  const dialog = useSearchDialog.getState();
  if (!dialog.state) return null;
  dialog.close();
  const tabId = openSearchTab(dialog.state);
  useSearchRuns.getState().transfer(SEARCH_DIALOG_RUN, tabId);
  return tabId;
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

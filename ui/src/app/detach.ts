// Tabs in their own windows ("Open in new window" / drag a tab out of the window / "Move back to main window").
// Each Electron window runs its own UI, so a tab moves as its serialized workspace form (text, connection, database,
// transaction mode; a view's own state): results are not carried over and the engine session of a console is
// released in the window it leaves (the console opens a new one on its next run).
import { pluralize } from '../components/common/text';
import { getTabView } from '../components/layout/tabViews';
import { isDetachedWindow, windowsApi } from '../platform/windows';
import { useResults } from '../store/results';
import { isRunning } from '../store/resultsReducer';
import { useSessions } from '../store/sessions';
import { isRestorableTab, useTabs, type Tab } from '../store/tabs';
import { toast, useUi } from '../store/ui';

/** True when this window can open tabs in new windows (desktop). */
export function canDetachTabs(): boolean {
  return windowsApi() !== null;
}

/** True when the tab can be handed to the main window (this is a detached window). */
export function canReattachTabs(): boolean {
  return canDetachTabs() && isDetachedWindow();
}

/** A deep copy of the tab as plain JSON (what the workspace file stores). */
function serializeTab(tab: Tab): Tab {
  return JSON.parse(JSON.stringify(tab)) as Tab;
}

/**
 * Asks before moving a tab whose console has an open transaction or a running query (the move releases the session),
 * then releases what the tab holds in this window. False when the user cancelled.
 */
async function releaseTab(tab: Tab, where: string): Promise<boolean> {
  const s = useSessions.getState().forTab(tab.id);
  const exec = useResults.getState().executions[useResults.getState().byTab[tab.id]];
  if (s?.txOpen || isRunning(exec)) {
    const ok = await useUi.getState().askConfirm({
      title: s?.txOpen ? 'Uncommitted transaction' : 'Query running',
      message: s?.txOpen
        ? `“${tab.title}” has an open transaction. Moving it ${where} rolls the transaction back.`
        : `A query is still running in “${tab.title}”. Moving it ${where} cancels the query.`,
      confirmLabel: s?.txOpen ? 'Roll back and move' : 'Cancel query and move',
      danger: true,
    });
    if (!ok) return false;
  }
  return true;
}

async function cleanupAfterMove(tab: Tab): Promise<void> {
  if (tab.kind === 'view') {
    try {
      getTabView(tab.view)?.onClosed?.(tab);
    } catch (e) {
      console.warn('[windows] onClosed failed', e);
    }
  }
  useResults.getState().clearTab(tab.id);
  if (useSessions.getState().forTab(tab.id)) {
    try {
      await useSessions.getState().close(tab.id, true);
    } catch (e) {
      console.warn('[windows] session close failed', e);
    }
  }
}

/** Opens a tab in a new window (at a screen position, e.g. where a dragged tab was dropped) and removes it here. */
export async function detachTab(tabId: string, position?: { x: number; y: number }): Promise<boolean> {
  const api = windowsApi();
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!api || !tab) return false;
  if (!(await releaseTab(tab, 'to a new window'))) return false;
  let ok = false;
  try {
    ok = await api.openTabWindow({ tabs: [serializeTab(tab)], ...(position ? { position: { x: Math.round(position.x), y: Math.round(position.y) } } : {}) });
  } catch (e) {
    toast('error', 'Could not open a new window', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!ok) return false;
  useTabs.getState().take(tabId);
  await cleanupAfterMove(tab);
  afterTabLeft();
  return true;
}

/** Detached window: hands a tab back to the main window. The window closes once its last tab is gone. */
export async function reattachTab(tabId: string): Promise<boolean> {
  const api = windowsApi();
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!api || !tab || !isDetachedWindow()) return false;
  if (!(await releaseTab(tab, 'to the main window'))) return false;
  let ok = false;
  try {
    ok = await api.reattachTabs([serializeTab(tab)]);
  } catch (e) {
    toast('error', 'Could not move the tab back', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!ok) {
    toast('warning', 'The main window is not open', 'Open Rowlit again, then move the tab back.');
    return false;
  }
  useTabs.getState().take(tabId);
  await cleanupAfterMove(tab);
  afterTabLeft();
  return true;
}

/** A detached window without tabs has nothing to show: it closes. */
function afterTabLeft(): void {
  if (!isDetachedWindow()) return;
  if (useTabs.getState().tabs.length === 0) windowsApi()?.closeDetachedWindow();
}

// ---------- main window ----------

let mainWired = false;

/**
 * Main window: tabs of detached windows (kept in the workspace, so they come back here after a restart) and tabs
 * coming back. Returns the tabs open in other windows right now (a reloaded main window must not restore them).
 */
export async function liveDetachedTabs(): Promise<Tab[]> {
  const api = windowsApi();
  if (!api || isDetachedWindow()) return [];
  try {
    const list = await api.listDetachedTabs();
    return Array.isArray(list) ? list.filter(isRestorableTab) : [];
  } catch {
    return [];
  }
}

export function wireMainWindowTabs(): void {
  const api = windowsApi();
  if (!api || isDetachedWindow() || mainWired) return;
  mainWired = true;
  api.onDetachedTabs((tabs) => useTabs.getState().setDetached(Array.isArray(tabs) ? tabs.filter(isRestorableTab) : []));
  api.onTabsReattached((e) => {
    const tabs = Array.isArray(e?.tabs) ? e.tabs.filter(isRestorableTab) : [];
    if (!tabs.length) return;
    if (!e.closed) {
      useTabs.getState().adopt(tabs);
      return;
    }
    // The user closed a detached window: its tabs are kept as recently closed, like a closed tab.
    useTabs.getState().addClosed(tabs);
    const s = useTabs.getState();
    s.setDetached(s.detached.filter((t) => !tabs.some((x) => x.id === t.id)));
    toast('info', `Closed a window with ${pluralize(tabs.length, 'tab')}`, tabs.map((t) => t.title).join(', '), {
      label: 'Reopen',
      run: () => {
        const closed = useTabs.getState().closed;
        const back = closed.filter((t) => tabs.some((x) => x.id === t.id));
        useTabs.setState({ closed: closed.filter((t) => !back.includes(t)) });
        useTabs.getState().adopt(back);
      },
    });
  });
}

// ---------- detached window ----------

let reportTimer: ReturnType<typeof setTimeout> | null = null;

/** Detached window: shows the tabs main handed over and reports every change back (debounced). */
export async function bootDetachedTabs(): Promise<void> {
  const api = windowsApi();
  if (!api) return;
  let tabs: Tab[] = [];
  try {
    const list = await api.getDetachedTabs();
    tabs = Array.isArray(list) ? list.filter(isRestorableTab) : [];
  } catch (e) {
    console.warn('[windows] could not load the detached tabs', e);
  }
  useTabs.getState().restore({ version: 1, tabs, activeId: tabs[0]?.id ?? null, seq: 0 });
  const report = () => {
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = null;
    api.reportDetachedTabs(useTabs.getState().tabs.map(serializeTab));
  };
  useTabs.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(report, 500);
  });
  window.addEventListener('beforeunload', report);
}

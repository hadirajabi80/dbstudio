// Keyboard region navigation (design-07 / design-p1): Alt+1 explorer, Alt+2 editor, Alt+3 results, F6 / Shift+F6
// cycle dock → editor → results → status bar. Regions are marked with `data-region` in the DOM.
import { getEditor } from '../../app/editors';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { focusFirst } from '../common/focus';
import { useExplorer } from '../Explorer/explorerStore';
import { focusTabPrimary, tabContainer } from './ViewTabHost';

export type Region = 'dock' | 'editor' | 'results' | 'status';
export const REGIONS: readonly Region[] = ['dock', 'editor', 'results', 'status'];

const RESULTS_FOCUS = ['[data-testid="data-grid-canvas"]', '[role="tablist"] [aria-selected="true"]', '.messages-list [tabindex="0"]', '[tabindex="0"]', 'button:not([disabled])'];
const DOCK_FOCUS = ['[role="tree"]', '.history-filters input', '.dock-body input', '.dock-body [tabindex="0"]', '[role="tab"][aria-selected="true"]'];

/** Briefly outline the region that received focus (F6 should show where focus went). */
function flash(el: Element | null): void {
  const box = el?.closest('[data-region]') ?? el;
  if (!(box instanceof HTMLElement)) return;
  box.classList.add('region-flash');
  setTimeout(() => box.classList.remove('region-flash'), 900);
}

function activeConsoleEl(): HTMLElement | null {
  const id = useTabs.getState().activeId;
  const el = id ? tabContainer(id) : null;
  return el?.classList.contains('console') ? el : null;
}

/** The region that currently holds focus, if any. */
export function currentRegion(): Region | null {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  const r = a instanceof Element ? a.closest<HTMLElement>('[data-region]')?.dataset.region : undefined;
  if (r && (REGIONS as readonly string[]).includes(r)) return r as Region;
  // A non-console tab's content counts as the "editor" region.
  if (a instanceof Element && a.closest('.workspace-body')) return 'editor';
  return null;
}

export function focusExplorer(): boolean {
  useUi.getState().showDock('explorer');
  useExplorer.getState().focusTree();
  setTimeout(() => flash(document.querySelector('[data-region="dock"]')), 0);
  return true;
}

export function focusEditorRegion(): boolean {
  const s = useTabs.getState();
  const tab = s.tabs.find((t) => t.id === s.activeId);
  if (!tab) return focusFirst(document, ['.welcome button:not([disabled])']);
  const ok = tab.kind === 'console' ? (getEditor(tab.id)?.focus(), !!getEditor(tab.id)) : focusTabPrimary(tab);
  if (ok) flash(tab.kind === 'console' ? activeConsoleEl()?.querySelector('[data-region="editor"]') ?? null : tabContainer(tab.id));
  return ok;
}

/** Focus the results of the active console (opening the pane when it is hidden). */
export function focusResults(): boolean {
  const el = activeConsoleEl();
  if (!el) return false;
  const go = () => {
    const host = activeConsoleEl()?.querySelector<HTMLElement>('[data-region="results"]');
    if (host && focusFirst(host, RESULTS_FOCUS)) flash(host);
  };
  if (!useUi.getState().resultsVisible) {
    useUi.getState().toggle('resultsVisible');
    setTimeout(go, 30);
  } else go();
  return true;
}

function focusDock(): boolean {
  if (!useUi.getState().explorerVisible) useUi.getState().showDock(useUi.getState().dock);
  const go = () => {
    const dock = document.querySelector<HTMLElement>('[data-region="dock"]');
    if (dock && focusFirst(dock, DOCK_FOCUS)) flash(dock);
  };
  if (document.querySelector('[data-region="dock"]')) go();
  else setTimeout(go, 30);
  return true;
}

function focusStatus(): boolean {
  const bar = document.querySelector<HTMLElement>('[data-region="status"]');
  const ok = focusFirst(bar, ['button:not([disabled])']);
  if (ok) flash(bar);
  return ok;
}

/** Regions that exist right now (results only for a console with results). */
function available(): Region[] {
  const out: Region[] = [];
  out.push('dock');
  out.push('editor');
  if (activeConsoleEl()) out.push('results');
  out.push('status');
  return out;
}

/** F6 (1) / Shift+F6 (-1): move to the next/previous region. */
export function cycleRegion(step: 1 | -1): void {
  const list = available();
  const cur = currentRegion();
  let i = cur ? list.indexOf(cur) : -1;
  if (i < 0) i = step === 1 ? -1 : 0;
  for (let k = 1; k <= list.length; k++) {
    const r = list[(i + step * k + list.length * 2) % list.length];
    const ok = r === 'dock' ? focusDock() : r === 'editor' ? focusEditorRegion() : r === 'results' ? focusResults() : focusStatus();
    if (ok) return;
  }
}
